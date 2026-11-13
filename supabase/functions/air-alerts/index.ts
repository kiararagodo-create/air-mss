/**
 * air-alerts - server-side notification generation + automatic SMS (iProgSMS).
 *
 * Triggers (no dashboard required):
 *  - DB webhook/trigger on INSERT into public.readings -> create/resolve alerts + auto SMS
 *  - { action: "resend", notification_id } -> resend auto SMS for an open alert
 *  - { action: "check_offline" } -> offline/online sweep (cron/schedule)
 *  - { action: "backfill", device_id? } -> create/send for current active danger from latest reading
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import {
  evaluateSensor,
  formatReadingForDisplay,
  isSensorFaultReading,
  newActionToken,
  type SensorType,
  type Thresholds,
} from "../_shared/air_alerts.ts";
import { buildAllClearMessage, buildOfflineMessage, manilaTime } from "../_shared/sms_templates.ts";
import { getSmsConfig, getSmsCredits, sendSms } from "../_shared/sms-provider.ts";
import { getSmsRecipients, isValidPhMobile, normalizePhSmsNumber } from "../_shared/sms_recipients.ts";
import { OFFLINE_AFTER_MINUTES, DEFAULT_OFFLINE_AFTER_S } from "../_shared/offline_config.ts";

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

const SMS_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes per alert (per room+sensor+severity alert row)
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
  error?: DbFailure;
}> {
  const query = `select automatic_sms, min_severity, reminder_minutes, close_after_minutes, max_sms_per_hour, max_sms_per_day, low_credit_threshold from public.sms_alert_settings where id=1`;
  try {
    const { data, error } = await admin
      .from("sms_alert_settings")
      .select("automatic_sms, min_severity, reminder_minutes, close_after_minutes, max_sms_per_hour, max_sms_per_day, low_credit_threshold")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      await logDbFailure(admin, query, error);
      return {
        automatic: true, minSeverity: "warning", reminderMinutes: 60, closeAfterMinutes: 10,
        maxSmsPerHour: 5, maxSmsPerDay: 20, lowCreditThreshold: 20,
        error: { query, error: error.message ?? String(error), details: error },
      };
    }
    if (data) {
      return {
        automatic: data.automatic_sms !== false,
        minSeverity: String(data.min_severity ?? "warning"),
        reminderMinutes: Number(data.reminder_minutes ?? 60),
        closeAfterMinutes: Number(data.close_after_minutes ?? 10),
        maxSmsPerHour: Number(data.max_sms_per_hour ?? 5),
        maxSmsPerDay: Number(data.max_sms_per_day ?? 20),
        lowCreditThreshold: Number(data.low_credit_threshold ?? 20),
      };
    }
  } catch (e) {
    await logDbFailure(admin, query, e);
    return {
      automatic: true, minSeverity: "warning", reminderMinutes: 60, closeAfterMinutes: 10,
      maxSmsPerHour: 5, maxSmsPerDay: 20, lowCreditThreshold: 20,
      error: { query, error: e instanceof Error ? e.message : String(e), details: e },
    };
  }
  return {
    automatic: true, minSeverity: "warning", reminderMinutes: 60, closeAfterMinutes: 10,
    maxSmsPerHour: 5, maxSmsPerDay: 20, lowCreditThreshold: 20,
  };
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
  // Required format example: "[DANGER] Kitchen - 3rd Floor: CO2 5000 ppm at 7:47 PM. Please respond."
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
  const insertQuery = `insert into public.sms_logs ${JSON.stringify({ status: payload.status, notification_id: payload.notification_id, personnel_id: payload.personnel_id, is_auto: payload.is_auto, send_mode: payload.send_mode })}`;
  const { error } = await admin.from("sms_logs").insert(payload);
  if (error) {
    const fallback = { ...payload };
    delete fallback.send_mode;
    delete fallback.is_auto;
    const { error: fallbackErr } = await admin.from("sms_logs").insert(fallback);
    if (fallbackErr) {
      console.error(`[air-alerts] DB query failed: ${insertQuery} :: ${error.message}; fallback failed :: ${fallbackErr.message}`, { payload, error, fallbackErr });
    } else {
      console.error(`[air-alerts] DB query degraded (dropped send_mode/is_auto): ${insertQuery} :: ${error.message}`, { error });
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
  const selectQuery = `select id, level_label, severity, status from public.air_notifications where device_id='${params.device_id}' and sensor_type='${params.sensor_type}' and status='open' limit 1`;
  const { data: existing, error: existingErr } = await admin
    .from("air_notifications")
    .select("id, level_label, severity, status")
    .eq("device_id", params.device_id)
    .eq("sensor_type", params.sensor_type)
    .eq("status", "open")
    .maybeSingle();
  if (existingErr) {
    await logDbFailure(admin, selectQuery, existingErr);
    return null;
  }

  if (existing) {
    if (existing.level_label === params.level_label && existing.severity === params.severity) {
      const updateSameQuery = `update public.air_notifications set reading_value,message where id=${existing.id}`;
      const { error: updErr } = await admin.from("air_notifications")
        .update({ reading_value: params.reading_value, message: params.message })
        .eq("id", existing.id);
      if (updErr) await logDbFailure(admin, updateSameQuery, updErr);
      return { id: existing.id, created: false, escalated: false, previousLevel: existing.level_label };
    }
    const escalated = (SEV_RANK[params.severity] ?? 0) > (SEV_RANK[existing.severity] ?? 0);
    const resolveQuery = `update public.air_notifications set status='resolved' where id=${existing.id}`;
    const { error: resolveErr } = await admin.from("air_notifications")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolution_note: escalated ? `Escalated to ${params.level_label}` : `Changed to ${params.level_label}`,
      })
      .eq("id", existing.id);
    if (resolveErr) {
      await logDbFailure(admin, resolveQuery, resolveErr);
      return null;
    }
    const insertEscQuery = `insert into public.air_notifications (device_id,sensor_type,level_label,status='open',escalation_of=${existing.id})`;
    const { data, error: insErr } = await admin.from("air_notifications").insert({
      ...params,
      escalation_of: existing.id,
      status: "open",
    }).select("id").single();
    if (insErr || !data) {
      await logDbFailure(admin, insertEscQuery, insErr ?? "no row returned");
      return null;
    }
    return { id: data.id, created: true, escalated, previousLevel: existing.level_label };
  }

  const insertQuery = `insert into public.air_notifications (device_id='${params.device_id}',sensor_type='${params.sensor_type}',level_label='${params.level_label}',status='open')`;
  const { data, error } = await admin.from("air_notifications").insert({
    ...params,
    status: "open",
  }).select("id").single();
  if (error || !data) {
    await logDbFailure(admin, insertQuery, error ?? "no row returned");
    return null;
  }
  return { id: data.id, created: true, escalated: false };
}

async function resolveSensor(admin: Admin, deviceId: string, sensor: SensorType, note = "Reading returned to safe range") {
  const query = `update public.air_notifications set status='resolved' where device_id='${deviceId}' and sensor_type='${sensor}' and status='open'`;
  const { error } = await admin.from("air_notifications")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: note })
    .eq("device_id", deviceId)
    .eq("sensor_type", sensor)
    .eq("status", "open");
  if (error) await logDbFailure(admin, query, error);
}

async function lastAutoSmsAtForNotification(admin: Admin, notificationId: number): Promise<string | null> {
  const query = `select sent_at,status,send_mode,is_auto from public.sms_logs where notification_id=${notificationId} and status in ('submitted','in_progress') order by sent_at desc limit 30`;
  const { data, error } = await admin
    .from("sms_logs")
    .select("sent_at,status,send_mode,is_auto")
    .eq("notification_id", notificationId)
    .in("status", ["submitted", "in_progress"])
    .order("sent_at", { ascending: false })
    .limit(30);
  if (error) {
    await logDbFailure(admin, query, error);
    throw new Error(`DB failure: ${query} :: ${error.message}`);
  }
  if (!data) return null;
  const row = (data as any[]).find((r) => r.is_auto === true || r.send_mode === "auto" || r.send_mode == null);
  return row?.sent_at ?? null;
}

async function sendAutoSmsForAlert(
  admin: Admin,
  params: {
    notification: any;
    message: string;
    reason: "new_alert" | "escalation" | "cooldown_reminder" | "unacknowledged_reminder" | "offline" | "manual_resend_auto" | "backfill";
  },
): Promise<{ attempted: boolean; reason: string | null }> {
  const n = params.notification;
  const cfg = getSmsConfig();
  const settings = await loadSmsSettings(admin);

  if (!settings.automatic && params.reason !== "manual_resend_auto" && params.reason !== "backfill") {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_disabled",
      provider_response: "automatic_sms disabled", provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: "automatic_sms_disabled" };
  }

  // Allow warning/alarm/high/danger/critical/offline alerts to send; still respect minSeverity.
  if (!sevAtLeast(n.severity, settings.minSeverity) && n.level_label !== "Offline") {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_disabled",
      provider_response: `Below min severity (${settings.minSeverity})`, provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: "below_min_severity" };
  }

  if (n.status === "acknowledged" || n.status === "resolved") {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message,
      status: n.status === "acknowledged" ? "skipped_acknowledged" : "skipped_open_incident",
      provider_response: `Notification is ${n.status}`, provider: cfg.provider, is_auto: true,
    });
    return { attempted: false, reason: `notification_${n.status}` };
  }

  // Cooldown: 10 min per alert unless escalation or explicit backfill/manual resend.
  if (params.reason !== "escalation" && params.reason !== "manual_resend_auto") {
    const lastSentAt = await lastAutoSmsAtForNotification(admin, n.id);
    if (lastSentAt) {
      const elapsed = Date.now() - new Date(lastSentAt).getTime();
      if (elapsed < SMS_COOLDOWN_MS) {
        await insertSmsLog(admin, {
          notification_id: n.id, message: params.message, status: "skipped_rate_limited",
          provider_response: `Cooldown active (${Math.ceil((SMS_COOLDOWN_MS - elapsed) / 1000)}s remaining)`,
          provider: cfg.provider, is_auto: true,
        });
        return { attempted: false, reason: "cooldown" };
      }
    }
  }

  // Send to ALL active, approved, sms_enabled personnel with valid PH mobile numbers (dashboard toggle).
  let recipients;
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
    return { attempted: false, reason: "db_error_recipients" };
  }
  if (recipients.length === 0) {
    await insertSmsLog(admin, {
      notification_id: n.id, message: params.message, status: "skipped_no_recipients",
      provider_response: "No active approved personnel with sms_enabled=true and valid PH mobile (09XXXXXXXXX)",
      provider: cfg.provider, is_auto: true,
    });
    console.log(`air-alerts: alert ${n.id} no eligible SMS recipients`);
    return { attempted: false, reason: "no_recipients" };
  }

  // Credit guard (best effort).
  let credits: number | null = null;
  if (!cfg.dryRun) {
    try {
      const c = await getSmsCredits(true);
      credits = c.credits;
      if (c.authError) {
        console.error(`air-alerts: iProgSMS credits/auth check failed for alert ${n.id}: ${c.authError}`);
      }
    } catch (e) {
      console.error(`air-alerts: credits check error for alert ${n.id}:`, e instanceof Error ? e.message : String(e));
      credits = null;
    }
  }
  const dangerCritical = isDangerLevel(n.severity, n.level_label);
  if (credits === 0) {
    for (const r of recipients) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "skipped_low_credits",
        provider_response: "SMS credits are 0", provider: cfg.provider, is_auto: true,
      });
    }
    console.log(`air-alerts: alert ${n.id} skipped, SMS credits 0`);
    return { attempted: false, reason: "credits_zero" };
  }
  if (!dangerCritical && credits !== null && credits < settings.lowCreditThreshold) {
    for (const r of recipients) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "skipped_low_credits",
        provider_response: `Credits below threshold (${credits} < ${settings.lowCreditThreshold})`,
        provider: cfg.provider, is_auto: true,
      });
    }
    return { attempted: false, reason: "low_credits" };
  }

  if (cfg.dryRun) {
    for (const r of recipients) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "skipped_dry_run",
        provider_response: "DRY_RUN enabled (no SMS sent)", provider: cfg.provider, is_auto: true,
      });
    }
    return { attempted: false, reason: "dry_run" };
  }

  let attempted = false;
  for (const r of recipients) {
    const rawPhone = String(r.contact_number ?? "").replace(/[\s()-]/g, "");
    if (/^\+?639\d{9}$/.test(rawPhone)) r.contact_number = "0" + rawPhone.replace(/^\+?63/, "");
    if (!isValidPhMobile(r.contact_number) || !normalizePhSmsNumber(r.contact_number)) {
      await insertSmsLog(admin, {
        notification_id: n.id, personnel_id: r.id, recipient_name: r.name, recipient_role: r.role,
        phone: r.contact_number, message: params.message, status: "invalid_number",
        provider_response: "Invalid PH mobile number (must be 11 digits starting with 09)",
        provider: cfg.provider, is_auto: true,
      });
      console.log(`air-alerts: skipped invalid number for ${r.name} (${r.role})`);
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
    const providerResponse = res.error ?? (typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw ?? {}));
    console.log(`air-alerts: SMS result alert=${n.id} recipient=${r.id} ok=${res.ok} status=${res.status} provider=${res.provider} msgId=${res.providerMessageId ?? "none"} response=${String(providerResponse).slice(0, 300)}`);
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

  return { attempted, reason: attempted ? null : "no_valid_recipients" };
}

async function handleReading(admin: Admin, record: any) {
  const th = await resolveThresholds(admin);
  if (!th) return json({ error: "No thresholds (resolve_thresholds failed or returned null). Check function logs for failing query." }, 500);

  const device_id = String(record.device_id ?? "");
  if (!device_id) return json({ error: "Missing device_id" }, 400);

  const created_at = record.created_at ? String(record.created_at) : new Date().toISOString();
  const roomQuery = `select name,floor from public.rooms where id='${device_id}' limit 1`;
  const { data: room, error: roomErr } = await admin.from("rooms").select("name, floor").eq("id", device_id).maybeSingle();
  if (roomErr) await logDbFailure(admin, roomQuery, roomErr);
  const room_name = room?.name ?? device_id;
  const floor = room?.floor ?? "";

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

    const ev = evaluateSensor(s.key as any, s.value, th);
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

    // One SMS per alert: on newly created/escalated alert, or if open and never sent / cooldown passed (backfill-safe).
    if (up.created) {
      triggered.push({ notif, up, reason: up.escalated ? "escalation" : "new_alert" });
      if (up.escalated) escalated.push(notif);
    } else if (notif.status === "open") {
      const lastSentAt = await lastAutoSmsAtForNotification(admin, notif.id);
      const elapsed = lastSentAt ? Date.now() - new Date(lastSentAt).getTime() : Infinity;
      if (!lastSentAt || elapsed >= SMS_COOLDOWN_MS) {
        triggered.push({ notif, up, reason: !lastSentAt ? "backfill" : "unacknowledged_reminder" });
      }
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
    // Log saturation in sms_logs as informational auto event (no notification id) for visibility.
    await insertSmsLog(admin, {
      notification_id: null,
      message: `Sensor saturation notice: ${saturation.join("; ")}`.slice(0, 160),
      status: "skipped_quality",
      provider_response: "At sensor max - still treated as danger; verify sensor/calibration",
      provider: getSmsConfig().provider,
      is_auto: true,
    });
  }

  // Device came online with a fresh reading: resolve offline alert(s) and send all-clear.
  if (!stale) {
    const openOfflineQuery = `select id from public.air_notifications where device_id='${device_id}' and level_label='Offline' and status='open'`;
    const { data: openOffline, error: openOfflineErr } = await admin.from("air_notifications")
      .select("id")
      .eq("device_id", device_id)
      .eq("level_label", "Offline")
      .eq("status", "open");
    if (openOfflineErr) {
      await logDbFailure(admin, openOfflineQuery, openOfflineErr);
    } else if (openOffline && openOffline.length > 0) {
      for (const row of openOffline as any[]) {
        const notifQuery = `select * from public.air_notifications where id=${row.id}`;
        const { data: notif, error: notifErr } = await admin.from("air_notifications").select("*").eq("id", row.id).maybeSingle();
        if (notifErr) { await logDbFailure(admin, notifQuery, notifErr); continue; }
        if (notif) {
          await sendAutoSmsForAlert(admin, {
            notification: notif,
            message: buildAllClearMessage(room_name, manilaTime()),
            reason: "new_alert",
          });
        }
      }
      const resolveOfflineQuery = `update public.air_notifications set status='resolved' where device_id='${device_id}' and level_label='Offline' and status='open'`;
      const { error: resolveOfflineErr } = await admin.from("air_notifications")
        .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Device back online" })
        .eq("device_id", device_id)
        .eq("level_label", "Offline")
        .eq("status", "open");
      if (resolveOfflineErr) await logDbFailure(admin, resolveOfflineQuery, resolveOfflineErr);
    }
  }

  // Send automatic SMS for triggered alerts (one per alert, de-duped above)
  for (const t of triggered) {
    const msg = t.notif.message || buildAlertSms(t.notif.severity, t.notif.level_label, room_name, floor, String(t.notif.sensor_type).toUpperCase(), fmtReading(t.notif.sensor_type, t.notif.reading_value), manilaTime());
    await sendAutoSmsForAlert(admin, { notification: t.notif, message: msg, reason: t.reason });
  }

  console.log(`air-alerts processed device=${device_id} room=${room_name} triggered=${triggered.length} escalated=${escalated.length} faults=${faults.length} saturation=${saturation.length} stale=${stale}`);
  return json({ status: "processed", device_id, room_name, triggered: triggered.length, faults: faults.length, saturation, escalated: escalated.length, stale });
}

async function checkOffline(admin: Admin) {
  const cutoff = new Date(Date.now() - DEFAULT_OFFLINE_AFTER_S * 1000).toISOString();
  const roomsQuery = `select id,name,floor from public.rooms`;
  const { data: rooms, error: roomsErr } = await admin.from("rooms").select("id, name, floor");
  if (roomsErr) {
    await logDbFailure(admin, roomsQuery, roomsErr);
    return json({ error: "Failed to load rooms for offline sweep", query: roomsQuery, details: roomsErr.message }, 500);
  }
  const created: number[] = [];

  for (const room of ((rooms as any[]) ?? [])) {
    const latestQuery = `select created_at from public.readings where device_id='${room.id}' order by created_at desc limit 1`;
    const { data: latest, error: latestErr } = await admin.from("readings")
      .select("created_at")
      .eq("device_id", room.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) { await logDbFailure(admin, latestQuery, latestErr); continue; }
    const lastSeen = latest?.created_at as string | undefined;
    const stale = !lastSeen || lastSeen < cutoff;
    if (!stale) continue;

    const openOfflineQuery = `select id from public.air_notifications where device_id='${room.id}' and level_label='Offline' and status='open' limit 1`;
    const { data: open, error: openErr } = await admin.from("air_notifications")
      .select("id")
      .eq("device_id", room.id)
      .eq("level_label", "Offline")
      .eq("status", "open")
      .maybeSingle();
    if (openErr) { await logDbFailure(admin, openOfflineQuery, openErr); continue; }
    if (open) continue;

    const msg = buildOfflineMessage(room.name ?? room.id, OFFLINE_AFTER_MINUTES, manilaTime());
    const insertOfflineQuery = `insert into public.air_notifications (device_id='${room.id}', level_label='Offline', status='open')`;
    const { data, error: insErr } = await admin.from("air_notifications").insert({
      device_id: room.id,
      room_name: room.name ?? room.id,
      floor: room.floor ?? "",
      sensor_type: "device",
      level_label: "Offline",
      severity: "warning",
      reading_value: null,
      reading_unit: "",
      message: msg,
      status: "open",
    }).select("*").single();
    if (insErr || !data) { await logDbFailure(admin, insertOfflineQuery, insErr ?? "no row returned"); continue; }

    created.push(data.id);
    try {
      await sendAutoSmsForAlert(admin, { notification: data, message: msg, reason: "offline" });
    } catch (e) {
      console.error(`[air-alerts] sendAutoSmsForAlert failed for offline notification ${data.id}:`, e);
      await logDbFailure(admin, `sendAutoSmsForAlert offline notification_id=${data.id}`, e);
    }
  }

  // Unacknowledged reminder: resend for open alerts still unacknowledged after cooldown
  const reminderCutoff = new Date(Date.now() - SMS_COOLDOWN_MS).toISOString();
  const openUnackedQuery = `select * from public.air_notifications where status='open' and severity in ('warning','high','danger','critical') and created_at<='${reminderCutoff}' limit 100`;
  const { data: openUnacked, error: openUnackedErr } = await admin.from("air_notifications")
    .select("*")
    .eq("status", "open")
    .in("severity", ["warning", "high", "danger", "critical"])
    .lte("created_at", reminderCutoff)
    .limit(100);
  if (openUnackedErr) {
    await logDbFailure(admin, openUnackedQuery, openUnackedErr);
  } else {
    for (const n of ((openUnacked as any[]) ?? [])) {
      try {
        const lastSent = await lastAutoSmsAtForNotification(admin, n.id);
        if (lastSent && Date.now() - new Date(lastSent).getTime() < SMS_COOLDOWN_MS) continue;
        if (!lastSent) continue; // first send handled on creation/backfill path
        const reading = n.reading_value != null ? fmtReading(n.sensor_type, n.reading_value) : "sensor alert";
        const msg = n.message || buildAlertSms(n.severity, n.level_label, n.room_name ?? n.device_id, n.floor ?? "", String(n.sensor_type).toUpperCase(), reading, manilaTime());
        await sendAutoSmsForAlert(admin, { notification: n, message: msg, reason: "unacknowledged_reminder" });
      } catch (e) {
        console.error(`[air-alerts] reminder processing failed for notification ${n.id}:`, e);
        await logDbFailure(admin, `reminder loop notification_id=${n.id}`, e);
      }
    }
  }

  return json({ status: "ok", offline_created: created.length });
}

async function resendSms(admin: Admin, notificationId: number) {
  const { data: n } = await admin.from("air_notifications").select("*").eq("id", notificationId).maybeSingle();
  if (!n) return json({ error: "Notification not found" }, 404);
  if (n.status === "acknowledged" || n.status === "resolved") {
    return json({ status: "skipped", reason: `Notification is ${n.status}` });
  }
  const reading = n.reading_value != null ? fmtReading(n.sensor_type, n.reading_value) : "alert";
  const msg = n.message || buildAlertSms(n.severity, n.level_label, n.room_name ?? n.device_id, n.floor ?? "", String(n.sensor_type).toUpperCase(), reading, manilaTime());
  const result = await sendAutoSmsForAlert(admin, { notification: n, message: msg, reason: "manual_resend_auto" });
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
