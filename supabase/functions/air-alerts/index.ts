/**
 * air-alerts - server-side notification generation + automatic SMS (iProgSMS).
 *
 * Triggers (no dashboard required):
 *  - DB webhook/trigger on INSERT into public.readings -> create/resolve alerts + auto SMS
 *  - { action: "resend", notification_id } -> resend auto SMS for an open alert
 *  - { action: "check_offline" } -> offline/online sweep (cron/schedule) + credit monitoring
 *  - { action: "backfill", device_id? } -> create/send for current active danger from latest reading
 *
 * SMS policy (see _shared/sms_policy.ts):
 *  - Channel priority: danger -> SMS + email; offline -> one SMS per outage per
 *    device then email-only reminders; warning -> email/dashboard unless
 *    sms_for_warnings is enabled.
 *  - Cooldown: one SMS when an alert opens, then at most one reminder every
 *    SMS_REMINDER_INTERVAL_MS (30 min). Never repeat SMS for an open, already
 *    notified alert.
 *  - Low credits: drop lower-priority first, never drop danger before others;
 *    at zero credits drop everything but never retry-spam; fall back to email.
 *  - Brownout: >= 3 active devices offline within 60s -> one SMS instead of N.
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import {
  evaluateSensor,
  HYSTERESIS_DEGREES_C,
  HYSTERESIS_HUMIDITY_PCT,
  isSensorFaultReading,
  newActionToken,
  type SensorType,
  type Thresholds,
} from "../_shared/air_alerts.ts";
import { buildOfflineMessage, manilaTime } from "../_shared/sms_templates.ts";
import { getSmsConfig, getSmsCredits, sendSms } from "../_shared/sms-provider.ts";
import { getSmsRecipients, isValidPhMobile, normalizePhSmsNumber } from "../_shared/sms_recipients.ts";
import { OFFLINE_AFTER_MINUTES, DEFAULT_OFFLINE_AFTER_S } from "../_shared/offline_config.ts";
import {
  SMS_REMINDER_INTERVAL_MS,
  SMS_FOR_WARNINGS_DEFAULT,
  SMS_FOR_COOL_HUMIDITY_DEFAULT,
  SMS_OFFLINE_MIN_SILENCE_MS,
  LOW_CREDIT_THRESHOLD_DEFAULT,
  BROWNOUT_MIN_DEVICES,
  BROWNOUT_WINDOW_MS,
  CREDIT_STALE_MS,
  alertChannel,
  channelFor,
  creditVerdict,
  isCreditError,
  sanitizeProviderResponse,
  sendResendEmail,
  adminEmails,
  creditEmailHtml,
  type AlertChannel,
} from "../_shared/sms_policy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Admin = ReturnType<typeof createClient>;

const SEV_RANK: Record<string, number> = { info: 0, warning: 1, high: 2, danger: 3, critical: 4 };

function sevAtLeast(current: string, min: string): boolean {
  return (SEV_RANK[current] ?? 0) >= (SEV_RANK[min] ?? 0);
}

function isDangerLevel(severity: string, levelLabel: string): boolean {
  return severity === "danger" || severity === "critical" || /critical|danger/i.test(levelLabel);
}

type DbFailure = { query: string; error: string; details?: unknown };

async function logDbFailure(admin: Admin, query: string, error: any, details?: unknown): Promise<void> {
  const msg = error?.message ?? (typeof error === "string" ? error : JSON.stringify(error));
  const full = `[air-alerts] DB query failed: ${query} :: ${msg}`;
  console.error(full, details ?? error ?? "");
  try {
    await insertSmsLog(admin, {
      message: full.slice(0, 160),
      status: "failed",
      provider: getSmsConfig().provider,
      provider_response: `${query} :: ${msg}`.slice(0, 1000),
      is_auto: true,
    });
  } catch (logErr) {
    console.error("[air-alerts] additionally failed to write sms_logs for DB failure:", logErr, { query, msg });
  }
}

/** Log the full Supabase error object (code, message, details, hint) and persist it to sms_logs. */
async function logSupabaseError(admin: Admin, context: string, error: any): Promise<void> {
  const payload = {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
  };
  console.error(`[air-alerts] ${context}`, payload);
  try {
    await insertSmsLog(admin, {
      message: `[air-alerts] ${context} :: ${error?.message ?? String(error)}`.slice(0, 160),
      status: "failed",
      provider: getSmsConfig().provider,
      provider_response: JSON.stringify(payload).slice(0, 1000),
      is_auto: true,
    });
  } catch { /* best effort */ }
}

async function loadSmsSettings(
  admin: Admin,
): Promise<{
  automatic: boolean;
  minSeverity: string;
  reminderMinutes: number;
  closeAfterMinutes: number;
  maxSmsPerHour: number;
  maxSmsPerDay: number;
  lowCreditThreshold: number;
  smsForWarnings: boolean;
  smsReminderMinutes: number;
  lastCreditBalance: number | null;
  lastCreditCheckAt: string | null;
  lowCreditWarningEmailSentAt: string | null;
  emptyCreditEmailSentAt: string | null;
  autoSmsEnabled: boolean;
  autoSmsPausedUntil: string | null;
  alwaysSendDanger: boolean;
  autoSmsCo2: boolean;
  autoSmsLpg: boolean;
  autoSmsTemp: boolean;
  autoSmsHumidity: boolean;
  autoSmsOffline: boolean;
  error?: DbFailure;
}> {
  const query = `select automatic_sms, min_severity, reminder_minutes, close_after_minutes, max_sms_per_hour, max_sms_per_day, low_credit_threshold, sms_for_warnings, sms_reminder_minutes, last_credit_balance, last_credit_check_at, low_credit_warning_email_sent_at, empty_credit_email_sent_at, auto_sms_enabled, auto_sms_paused_until, always_send_danger, auto_sms_co2, auto_sms_lpg, auto_sms_temp, auto_sms_humidity, auto_sms_offline from public.sms_alert_settings where id=1`;
  try {
    const { data, error } = await admin
      .from("sms_alert_settings")
      .select("automatic_sms, min_severity, reminder_minutes, close_after_minutes, max_sms_per_hour, max_sms_per_day, low_credit_threshold, sms_for_warnings, sms_reminder_minutes, last_credit_balance, last_credit_check_at, low_credit_warning_email_sent_at, empty_credit_email_sent_at, auto_sms_enabled, auto_sms_paused_until, always_send_danger, auto_sms_co2, auto_sms_lpg, auto_sms_temp, auto_sms_humidity, auto_sms_offline")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      await logDbFailure(admin, query, error);
      return defaults(error, { query, error: error.message ?? String(error), details: error });
    }
    if (data) {
      return {
        automatic: data.automatic_sms !== false,
        minSeverity: String(data.min_severity ?? "warning"),
        reminderMinutes: Number(data.reminder_minutes ?? 60),
        closeAfterMinutes: Number(data.close_after_minutes ?? 10),
        maxSmsPerHour: Number(data.max_sms_per_hour ?? 5),
        maxSmsPerDay: Number(data.max_sms_per_day ?? 20),
        lowCreditThreshold: Number(data.low_credit_threshold ?? LOW_CREDIT_THRESHOLD_DEFAULT),
        smsForWarnings: Boolean(data.sms_for_warnings ?? SMS_FOR_WARNINGS_DEFAULT),
        smsReminderMinutes: Number(data.sms_reminder_minutes ?? SMS_REMINDER_INTERVAL_MS / 60000),
        lastCreditBalance: data.last_credit_balance == null ? null : Number(data.last_credit_balance),
        lastCreditCheckAt: data.last_credit_check_at ?? null,
        lowCreditWarningEmailSentAt: data.low_credit_warning_email_sent_at ?? null,
        emptyCreditEmailSentAt: data.empty_credit_email_sent_at ?? null,
        autoSmsEnabled: data.auto_sms_enabled ?? true,
        autoSmsPausedUntil: data.auto_sms_paused_until ?? null,
        alwaysSendDanger: data.always_send_danger ?? true,
        autoSmsCo2: data.auto_sms_co2 ?? true,
        autoSmsLpg: data.auto_sms_lpg ?? true,
        autoSmsTemp: data.auto_sms_temp ?? true,
        autoSmsHumidity: data.auto_sms_humidity ?? true,
        autoSmsOffline: data.auto_sms_offline ?? true,
      };
    }
  } catch (e) {
    await logDbFailure(admin, query, e);
    return defaults(e, { query, error: e instanceof Error ? e.message : String(e), details: e });
  }
  return defaults(null, { autoSmsEnabled: true, autoSmsPausedUntil: null, alwaysSendDanger: true, autoSmsCo2: true, autoSmsLpg: true, autoSmsTemp: true, autoSmsHumidity: true, autoSmsOffline: true });

  function defaults(err: unknown, override: Partial<{
    automatic: boolean; minSeverity: string; reminderMinutes: number; closeAfterMinutes: number;
    maxSmsPerHour: number; maxSmsPerDay: number; lowCreditThreshold: number; smsForWarnings: boolean;
    smsReminderMinutes: number; lastCreditBalance: number | null; lastCreditCheckAt: string | null;
    lowCreditWarningEmailSentAt: string | null; emptyCreditEmailSentAt: string | null; error?: DbFailure;
  }>): ReturnType<typeof loadSmsSettings> {
    return {
      automatic: true,
      minSeverity: "warning",
      reminderMinutes: 60,
      closeAfterMinutes: 10,
      maxSmsPerHour: 5,
      maxSmsPerDay: 20,
      lowCreditThreshold: LOW_CREDIT_THRESHOLD_DEFAULT,
      smsForWarnings: SMS_FOR_WARNINGS_DEFAULT,
      smsReminderMinutes: Math.round(SMS_REMINDER_INTERVAL_MS / 60000),
      lastCreditBalance: null,
      lastCreditCheckAt: null,
      lowCreditWarningEmailSentAt: null,
      emptyCreditEmailSentAt: null,
      ...override,
    };
  }
}

async function resolveThresholds(admin: Admin): Promise<Thresholds | null> {
  const query = `rpc public.resolve_thresholds(p_at => null)`;
  const { data, error } = await admin.rpc("resolve_thresholds", { p_at: null });
  if (error) {
    await logDbFailure(admin, query, error);
    return null;
  }
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const n = (k: string, fb: number) => {
    const v = Number(r[k]);
    return Number.isFinite(v) ? v : fb;
  };
  return {
    co2: { warning: n("co2_warning", 1000), high: n("co2_high", 2000), danger: n("co2_danger", 3500) },
    lpg: { warning: n("lpg_warning", 1000), high: n("lpg_high", 2100), danger: n("lpg_danger", 4200) },
    temp: { freezeBelow: n("temp_freeze_below", 5), coolBelow: n("temp_cool_below", 18), heatAbove: n("temp_heat_above", 35) },
    humidity: { dryBelow: n("humidity_dry_below", 20), lowBelow: n("humidity_low_below", 30), moldAbove: n("humidity_mold_above", 80) },
  };
}

function fmtReading(sensor: SensorType, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  if (sensor === "temp") return `${value.toFixed(1)} °C`;
  if (sensor === "humidity") return `${Math.round(value)} %RH`;
  return `${Math.round(value)} ppm`;
}

function saturationNote(sensor: SensorType, value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (sensor === "co2" && value >= 5000) return "At sensor max (5000 ppm) - possible saturation/bad value";
  if (sensor === "lpg" && value >= 10000) return "At sensor max (10000 ppm) - possible saturation/bad value";
  return null;
}

function buildAlertSms(severity: string, levelLabel: string, room: string, floor: string, sensorLabel: string, reading: string, time: string): string {
  const sev = String(levelLabel || severity || "ALERT").toUpperCase();
  const loc = floor ? `${room} - ${floor}` : room;
  return `[${sev}] ${loc}: ${sensorLabel} ${reading} at ${time}. Please respond.`.slice(0, 160);
}

async function insertSmsLog(
  admin: Admin,
  row: {
    notification_id?: number | null;
    personnel_id?: string | null;
    recipient_name?: string;
    recipient_role?: string;
    phone?: string | null;
    message: string;
    status: string;
    provider_response?: string | null;
    provider?: string | null;
    provider_message_id?: string | null;
    provider_status?: string | null;
    send_mode?: "auto" | "manual";
    is_auto?: boolean;
  },
) {
  const payload: any = {
    notification_id: row.notification_id ?? null,
    personnel_id: row.personnel_id ?? null,
    recipient_name: row.recipient_name ?? "",
    recipient_role: row.recipient_role ?? "",
    phone: row.phone ?? null,
    message: row.message,
    status: row.status,
    provider_response: row.provider_response ?? null,
    provider: row.provider ?? null,
    provider_message_id: row.provider_message_id ?? null,
    provider_status: row.provider_status ?? row.status,
    send_mode: row.send_mode ?? (row.is_auto ? "auto" : "manual"),
    is_auto: row.is_auto ?? (row.send_mode === "auto"),
  };
  const { error } = await admin.from("sms_logs").insert(payload);
  if (error) {
    const fallback = { ...payload };
    delete fallback.send_mode;
    delete fallback.is_auto;
    const { error: fallbackErr } = await admin.from("sms_logs").insert(fallback);
    if (fallbackErr) {
      console.error(`[air-alerts] sms_logs insert failed; fallback failed ::`, { payload, error, fallbackErr });
    } else {
      console.error(`[air-alerts] sms_logs insert degraded (dropped send_mode/is_auto) ::`, { error });
    }
  }
}

async function upsertNotification(
  admin: Admin,
  params: {
    device_id: string; room_name: string; floor: string; sensor_type: SensorType;
    level_label: string; severity: string; reading_value: number | null;
    reading_unit: string; message: string;
  },
): Promise<{ id: number; created: boolean; escalated: boolean; previousLevel?: string } | null> {
  const { data: existing, error: existingErr } = await admin
    .from("air_notifications")
    .select("id, level_label, severity, status")
    .eq("device_id", params.device_id)
    .eq("sensor_type", params.sensor_type)
    .eq("status", "open")
    .maybeSingle();
  if (existingErr) {
    await logDbFailure(admin, "upsertNotification existing", existingErr);
    return null;
  }

  if (existing) {
    if (existing.level_label === params.level_label && existing.severity === params.severity) {
      const { error: updErr } = await admin.from("air_notifications")
        .update({ reading_value: params.reading_value, message: params.message })
        .eq("id", existing.id);
      if (updErr) await logDbFailure(admin, "upsertNotification same-level update", updErr);
      return { id: existing.id, created: false, escalated: false, previousLevel: existing.level_label };
    }
    const escalated = (SEV_RANK[params.severity] ?? 0) > (SEV_RANK[existing.severity] ?? 0);
    const { error: resolveErr } = await admin.from("air_notifications")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolution_note: escalated ? `Escalated to ${params.level_label}` : `Changed to ${params.level_label}`,
      })
      .eq("id", existing.id);
    if (resolveErr) {
      await logDbFailure(admin, "upsertNotification resolve", resolveErr);
      return null;
    }
    const { data, error: insErr } = await admin.from("air_notifications").insert({
      ...params,
      escalation_of: existing.id,
      status: "open",
    }).select("id").single();
    if (insErr || !data) {
      await logDbFailure(admin, "upsertNotification insert", insErr ?? "no row returned");
      return null;
    }
    return { id: data.id, created: true, escalated, previousLevel: existing.level_label };
  }

  const { data, error } = await admin.from("air_notifications").insert({
    ...params,
    status: "open",
  }).select("id").single();
  if (error || !data) {
    await logDbFailure(admin, "upsertNotification insert", error ?? "no row returned");
    return null;
  }
  return { id: data.id, created: true, escalated: false };
}

async function resolveSensor(admin: Admin, deviceId: string, sensor: SensorType, note = "Reading returned to safe range") {
  const { error } = await admin.from("air_notifications")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: note })
    .eq("device_id", deviceId)
    .eq("sensor_type", sensor)
    .eq("status", "open");
  if (error) await logDbFailure(admin, `resolveSensor ${deviceId}/${sensor}`, error);
}

/** Most recent SMS attempt (any status) for a notification, plus whether any was submitted. */
async function lastSmsAttemptForNotification(admin: Admin, notificationId: number): Promise<{ sentAt: string | null; submitted: boolean }> {
  const { data, error } = await admin
    .from("sms_logs")
    .select("sent_at,status")
    .eq("notification_id", notificationId)
    .order("sent_at", { ascending: false })
    .limit(1);
  if (error) {
    await logDbFailure(admin, `lastSmsAttemptForNotification ${notificationId}`, error);
    return { sentAt: null, submitted: false };
  }
  const row = (data as any[])?.[0];
  if (!row) return { sentAt: null, submitted: false };
  return { sentAt: row.sent_at ?? null, submitted: row.status === "submitted" };
}

/** Send a targeted fallback email to admins when SMS is skipped for credit reasons. */
async function sendFallbackEmail(admin: Admin, notification: any, reason: string): Promise<void> {
  try {
    const to = await adminEmails(admin);
    if (to.length === 0) return;
    const html = `
    <h2>A.I.R. Alert - SMS skipped (${reason})</h2>
    <p><b>${notification.level_label}</b> at ${notification.room_name}${notification.floor ? ` (${notification.floor})` : ""} (device ${notification.device_id}).</p>
    <p>${notification.message}</p>
    <p>Detected ${manilaTime(notification.created_at)}. SMS was not sent because ${reason}; this alert is still open on the dashboard.</p>`;
    await sendResendEmail(
      to,
      `[A.I.R.] SMS skipped: ${notification.level_label} at ${notification.room_name}`,
      html,
    );
  } catch (e) {
    console.error(`[air-alerts] fallback email failed for notification ${notification.id}:`, e);
  }
}

/**
 * STEP 4 guard: decide whether an *automatic* SMS is allowed under the admin's
 * auto-SMS controls (master switch, pause window, per-sensor flags, danger
 * lock). Returns null to allow the send, or a reason + human-readable detail to
 * block it.
 *
 * Fails OPEN: a settings read error, an unknown sensor, or a missing column all
 * fall through to today's behaviour so a broken settings row can never silence
 * emergency texts. Explicit human actions (manual resend) bypass the guard.
 */
function autoSmsBlock(
  settings: Awaited<ReturnType<typeof loadSmsSettings>>,
  notification: { severity?: string | null; level_label?: string | null; sensor_type?: string | null },
  reason: string,
): { reason: string; detail: string } | null {
  // Manual resends are explicit human actions - never suppressed here.
  if (reason === "manual_resend_auto" || reason === "backfill") return null;

  // A failed settings read must not stop alerts; behave as if controls are on.
  if (settings.error) return null;

  const danger = isDangerLevel(String(notification.severity ?? ""), String(notification.level_label ?? ""));
  if (danger && settings.alwaysSendDanger) return null;

  if (!settings.autoSmsEnabled) {
    return { reason: "master_off", detail: "Master switch off" };
  }

  if (settings.autoSmsPausedUntil) {
    const until = new Date(settings.autoSmsPausedUntil);
    if (Number.isFinite(until.getTime()) && new Date() < until) {
      return { reason: "paused_until", detail: `Paused until ${manilaTime(until)}` };
    }
  }

  // Offline alerts are stored with sensor_type "device"; the per-sensor flag
  // for them is auto_sms_offline. Any unrecognised sensor is allowed.
  const raw = String(notification.sensor_type ?? "offline");
  const sensor = raw === "device" || raw === "offline" ? "offline" : raw;
  const flags: Record<string, boolean> = {
    co2: settings.autoSmsCo2,
    lpg: settings.autoSmsLpg,
    temp: settings.autoSmsTemp,
    humidity: settings.autoSmsHumidity,
    offline: settings.autoSmsOffline,
  };
  if (flags[sensor] === false) {
    const label = sensor === "offline" ? "device offline" : sensor;
    return { reason: "sensor_off", detail: `Sensor ${label} off` };
  }

  return null;
}

async function sendAutoSmsForAlert(
  admin: Admin,
  params: {
    notification: any;
    message: string;
    reason: "new_alert" | "escalation" | "cooldown_reminder" | "unacknowledged_reminder" | "offline" | "manual_resend_auto" | "backfill";
    channel?: AlertChannel;
    isReminder?: boolean;
  },
): Promise<{ attempted: boolean; reason: string | null; emailFallback: boolean }> {
  const n = params.notification;
  const channel = params.channel ?? alertChannel(n.severity, n.level_label);
  const settings = await loadSmsSettings(admin);
  const cfg = getSmsConfig();
  const reminderIntervalMs = settings.smsReminderMinutes > 0 ? settings.smsReminderMinutes * 60 * 1000 : SMS_REMINDER_INTERVAL_MS;
  if (!settings.automatic && params.reason !== "manual_resend_auto" && params.reason !== "backfill") {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_disabled",
      provider_response: "automatic_sms disabled", provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: "automatic_sms_disabled", emailFallback: false };
  }

  if (!sevAtLeast(n.severity, settings.minSeverity) && n.level_label !== "Offline") {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_disabled",
      provider_response: `Below min severity (${settings.minSeverity})`, provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: "below_min_severity", emailFallback: false };
  }

  if (n.status === "acknowledged" || n.status === "resolved") {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message,
      status: n.status === "acknowledged" ? "skipped_acknowledged" : "skipped_open_incident",
      provider_response: `Notification is ${n.status}`, provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: `notification_${n.status}`, emailFallback: false };
  }

  const decision = channelFor(channel, settings.smsForWarnings, n.level_label);

  // Offline alerts: one SMS per outage (open). Reminders are email-only.
  if (channel === "offline" && params.isReminder) {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_email_only",
      provider_response: "Offline reminder: email only", provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: "offline_email_only", emailFallback: true };
  }

  if (!decision.sms) {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_channel",
      provider_response: `SMS not routed for ${channel} (${decision.reason})`, provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: decision.reason, emailFallback: decision.email };
  }

  // Automatic SMS controls (STEP 4): honour the admin's on/off, pause and
  // per-sensor flags before any provider call. Blocked sends consume no
  // iProgSMS credits; the alert row/dashboard/email are unaffected.
  const blocked = autoSmsBlock(settings, n, params.reason);
  if (blocked) {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_auto_off",
      provider_response: blocked.detail, provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: blocked.reason, emailFallback: false };
  }

  // Cooldown: one SMS when an alert opens; reminders at most every interval.
  const { sentAt, submitted } = await lastSmsAttemptForNotification(admin, n.id);
  if (params.reason === "escalation") {
    // Escalation always sends.
  } else if (params.reason === "new_alert" || params.reason === "offline" || params.reason === "backfill") {
    if (submitted) {
      await insertSmsLog(admin, {
        notification_id: n.id, message: params.message, status: "skipped_already_notified",
        provider_response: "Alert already notified", provider: cfg.provider, is_auto: true,
      });
      return { attempted: false, reason: "already_notified", emailFallback: false };
    }
  } else {
    // reminder paths
    if (sentAt) {
      const elapsed = Date.now() - new Date(sentAt).getTime();
      if (elapsed < reminderIntervalMs) {
        await insertSmsLog(admin, {
          notification_id: n.id, message: params.message, status: "skipped_rate_limited",
          provider_response: `Cooldown active (${Math.ceil((reminderIntervalMs - elapsed) / 1000)}s remaining)`,
          provider: cfg.provider, is_auto: true,
        });
        return { attempted: false, reason: "cooldown", emailFallback: false };
      }
    } else {
      // No prior attempt: this is effectively the open send.
    }
  }

  // Credits.
  let credits: number | null = null;
  let authError: string | null = null;
  if (!cfg.dryRun) {
    try {
      const c = await getSmsCredits(true);
      credits = c.credits;
      authError = c.authError;
      if (c.authError) {
        console.error(`air-alerts: iProgSMS credits/auth check failed for alert ${n.id}: ${c.authError}`);
      }
    } catch (e) {
      console.error(`air-alerts: credits check error for alert ${n.id}:`, e instanceof Error ? e.message : String(e));
    }
  }

  const verdict = creditVerdict(credits, channel, settings.lowCreditThreshold);
  if (verdict.drop === "all") {
    const recipients = await getSmsRecipients(admin).catch(() => [] as any[]);
    for (const r of recipients) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "skipped_low_credits",
        provider_response: "SMS credits are 0", provider: cfg.provider, is_auto: true,
      });
    }
    console.log(`air-alerts: alert ${n.id} skipped, SMS credits 0`);
    return { attempted: false, reason: "credits_zero", emailFallback: true };
  }
  if (verdict.drop === "non_danger") {
    const recipients = await getSmsRecipients(admin).catch(() => [] as any[]);
    for (const r of recipients) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "skipped_low_credits",
        provider_response: `Credits below threshold (${credits ?? "?"} < ${settings.lowCreditThreshold})`,
        provider: cfg.provider, is_auto: true,
      });
    }
    console.log(`air-alerts: alert ${n.id} skipped, credits ${credits ?? "?"} below threshold ${settings.lowCreditThreshold}`);
    return { attempted: false, reason: "low_credits", emailFallback: true };
  }

  if (cfg.dryRun) {
    const recipients = await getSmsRecipients(admin).catch(() => [] as any[]);
    for (const r of recipients) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "skipped_dry_run",
        provider_response: "DRY_RUN enabled (no SMS sent)", provider: cfg.provider, is_auto: true,
      });
    }
    return { attempted: false, reason: "dry_run", emailFallback: false };
  }

  let recipients: any[];
  try {
    recipients = await getSmsRecipients(admin, null);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`air-alerts: recipient lookup failed for alert ${n.id}: ${errMsg}`, e);
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "failed",
      provider_response: `Recipient lookup failed: ${errMsg}`.slice(0, 1000),
      provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: "db_error_recipients", emailFallback: false };
  }
  if (recipients.length === 0) {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_no_recipients",
      provider_response: "No active approved personnel with sms_enabled=true and valid PH mobile (09XXXXXXXXX)",
      provider: cfg.provider, is_auto: true,
    });
    console.log(`air-alerts: alert ${n.id} no eligible SMS recipients`);
    return { attempted: false, reason: "no_recipients", emailFallback: false };
  }

  let attempted = false;
  let creditsExhausted = false;

  for (const r of recipients) {
    if (creditsExhausted) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "skipped_low_credits",
        provider_response: "Credits exhausted during batch", provider: cfg.provider, is_auto: true,
      });
      continue;
    }
    const rawPhone = String(r.contact_number ?? "").replace(/[\s()-]/g, "");
    if (/^\+?639\d{9}$/.test(rawPhone)) r.contact_number = "0" + rawPhone.replace(/^\+?63/, "");
    if (!isValidPhMobile(r.contact_number) || !normalizePhSmsNumber(r.contact_number)) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "invalid_number",
        provider_response: "Invalid PH mobile number (must be 11 digits starting with 09)",
        provider: cfg.provider, is_auto: true,
      });
      continue;
    }

    attempted = true;
    const token = newActionToken();
    try {
      await admin.from("notification_recipients").upsert({
        notification_id: n.id,
        personnel_id: r.id,
        personnel_name: r.name ?? "",
        personnel_role: r.role ?? "",
        phone: r.contact_number,
        action_token: token,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      }, { onConflict: "notification_id,personnel_id" });
    } catch { /* best effort */ }

    console.log(`air-alerts: sending auto SMS for alert ${n.id} to ${r.name} (${r.role}) ${r.contact_number.slice(-4).padStart(r.contact_number.length, "*")}`);
    const res = await sendSms({ to: r.contact_number, message: params.message }, true);
    const rawText = typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw ?? {});
    const providerResponse = sanitizeProviderResponse(res.error ?? rawText, cfg.iprog.token);
    console.log(`air-alerts: SMS result alert=${n.id} recipient=${r.id} ok=${res.ok} status=${res.status} provider=${res.provider} msgId=${res.providerMessageId ?? "none"} response=${String(providerResponse).slice(0, 300)}`);

    if (isCreditError(res.error)) {
      creditsExhausted = true;
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "failed",
        provider_response: sanitizeProviderResponse(`Credit failure: ${providerResponse}`, cfg.iprog.token).slice(0, 1000),
        provider: res.provider ?? cfg.provider, provider_message_id: res.providerMessageId ?? null,
        provider_status: res.status ?? "failed", is_auto: true,
      });
      continue;
    }

    await insertSmsLog(admin, {
      notification_id: n.id,
      personnel_id: r.id,
      recipient_name: r.name,
      recipient_role: r.role,
      phone: r.contact_number,
      message: params.message,
      status: res.ok ? "submitted" : "failed",
      provider_response: providerResponse,
      provider: res.provider ?? cfg.provider,
      provider_message_id: res.providerMessageId ?? null,
      provider_status: res.status ?? (res.ok ? "submitted" : "failed"),
      is_auto: true,
    });
  }

  if (attempted) {
    try {
      await admin.from("air_notifications").update({ escalated_at: new Date().toISOString() }).eq("id", n.id);
    } catch { /* column may not exist in older schema */ }
  }

  const emailFallback = !attempted && creditsExhausted;
  return { attempted, reason: attempted ? null : "no_valid_recipients", emailFallback };
}

async function handleReading(admin: Admin, record: any) {
  const th = await resolveThresholds(admin);
  if (!th) return json({ error: "No thresholds (resolve_thresholds failed or returned null). Check function logs for failing query." }, 500);

  const device_id = String(record.device_id ?? "");
  if (!device_id) return json({ error: "Missing device_id" }, 400);

  // Removed devices cannot submit accepted readings or create new alerts.
  // Check BOTH devices.active/devices.removed_at AND rooms.active/rooms.removed_at.
  const { data: deviceRow, error: deviceErr } = await admin
    .from("devices")
    .select("active, removed_at")
    .eq("device_id", device_id)
    .maybeSingle();
  if (deviceErr) await logDbFailure(admin, "check device active before alert", deviceErr);
  if (deviceRow?.active === false || deviceRow?.removed_at != null) {
    return json({ status: "skipped", reason: "device_removed", device_id }, 200);
  }

  const { data: roomRow, error: roomErr } = await admin
    .from("rooms")
    .select("name, floor, active, removed_at")
    .eq("id", device_id)
    .maybeSingle();
  if (roomErr) await logDbFailure(admin, "check room active before alert", roomErr);
  if (!roomRow || roomRow.active === false || roomRow.removed_at != null) {
    return json({ status: "skipped", reason: "device_removed", device_id }, 200);
  }

  const created_at = record.created_at ? String(record.created_at) : new Date().toISOString();
  const room_name = roomRow.name ?? device_id;
  const floor = roomRow.floor ?? "";

  const readingAgeMs = Date.now() - new Date(created_at).getTime();
  const stale = Number.isFinite(readingAgeMs) && readingAgeMs > DEFAULT_OFFLINE_AFTER_S * 1000;

  const values = {
    co2: record.co2 == null ? null : Number(record.co2),
    lpg: record.lpg == null ? null : Number(record.lpg),
    temp: record.temp == null ? null : Number(record.temp),
    humidity: record.humidity == null ? null : Number(record.humidity),
  };
  const allZero = [values.co2, values.lpg, values.temp, values.humidity].every((v) => v === 0);

  const sensors: { key: SensorType; label: string; unit: string; value: number | null }[] = [
    { key: "co2", label: "CO2", unit: "ppm", value: values.co2 },
    { key: "lpg", label: "LPG", unit: "ppm", value: values.lpg },
    { key: "temp", label: "Temperature", unit: "°C", value: values.temp },
    { key: "humidity", label: "Humidity", unit: "%RH", value: values.humidity },
  ];

  const triggered: any[] = [];
  const escalated: any[] = [];
  const faults: string[] = [];
  const saturation: string[] = [];

  // Load open alerts for this device so evaluateSensor can apply hysteresis
  // (a warning alert stays active until the reading clears the threshold by
  // the hysteresis margin).
  const { data: openAlerts, error: openAlertsErr } = await admin.from("air_notifications")
    .select("id, sensor_type, level_label, severity, status")
    .eq("device_id", device_id)
    .eq("status", "open");
  const openAlertBySensor = new Map<string, boolean>();
  if (!openAlertsErr) {
    for (const a of (openAlerts as any[]) ?? []) {
      openAlertBySensor.set(a.sensor_type, true);
    }
  } else {
    await logDbFailure(admin, "load open alerts for hysteresis", openAlertsErr);
  }

  for (const s of sensors) {
    if (stale) continue;
    const faulty = isSensorFaultReading(s.key, s.value, values.humidity, allZero);
    if (faulty) {
      faults.push(`${s.label}=${s.value ?? "null"}`);
      await resolveSensor(admin, device_id, s.key, "Sensor fault / invalid reading");
      continue;
    }

    const sat = saturationNote(s.key, s.value);
    if (sat) {
      saturation.push(`${room_name} ${s.label} ${s.value}: ${sat}`);
      console.warn(`air-alerts: ${device_id} ${sat}`);
    }

    const alreadyActive = openAlertBySensor.has(s.key);
    const ev = evaluateSensor(s.key as any, s.value, th, alreadyActive);
    if (!ev) {
      await resolveSensor(admin, device_id, s.key, "Reading returned to safe range");
      continue;
    }

    const msg = buildAlertSms(ev.severity, ev.level_label, room_name, floor, s.label, fmtReading(s.key, ev.reading_value), manilaTime());
    const up = await upsertNotification(admin, {
      device_id,
      room_name,
      floor,
      sensor_type: s.key,
      level_label: ev.level_label,
      severity: ev.severity,
      reading_value: ev.reading_value,
      reading_unit: ev.reading_unit,
      message: msg,
    });
    if (!up) continue;

    const { data: notif } = await admin.from("air_notifications").select("*").eq("id", up.id).maybeSingle();
    if (!notif) continue;

    const channel = alertChannel(notif.severity, notif.level_label);
    const isReminder = !up.created;

    // One SMS per alert: on newly created/escalated alert, or if open and never
    // sent / reminder interval passed (backfill-safe).
    if (up.created || up.escalated) {
      triggered.push({ notif, up, reason: up.escalated ? "escalation" : "new_alert", channel, isReminder: false });
      if (up.escalated) escalated.push(notif);
    } else if (notif.status === "open") {
      triggered.push({ notif, up, reason: "unacknowledged_reminder", channel, isReminder: true });
    }
  }

  if (faults.length > 0) {
    await insertSmsLog(admin, {
      notification_id: null,
      message: `Sensor fault detected for ${room_name} (${device_id}): ${faults.join(", ")}`,
      status: "skipped_quality",
      provider_response: allZero ? "All sensor values zero / likely sensor fault" : "Invalid reading (NaN/negative/out of range/fault)",
      provider: getSmsConfig().provider,
      is_auto: true,
    });
  }
  if (saturation.length > 0) {
    await insertSmsLog(admin, {
      notification_id: null,
      message: `Sensor saturation notice: ${saturation.join("; ")}`.slice(0, 160),
      status: "skipped_quality",
      provider_response: "At sensor max - still treated as danger; verify sensor/calibration",
      provider: getSmsConfig().provider,
      is_auto: true,
    });
  }

  // Device came online with a fresh reading: resolve offline alert(s).
  // Do NOT send an all-clear SMS — record on dashboard and email only.
  if (!stale) {
    const { data: openOffline, error: openOfflineErr } = await admin.from("air_notifications")
      .select("id")
      .eq("device_id", device_id)
      .eq("level_label", "Offline")
      .eq("status", "open");
    if (openOfflineErr) {
      await logDbFailure(admin, "open offline query", openOfflineErr);
    } else if (openOffline && openOffline.length > 0) {
      const { error: resolveOfflineErr } = await admin.from("air_notifications")
        .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Device back online" })
        .eq("device_id", device_id)
        .eq("level_label", "Offline")
        .eq("status", "open");
      if (resolveOfflineErr) await logDbFailure(admin, "resolve offline", resolveOfflineErr);
    }
  }

  // Send automatic SMS for triggered alerts (one per alert, de-duped above).
  for (const t of triggered) {
    const msg = t.notif.message || buildAlertSms(t.notif.severity, t.notif.level_label, room_name, floor, String(t.notif.sensor_type).toUpperCase(), fmtReading(t.notif.sensor_type, t.notif.reading_value), manilaTime());
    const result = await sendAutoSmsForAlert(admin, {
      notification: t.notif,
      message: msg,
      reason: t.reason,
      channel: t.channel,
      isReminder: t.isReminder,
    });
    if (!result.attempted && result.emailFallback) {
      await sendFallbackEmail(admin, t.notif, result.reason ?? "credits");
    }
  }

  console.log(`air-alerts processed device=${device_id} room=${room_name} triggered=${triggered.length} escalated=${escalated.length} faults=${faults.length} saturation=${saturation.length} stale=${stale}`);
  return json({ status: "processed", device_id, room_name, triggered: triggered.length, faults: faults.length, saturation, escalated: escalated.length, stale });
}

async function checkOffline(admin: Admin) {
  const nowMs = Date.now();

  // Credit monitoring: check iProgSMS balance at most once per day.
  const settings = await loadSmsSettings(admin);
  const creditStale = !settings.lastCreditCheckAt ||
    Date.now() - new Date(settings.lastCreditCheckAt).getTime() > CREDIT_STALE_MS;
  let currentCredits: number | null = settings.lastCreditBalance;
  if (creditStale) {
    try {
      const c = await getSmsCredits(true);
      currentCredits = c.credits;
      if (c.authError) {
        console.error(`check-offline: iProgSMS credit check failed: ${c.authError}`);
      }
      // Snapshot the balance.
      if (currentCredits != null) {
        await admin.from("sms_credit_snapshots").insert({
          balance: currentCredits,
          source: "iprog",
          note: c.authError ? `auth_error:${c.authError}` : null,
        });
      }
      const patch: any = { last_credit_balance: currentCredits, last_credit_check_at: new Date().toISOString() };
      const thr = settings.lowCreditThreshold > 0 ? settings.lowCreditThreshold : LOW_CREDIT_THRESHOLD_DEFAULT;
      const belowThreshold = currentCredits != null && currentCredits < thr;
      const empty = currentCredits === 0;

      if (empty) {
        patch.empty_credit_email_sent_at = settings.emptyCreditEmailSentAt ?? new Date().toISOString();
        patch.low_credit_warning_email_sent_at = null; // recovered past warning into empty
        if (!settings.emptyCreditEmailSentAt) {
          await sendCreditAdminEmail(admin, "empty", currentCredits, thr, patch.empty_credit_email_sent_at);
        }
      } else if (belowThreshold) {
        patch.low_credit_warning_email_sent_at = settings.lowCreditWarningEmailSentAt ?? new Date().toISOString();
        patch.empty_credit_email_sent_at = null;
        if (!settings.lowCreditWarningEmailSentAt) {
          await sendCreditAdminEmail(admin, "warning", currentCredits, thr, patch.low_credit_warning_email_sent_at);
        }
      } else {
        patch.low_credit_warning_email_sent_at = null;
        patch.empty_credit_email_sent_at = null;
      }
      await admin.from("sms_alert_settings").update(patch).eq("id", 1);
    } catch (e) {
      console.error("check-offline: credit monitoring failed:", e);
    }
  }

  // Close any OPEN offline/warning alerts for devices that have been removed.
  const { error: closeErr } = await admin.from("air_notifications")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Device removed - no longer monitored" })
    .eq("status", "open")
    .filter("device_id", "in", `(select d.device_id from public.devices d where d.active = false or d.removed_at is not null union select r.id from public.rooms r where r.active = false or r.removed_at is not null)`);
  if (closeErr) {
    await logDbFailure(admin, "close removed device alerts", closeErr);
  }

  // Only sweep rooms whose matching device row is active and not removed.
  // Select rooms.last_seen only; devices.active/devices.removed_at and
  // devices.reactivated_at are loaded in a separate query per room because
  // rooms has no FK to devices, so devices!inner cannot be embedded here.
  const roomsQuery = `select id, name, floor, last_seen from public.rooms where active = true and removed_at is null`;
  const { data: rooms, error: roomsErr } = await admin.from("rooms")
    .select("id, name, floor, last_seen")
    .eq("active", true)
    .is("removed_at", null);
  if (roomsErr) {
    await logDbFailure(admin, roomsQuery, roomsErr);
    return json({ error: "Failed to load rooms for offline sweep", query: roomsQuery, details: roomsErr.message }, 500);
  }

  const brownoutCandidates: { deviceId: string; roomName: string }[] = [];
  let offlineCreated = 0;

  for (const room of ((rooms as any[]) ?? [])) {
    const deviceId = room.id;
    const roomsLastSeen = room.last_seen as string | undefined;

    // Device active/removed check via a separate query. rooms has no FK to
    // devices, so devices!inner cannot be embedded here. A failed lookup must
    // not block offline detection: log the full error and treat the device as
    // active so real outages are still flagged.
    let deviceActive = true;
    let reactivatedAt: string | undefined;
    try {
      const { data: deviceRow, error: deviceError } = await admin
        .from("devices")
        .select("active, removed_at, reactivated_at")
        .eq("device_id", deviceId)
        .maybeSingle();
      if (deviceError) {
        await logSupabaseError(admin, `checkOffline: load device ${deviceId}`, deviceError);
        deviceActive = true;
        reactivatedAt = undefined;
      } else if (
        deviceRow == null ||
        deviceRow.active === false ||
        deviceRow.removed_at != null
      ) {
        deviceActive = false;
        reactivatedAt = undefined;
      } else {
        reactivatedAt = deviceRow.reactivated_at as string | undefined;
      }
    } catch (e) {
      await logSupabaseError(admin, `checkOffline: load device ${deviceId}`, e);
      deviceActive = true;
      reactivatedAt = undefined;
    }
    if (!deviceActive) continue;

    // Skip devices reactivated within the offline threshold - they were just
    // brought back and should not immediately trip a stale alert based on an
    // old readings.created_at.
    if (reactivatedAt && new Date(reactivatedAt).getTime() >= nowMs - DEFAULT_OFFLINE_AFTER_S * 1000) {
      continue;
    }

    const { data: latest, error: latestErr } = await admin.from("readings")
      .select("created_at")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) { await logDbFailure(admin, `latest reading ${deviceId}`, latestErr); continue; }
    const lastReading = latest?.created_at as string | undefined;

    const lastSignal = newestSignal(lastReading, roomsLastSeen, reactivatedAt);
    const stale = !lastSignal || new Date(lastSignal).getTime() < nowMs - DEFAULT_OFFLINE_AFTER_S * 1000;
    if (!stale) continue;

    const silenceMs = nowMs - new Date(lastSignal).getTime();

    const { data: open, error: openErr } = await admin.from("air_notifications")
      .select("id, created_at")
      .eq("device_id", deviceId)
      .eq("level_label", "Offline")
      .eq("status", "open")
      .maybeSingle();
    if (openErr) { await logDbFailure(admin, `open offline ${deviceId}`, openErr); continue; }

    if (open) {
      // Offline alert already exists. Check if SMS was already sent.
      const { sentAt, submitted } = await lastSmsAttemptForNotification(admin, open.id);
      if (submitted) continue; // SMS already sent, nothing more to do.
      // SMS not yet sent: only send after 10 minutes of silence.
      if (silenceMs < SMS_OFFLINE_MIN_SILENCE_MS) continue;
      const { data: notif, error: notifErr } = await admin.from("air_notifications").select("*").eq("id", open.id).maybeSingle();
      if (notifErr || !notif) continue;
      try {
        await sendAutoSmsForAlert(admin, {
          notification: notif,
          message: notif.message,
          reason: "offline",
          channel: alertChannel(notif.severity, notif.level_label),
        });
      } catch (e) {
        console.error(`[air-alerts] sendAutoSmsForAlert failed for offline notification ${open.id}:`, e);
        await logDbFailure(admin, `sendAutoSmsForAlert offline notification_id=${open.id}`, e);
      }
      continue;
    }

    // No open offline alert: create one (dashboard + email record).
    const msg = buildOfflineMessage(room.name ?? deviceId, OFFLINE_AFTER_MINUTES, manilaTime());
    const { data, error: insErr } = await admin.from("air_notifications").insert({
      device_id: deviceId,
      room_name: room.name ?? deviceId,
      floor: room.floor ?? "",
      sensor_type: "device",
      level_label: "Offline",
      severity: "warning",
      reading_value: null,
      reading_unit: "",
      message: msg,
      status: "open",
    }).select("*").single();
    if (insErr || !data) { await logDbFailure(admin, `insert offline ${deviceId}`, insErr ?? "no row returned"); continue; }

    offlineCreated += 1;

    // Only queue for SMS after 10 minutes of silence.
    if (silenceMs >= SMS_OFFLINE_MIN_SILENCE_MS) {
      brownoutCandidates.push({ deviceId, roomName: room.name ?? deviceId });
    }
  }

  // Brownout grouping: >= BROWNOUT_MIN_DEVICES active devices offline in this
  // sweep -> one SMS instead of one per device.
  const brownoutCovered = new Set<string>();
  if (brownoutCandidates.length >= BROWNOUT_MIN_DEVICES) {
    const body = `Possible power outage: ${brownoutCandidates.length} devices offline (${brownoutCandidates.map((c) => c.roomName).join(", ")}). Check the site.`;
    const cfg = getSmsConfig();
    // A brownout is a grouped offline event, so it obeys the same auto-SMS
    // controls (master switch / pause / auto_sms_offline) as a single offline.
    const blocked = autoSmsBlock(settings, { severity: "warning", level_label: "Offline", sensor_type: "device" }, "offline");
    if (blocked) {
      await insertSmsLog(admin, {
        notification_id: null, message: body, status: "skipped_auto_off",
        provider_response: blocked.detail, provider: cfg.provider, is_auto: true,
      });
      console.log(`air-alerts: brownout SMS suppressed (${blocked.reason}) devices=${brownoutCandidates.length}`);
      for (const c of brownoutCandidates) brownoutCovered.add(c.deviceId);
    } else {
      const recipients = await getSmsRecipients(admin).catch(() => [] as any[]);
      let sent = 0;
      for (const r of recipients) {
        const phone = normalizeForProviderSend(r.contact_number);
        if (!phone) continue;
        const res = await sendSms({ to: phone, message: body }, true);
        await insertSmsLog(admin, {
          notification_id: null, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
          phone: r.contact_number, message: body,
          status: res.ok ? "submitted" : "failed",
          provider_response: sanitizeProviderResponse(res.error ?? (typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw ?? {})), cfg.iprog.token),
          provider: res.provider ?? cfg.provider, provider_message_id: res.providerMessageId ?? null,
          provider_status: res.status ?? (res.ok ? "submitted" : "failed"), is_auto: true,
        });
        if (res.ok) sent += 1;
      }
      console.log(`air-alerts: brownout SMS sent=${sent} devices=${brownoutCandidates.length}`);
      for (const c of brownoutCandidates) brownoutCovered.add(c.deviceId);
    }
  }

  // Unacknowledged reminder: resend for open alerts still unacknowledged after the reminder interval.
  // Offline alerts are email-only here (already got their one SMS at open).
  const reminderCutoff = new Date(nowMs - reminderIntervalMsFromSettings(settings)).toISOString();
  const { data: openUnacked, error: openUnackedErr } = await admin.from("air_notifications")
    .select("*")
    .eq("status", "open")
    .in("severity", ["warning", "high", "danger", "critical"])
    .lte("created_at", reminderCutoff)
    .limit(100);
  if (openUnackedErr) {
    await logDbFailure(admin, "reminder query", openUnackedErr);
  } else {
    for (const n of ((openUnacked as any[]) ?? [])) {
      try {
        const channel = alertChannel(n.severity, n.level_label);
        if (channel === "offline") continue; // offline reminders are email-only
        const { sentAt, submitted } = await lastSmsAttemptForNotification(admin, n.id);
        if (sentAt) {
          const intervalMs = settings.smsReminderMinutes > 0 ? settings.smsReminderMinutes * 60 * 1000 : SMS_REMINDER_INTERVAL_MS;
          if (Date.now() - new Date(sentAt).getTime() < intervalMs) continue;
        } else {
          continue; // first send handled on creation/backfill path
        }
        const reading = n.reading_value != null ? fmtReading(n.sensor_type, n.reading_value) : "sensor alert";
        const msg = n.message || buildAlertSms(n.severity, n.level_label, n.room_name ?? n.device_id, n.floor ?? "", String(n.sensor_type).toUpperCase(), reading, manilaTime());
        const result = await sendAutoSmsForAlert(admin, {
          notification: n, message: msg, reason: "unacknowledged_reminder",
          channel, isReminder: true,
        });
        if (!result.attempted && result.emailFallback) {
          await sendFallbackEmail(admin, n, result.reason ?? "credits");
        }
      } catch (e) {
        console.error(`[air-alerts] reminder processing failed for notification ${n.id}:`, e);
        await logDbFailure(admin, `reminder loop notification_id=${n.id}`, e);
      }
    }
  }

  return json({ status: "ok", offline_created: offlineCreated, brownout_devices: brownoutCandidates.length });
}

function reminderIntervalMsFromSettings(settings: any): number {
  return settings.smsReminderMinutes > 0 ? settings.smsReminderMinutes * 60 * 1000 : SMS_REMINDER_INTERVAL_MS;
}

/** Send the once-only credit admin email (warning or empty) and record the sent-at. */
async function sendCreditAdminEmail(admin: Admin, kind: "warning" | "empty", balance: number | null, threshold: number, sentAt: string): Promise<void> {
  try {
    const to = await adminEmails(admin);
    if (to.length === 0) return;
    const html = creditEmailHtml(kind, balance, threshold);
    const subject = kind === "empty"
      ? "[A.I.R.] SMS credits empty"
      : `[A.I.R.] Low SMS credits (${balance ?? "?"} remaining)`;
    const { error } = await sendResendEmail(to, subject, html);
    if (error) console.error(`check-offline: credit ${kind} email failed:`, error);
  } catch (e) {
    console.error(`check-offline: credit ${kind} email failed:`, e);
  }
}

/** Normalize a recipient's stored contact number for sending (iProg: 639XXXXXXXXX). */
function normalizeForProviderSend(contact: string | null | undefined): string | null {
  if (!contact) return null;
  let d = String(contact).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0063")) d = d.slice(4);
  if (d.startsWith("63") && d.length === 12) d = d;
  else if (d.startsWith("9") && d.length === 10) d = `63${d}`;
  else if (d.startsWith("09") && d.length === 11) d = `63${d.slice(1)}`;
  else return null;
  if (d.length !== 13 || !d.startsWith("639")) return null;
  return d;
}

/** Newest non-null timestamp among the candidates - mirrors
 *  src/lib/deviceConnectivity.ts newestTimestamp() so the server and the
 *  dashboard never disagree about a device's last signal. */
function newestSignal(...candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const c of candidates) {
    if (!c) continue;
    const ms = new Date(c).getTime();
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = c;
    }
  }
  return best;
}

async function resendSms(admin: Admin, notificationId: number) {
  const { data: n } = await admin.from("air_notifications").select("*").eq("id", notificationId).maybeSingle();
  if (!n) return json({ error: "Notification not found" }, 404);
  if (n.status === "acknowledged" || n.status === "resolved") {
    return json({ status: "skipped", reason: `Notification is ${n.status}` });
  }
  const channel = alertChannel(n.severity, n.level_label);
  const reading = n.reading_value != null ? fmtReading(n.sensor_type, n.reading_value) : "alert";
  const msg = n.message || buildAlertSms(n.severity, n.level_label, n.room_name ?? n.device_id, n.floor ?? "", String(n.sensor_type).toUpperCase(), reading, manilaTime());
  const result = await sendAutoSmsForAlert(admin, { notification: n, message: msg, reason: "manual_resend_auto", channel });
  return json({ status: "resent", result });
}

async function backfillCurrent(admin: Admin, deviceId?: string) {
  let q = admin.from("readings").select("*").order("created_at", { ascending: false }).limit(50);
  if (deviceId) q = q.eq("device_id", deviceId);
  const { data: rows } = await q;
  const latestByDevice = new Map<string, any>();
  for (const r of ((rows as any[]) ?? [])) {
    if (!latestByDevice.has(r.device_id)) latestByDevice.set(r.device_id, r);
  }
  const results: any[] = [];
  for (const rec of latestByDevice.values()) {
    try {
      const res = await handleReading(admin, rec);
      const body = await res.json();
      results.push(body);
    } catch (e) {
      results.push({ device_id: rec.device_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ status: "backfill_done", devices: results.length, results });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase secrets" }, 500);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  if (payload?.action === "check_offline") return await checkOffline(admin);
  if (payload?.action === "resend") return await resendSms(admin, Number(payload.notification_id));
  if (payload?.action === "backfill") return await backfillCurrent(admin, payload.device_id ? String(payload.device_id) : undefined);

  // Readings webhook payload
  const record = payload?.record ?? payload;
  if (!record || !record.device_id) return json({ error: "Missing payload.record" }, 400);
  return await handleReading(admin, record);
});
