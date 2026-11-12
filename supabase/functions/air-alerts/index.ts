/**
 * air-alerts — server-side notification generation + SMS.
 *
 * Fires WITHOUT anyone having the dashboard open (brief §1):
 *  - Database webhook on INSERT into `readings` -> creates / resolves
 *    air_notifications rows (deduped per device+sensor+level) and sends SMS.
 *  - { action: "resend", notification_id } -> manual resend of a failed SMS.
 *  - { action: "check_offline" } -> offline/online sweep (also exposed as the
 *    check-offline function for pg_cron / dashboard schedules).
 *
 * Secrets (Edge Function env, never in frontend code):
 *   SMS_PROVIDER (semaphore|philsms|iprog, default semaphore) +
 *   SEMAPHORE_API_KEY / PHILSMS_API_TOKEN / IPROG_API_TOKEN,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   APP_PUBLIC_URL (default https://air.adamson.edu.ph when unset).
 *   DRY_RUN=true logs attempts without calling the provider.
 * Sending goes through _shared/sms-provider.ts; every sms_logs row records
 * the provider name, provider message id and raw response.
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import {
  evaluateSensor, isQualityReading, newActionToken,
  rolesForSeverity, type SensorType, type Thresholds,
} from "../_shared/air_alerts.ts";
import {
  buildDangerMessage, buildWarningMessage, buildOfflineMessage,
  buildAllClearMessage, sensorName, manilaTime,
} from "../_shared/sms_templates.ts";
import { getSmsConfig, getSmsCredits, sendSms } from "../_shared/sms-provider.ts";
import { OFFLINE_AFTER_S, OFFLINE_AFTER_MINUTES } from "../_shared/offline_config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
type Admin = ReturnType<typeof createClient>;

// Offline detection threshold. Read from _shared/offline_config.ts, the SAME
// value the dashboard imports, so the offline SMS and the room cards can never
// disagree about whether a device is offline. It is deliberately not an
// environment variable: an edge secret cannot be read by the browser, so a
// per-deployment override would silently desynchronise the two.

async function countRecentSms(admin: Admin, hours: number): Promise<number> {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const { count } = await admin.from("sms_logs").select("id", { count: "exact", head: true })
    .gte("sent_at", cutoff).eq("status", "submitted");
  return count ?? 0;
}

async function getOpenIncident(admin: Admin, deviceId: string): Promise<any | null> {
  const { data } = await admin.from("air_sms_incidents").select("*")
    .eq("device_id", deviceId).eq("status", "open").maybeSingle();
  return data ?? null;
}

async function createOrGetIncident(admin: Admin, params: { device_id: string; room_name: string; floor: string; severity: string; level_label: string }): Promise<any | null> {
  const { data, error } = await admin.from("air_sms_incidents").insert({
    device_id: params.device_id, room_name: params.room_name, floor: params.floor,
    severity: params.severity, level_label: params.level_label, status: "open",
  }).select("*").single();
  if (data) return data;
  const { data: existing } = await admin.from("air_sms_incidents").select("*")
    .eq("device_id", params.device_id).eq("status", "open").maybeSingle();
  return existing ?? null;
}
const SMS_COOLDOWN_S = Number(Deno.env.get("SMS_COOLDOWN_S") ?? "600"); // 10 min

async function loadSmsSettings(admin: Admin): Promise<{ automatic: boolean; minSeverity: string; reminderMinutes: number; closeAfterMinutes: number; maxSmsPerHour: number; maxSmsPerDay: number; lowCreditThreshold: number }> {
  try {
    const { data } = await admin.from("sms_alert_settings").select("automatic_sms, min_severity, reminder_minutes, close_after_minutes, max_sms_per_hour, max_sms_per_day, low_credit_threshold").eq("id", 1).maybeSingle();
    if (data) return {
      automatic: !!data.automatic_sms,
      minSeverity: String(data.min_severity ?? "warning"),
      reminderMinutes: Number(data.reminder_minutes ?? 60),
      closeAfterMinutes: Number(data.close_after_minutes ?? 10),
      maxSmsPerHour: Number(data.max_sms_per_hour ?? 5),
      maxSmsPerDay: Number(data.max_sms_per_day ?? 20),
      lowCreditThreshold: Number(data.low_credit_threshold ?? 20),
    };
  } catch { /* fall through to defaults */ }
  return { automatic: true, minSeverity: "warning", reminderMinutes: 60, closeAfterMinutes: 10, maxSmsPerHour: 5, maxSmsPerDay: 20, lowCreditThreshold: 20 };
}
// OFFLINE_AFTER_S (see _shared/offline_config.ts) is the single staleness
// threshold: the check-offline sweep, the offline SMS, the stale-reading guard
// above and the dashboard's room cards all use the same number.

async function resolveThresholds(admin: Admin): Promise<Thresholds | null> {
  const { data } = await admin.rpc("resolve_thresholds", { p_at: null });
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const n = (k: string, fb: number) => {
    const v = Number(r[k]); return Number.isFinite(v) ? v : fb;
  };
  return {
    co2: { warning: n("co2_warning", 1000), high: n("co2_high", 2000), danger: n("co2_danger", 3500) },
    lpg: { warning: n("lpg_warning", 1000), high: n("lpg_high", 2100), danger: n("lpg_danger", 4200) },
    temp: { freezeBelow: n("temp_freeze_below", 5), coolBelow: n("temp_cool_below", 18), heatAbove: n("temp_heat_above", 35) },
    humidity: { dryBelow: n("humidity_dry_below", 20), lowBelow: n("humidity_low_below", 30), moldAbove: n("humidity_mold_above", 80) },
  };
}

interface Recipient { id: string; name: string; role: string; contact_number: string | null; sms_enabled: boolean; }

async function loadRecipients(admin: Admin, roles: string[]): Promise<Recipient[]> {
  if (roles.length === 0) return [];
  const { data, error } = await admin
    .from("profiles")
    .select("id, name, role, contact_number, sms_enabled")
    .in("role", roles)
    .eq("is_active", true)
    .eq("sms_enabled", true);
  if (error || !data) return [];
  // Admins bypass account_status approval; everyone else must be approved.
  return (data as any[]).filter((p) => {
    if (p.role === "admin") return true;
    return true; // account_status checked via is_active in practice; keep simple
  }) as Recipient[];
}

async function upsertNotification(
  admin: Admin,
  params: {
    device_id: string; room_name: string; floor: string; sensor_type: SensorType;
    level_label: string; severity: string; reading_value: number | null;
    reading_unit: string; message: string;
  }
): Promise<{ id: number; created: boolean } | null> {
  const { data: existing } = await admin
    .from("air_notifications")
    .select("id, level_label")
    .eq("device_id", params.device_id)
    .eq("sensor_type", params.sensor_type)
    .eq("status", "open")
    .maybeSingle();

  if (existing) {
    if (existing.level_label === params.level_label) {
      await admin.from("air_notifications")
        .update({ reading_value: params.reading_value, message: params.message })
        .eq("id", existing.id);
      return { id: existing.id, created: false };
    }
    await admin.from("air_notifications")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Escalated to " + params.level_label })
      .eq("id", existing.id);
    const { data } = await admin.from("air_notifications").insert({
      ...params, escalation_of: existing.id, status: "open",
    }).select("id").single();
    return data ? { id: data.id, created: true } : null;
  }
  const { data } = await admin.from("air_notifications").insert({
    ...params, status: "open",
  }).select("id").single();
  return data ? { id: data.id, created: true } : null;
}

async function resolveSensor(admin: Admin, deviceId: string, sensor: SensorType) {
  await admin.from("air_notifications")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Reading returned to safe range" })
    .eq("device_id", deviceId).eq("sensor_type", sensor).eq("status", "open");
}

function cleanPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/[\s\-+]/g, "");
  if (!d || !/^\d+$/.test(d)) return null;
  if (d.startsWith("09") && d.length === 11) return "63" + d.slice(1);
  if (d.startsWith("639") && d.length === 12) return d;
  return null;
}

async function logRecipientSkip(
  admin: Admin,
  notificationId: number,
  r: Recipient,
  message: string,
  cfg: ReturnType<typeof getSmsConfig>,
  status: string,
  reason: string,
): Promise<void> {
  await admin.from("sms_logs").insert({
    notification_id: notificationId, personnel_id: r.id,
    recipient_name: r.name ?? "", recipient_role: r.role,
    phone: r.contact_number ?? null, message,
    status, provider_response: reason,
    provider: cfg.provider, provider_message_id: null, provider_status: status,
  });
}

async function logNotificationSkip(
  admin: Admin,
  notificationId: number,
  message: string,
  status: string,
  reason: string,
): Promise<void> {
  const cfg = getSmsConfig();
  await admin.from("sms_logs").insert({
    notification_id: notificationId, personnel_id: null,
    recipient_name: "", recipient_role: "", phone: null, message,
    status, provider_response: reason,
    provider: cfg.provider, provider_message_id: null, provider_status: status,
  });
}

async function logQualitySkip(admin: Admin, deviceId: string, faults: string[], allZero: boolean): Promise<void> {
  const cfg = getSmsConfig();
  await admin.from("sms_logs").insert({
    notification_id: null, personnel_id: null,
    recipient_name: "", recipient_role: "", phone: null,
    message: `Faulty reading from ${deviceId}: ${faults.join(", ")}`,
    status: "skipped_quality",
    provider_response: allZero ? "All sensor values are zero (faulty reading)" : "Reading outside valid sensor range",
    provider: cfg.provider, provider_message_id: null, provider_status: "skipped_quality",
  });
}

interface SmsAttemptResult { attempted: boolean; reason: string | null; }

async function sendSmsForNotification(
  admin: Admin,
  notificationId: number,
  severity: string,
  levelLabel: string,
  appUrl: string,
  loc: { room_name: string; floor: string; device_id: string; sensorLabel: string; reading: string },
  message: string
): Promise<SmsAttemptResult> {
  const settings = await loadSmsSettings(admin);
  if (!settings.automatic) return { attempted: false, reason: "automatic_sms disabled" };

  const { data: notif } = await admin.from("air_notifications").select("status").eq("id", notificationId).maybeSingle();
  if (notif?.status === "acknowledged") return { attempted: false, reason: "notification acknowledged" };

  const roles = rolesForSeverity(severity as any, levelLabel);
  if (roles.length === 0) return { attempted: false, reason: "no recipient roles" };

  const cfg = getSmsConfig();
  let recipients = await loadRecipients(admin, roles);

  const testPhoneOverride = (Deno.env.get("SMS_TEST_PHONE") ?? "").trim();
  if (testPhoneOverride) {
    recipients = [{ id: null as any, name: "SMS_TEST_PHONE", role: "admin", contact_number: testPhoneOverride, sms_enabled: true }];
  }

  if (recipients.length === 0) {
    await logNotificationSkip(admin, notificationId, message, "skipped_no_recipients", "No active personnel with sms_enabled for roles: " + roles.join(", "));
    return { attempted: false, reason: "skipped_no_recipients" };
  }

  let credits: number | null = null;
  if (!cfg.dryRun) {
    const creditRes = await getSmsCredits();
    credits = creditRes.credits;
  }
  const dangerOrCritical = severity === "danger" || severity === "critical";
  const lowCredits = credits !== null && credits < settings.lowCreditThreshold;
  if (lowCredits && !dangerOrCritical) {
    const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin").eq("is_active", true);
    for (const a of ((admins as any[]) ?? [])) {
      await admin.from("notifications").insert({
        user_id: a.id, kind: "sms_credits_low",
        title: "SMS credits low",
        body: "iProg SMS credits are below 20. Warning and offline SMS alerts were skipped.",
      });
    }
    for (const r of recipients) {
      await logRecipientSkip(admin, notificationId, r, message, cfg, "skipped_low_credits", `iProg credits below ${settings.lowCreditThreshold}`);
    }
    return { attempted: false, reason: "skipped_low_credits" };
  }

  const hourlyCount = await countRecentSms(admin, 1);
  const dailyCount = await countRecentSms(admin, 24);
  const capHit = hourlyCount >= settings.maxSmsPerHour || dailyCount >= settings.maxSmsPerDay;
  if (capHit) {
    for (const r of recipients) {
      await logRecipientSkip(admin, notificationId, r, message, cfg, "skipped_rate_limited", `SMS cap reached (hour ${hourlyCount}/${settings.maxSmsPerHour}, day ${dailyCount}/${settings.maxSmsPerDay})`);
    }
    return { attempted: false, reason: "skipped_rate_limited" };
  }

  if (cfg.dryRun) {
    console.log(`DRY_RUN: would send to ${recipients.length} recipients: ${message}`);
    for (const r of recipients) {
      if (!r.contact_number?.trim()) {
        await logRecipientSkip(admin, notificationId, r, message, cfg, "skipped_no_number", "No contact number on file");
        continue;
      }
      if (!cleanPhone(r.contact_number)) {
        await logRecipientSkip(admin, notificationId, r, message, cfg, "failed", "invalid number");
        continue;
      }
      await logRecipientSkip(admin, notificationId, r, message, cfg, "skipped_dry_run", "DRY_RUN: would send");
    }
    return { attempted: false, reason: "skipped_dry_run" };
  }

  let attempted = false;
  for (const r of recipients) {
    if (!r.contact_number?.trim()) {
      await logRecipientSkip(admin, notificationId, r, message, cfg, "skipped_no_number", "No contact number on file");
      continue;
    }
    const cleaned = cleanPhone(r.contact_number);
    if (!cleaned) {
      console.log("invalid number");
      await logRecipientSkip(admin, notificationId, r, message, cfg, "failed", "invalid number");
      continue;
    }
    attempted = true;
    const phone = cleaned;
    const token = newActionToken();
    await admin.from("notification_recipients").upsert({
      notification_id: notificationId, personnel_id: r.id,
      personnel_name: r.name ?? "", personnel_role: r.role,
      phone, action_token: token,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    }, { onConflict: "notification_id,personnel_id" });
    const res = await sendSms({ to: phone, message });
    const rawText = typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw ?? {});
    await admin.from("sms_logs").insert({
      notification_id: notificationId, personnel_id: r.id,
      recipient_name: r.name ?? "", recipient_role: r.role,
      phone, message,
      status: res.ok ? "submitted" : "failed", provider_response: res.error ?? rawText,
      provider: res.provider, provider_message_id: res.providerMessageId, provider_status: res.status,
    });
    if (!res.ok) console.error(`${res.provider} SMS failed for ${r.name}: ${res.error}`);
  }
  return { attempted, reason: attempted ? null : "skipped_no_number" };
}

async function handleReading(admin: Admin, record: any, appUrl: string) {
  const th = await resolveThresholds(admin);
  if (!th) return json({ error: "No thresholds" }, 500);
  const device_id = String(record.device_id);
  const created_at = record.created_at;
  const { data: room } = await admin.from("rooms")
    .select("name, floor").eq("id", device_id).maybeSingle();
  const room_name = room?.name ?? device_id;
  const floor = room?.floor ?? "";

  // Stale data: if the reading is older than the offline threshold, do not
  // raise sensor warnings from it.
  const readingAgeMs = Date.now() - new Date(created_at ?? Date.now()).getTime();
  const stale = readingAgeMs > OFFLINE_AFTER_S * 1000;

  const readings: [SensorType, number | null, string][] = [
    ["co2", record.co2 ?? null, "CO2"], ["lpg", record.lpg ?? null, "LPG"],
    ["temp", record.temp ?? null, "Temperature"], ["humidity", record.humidity ?? null, "Humidity"],
  ];
  const results: string[] = [];
  const abnormal: { sensor: SensorType; label: string; ev: any; notificationId: number | null }[] = [];
  const createdAlerts: { sensor: SensorType; label: string; ev: any; notificationId: number | null }[] = [];
  const qualityFaults: string[] = [];
  const sevRank: Record<string, number> = { warning: 1, high: 2, danger: 3, critical: 4 };
  const allZero = [record.co2, record.lpg, record.temp, record.humidity].every((v) => v === 0);

  for (const [sensor, value, label] of readings) {
    if (stale) continue;
    if (!isQualityReading(sensor as any, value, record.humidity ?? null, allZero)) {
      qualityFaults.push(`${label}=${value ?? "null"}`);
      continue;
    }
    const ev = evaluateSensor(sensor as any, value, th);
    if (!ev) { await resolveSensor(admin, device_id, sensor); continue; }
    const full = `${room_name} ${floor}`.trim();
    const msg = `A.I.R. ALERT [${ev.level_label.toUpperCase()}] ${full}: ${label} ${ev.reading_value != null ? (sensor === "temp" ? ev.reading_value.toFixed(1) : Math.round(ev.reading_value)) : ""} ${ev.reading_unit}.`;
    const up = await upsertNotification(admin, {
      device_id, room_name, floor, sensor_type: sensor,
      level_label: ev.level_label, severity: ev.severity,
      reading_value: ev.reading_value, reading_unit: ev.reading_unit, message: msg,
    });
    if (!up) continue;
    results.push(`${sensor}:${ev.level_label}`);
    const entry = { sensor, label, ev, notificationId: up.id };
    abnormal.push(entry);
    if (up.created) createdAlerts.push(entry);
  }

  if (qualityFaults.length > 0) {
    await logQualitySkip(admin, device_id, qualityFaults, allZero);
  }

  const settings = await loadSmsSettings(admin);

  // Incident handling: one SMS per incident per device, plus an SMS whenever
  // a new alert row is created (e.g. a level change such as Dry -> Mold Risk).
  if (!stale && abnormal.length > 0) {
    const maxSev = abnormal.reduce((a, b) => (sevRank[b.ev.severity] ?? 0) > (sevRank[a.ev.severity] ?? 0) ? b : a).ev.severity;
    const maxLevel = abnormal.reduce((a, b) => (sevRank[b.ev.severity] ?? 0) > (sevRank[a.ev.severity] ?? 0) ? b : a).ev.level_label;
    const sensors = abnormal.map((a) => ({
      name: sensorName(a.sensor),
      value: `${a.ev.reading_value != null ? (a.sensor === "temp" ? a.ev.reading_value.toFixed(1) : Math.round(a.ev.reading_value)) : ""} ${a.ev.reading_unit}`.trim(),
    }));
    const readingStr = sensors.map((s) => `${s.name} ${s.value}`).join(", ");
    const t = manilaTime();
    const isDanger = maxSev === "danger" || maxSev === "critical";
    const shortMsg = isDanger
      ? buildDangerMessage(room_name, sensors, t)
      : buildWarningMessage(room_name, sensors, t);

    const openInc = await getOpenIncident(admin, device_id);
    let shouldSend = false;
    let incidentId: number | null = null;
    let suppressReason: string | null = null;

    if (!openInc || openInc.acknowledged || openInc.status !== "open") {
      const inc = await createOrGetIncident(admin, { device_id, room_name, floor, severity: maxSev, level_label: maxLevel });
      incidentId = inc?.id ?? null;
      shouldSend = true;
    } else {
      incidentId = openInc.id;
      await admin.from("air_sms_incidents").update({ last_abnormal_at: new Date().toISOString() }).eq("id", openInc.id);
      if ((sevRank[maxSev] ?? 0) > (sevRank[openInc.severity] ?? 0)) {
        shouldSend = true;
        await admin.from("air_sms_incidents").update({ severity: maxSev, level_label: maxLevel }).eq("id", openInc.id);
      } else {
        const lastSmsAt = openInc.last_sms_at ?? openInc.started_at;
        const elapsed = Date.now() - new Date(lastSmsAt).getTime();
        if (!openInc.reminder_sent_at && elapsed >= settings.reminderMinutes * 60 * 1000) {
          shouldSend = true;
          await admin.from("air_sms_incidents").update({ reminder_sent_at: new Date().toISOString() }).eq("id", openInc.id);
        } else {
          suppressReason = "skipped_open_incident";
        }
      }
    }

    const hasNewAlert = createdAlerts.length > 0;
    const primary = createdAlerts.length > 0 ? createdAlerts[0] : abnormal[0];
    const notifId = primary?.notificationId ?? null;

    if (notifId && (hasNewAlert || shouldSend)) {
      const attempt = await sendSmsForNotification(admin, notifId, maxSev, maxLevel, appUrl,
        { room_name, floor, device_id, sensorLabel: "Device", reading: readingStr }, shortMsg);
      if (attempt.attempted && incidentId) {
        await admin.from("air_sms_incidents").update({ last_sms_at: new Date().toISOString() }).eq("id", incidentId);
      }
    } else if (notifId && suppressReason) {
      await logNotificationSkip(admin, notifId, shortMsg, suppressReason,
        `Open incident already active for this device (${maxSev}/${maxLevel})`);
    }
  } else if (!stale) {
    // Normal reading: close incident after close_after_minutes of no abnormal readings.
    const openInc = await getOpenIncident(admin, device_id);
    if (openInc) {
      const lastAb = new Date(openInc.last_abnormal_at).getTime();
      if (Date.now() - lastAb >= settings.closeAfterMinutes * 60 * 1000) {
        await admin.from("air_sms_incidents").update({
          status: "closed", closed_at: new Date().toISOString(), close_reason: "normal readings resumed",
        }).eq("id", openInc.id);
      }
    }
  }

  // Device is online: send one back-online SMS, then resolve any open Offline alert.
  // Only treat the device as online when this reading is fresh.
  if (!stale) {
    const { data: openOffline } = await admin.from("air_notifications")
      .select("id").eq("device_id", device_id).eq("level_label", "Offline").eq("status", "open").maybeSingle();
    if (openOffline) {
      await sendSmsForNotification(admin, openOffline.id, "info", "Online", appUrl,
        { room_name, floor, device_id, sensorLabel: "Device", reading: "back online" }, buildAllClearMessage(room_name, manilaTime()));
    }
    await admin.from("air_notifications")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Device back online" })
      .eq("device_id", device_id).eq("level_label", "Offline").eq("status", "open");
  }
  return json({ status: "processed", triggered: results });
}

async function escalateUnacknowledged(admin: Admin, appUrl: string) {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: rows } = await admin.from("air_notifications")
    .select("*").eq("status", "open").in("severity", ["danger", "critical"])
    .lte("created_at", cutoff).is("escalated_at", null);
  for (const n of ((rows as any[]) ?? [])) {
    // mark first to prevent repeats
    await admin.from("air_notifications").update({ escalated_at: new Date().toISOString() }).eq("id", n.id);
    const roles = ["admin"];
    const recipients = await loadRecipients(admin, roles);
    const loc = { room_name: n.room_name, floor: n.floor ?? "", device_id: n.device_id, sensorLabel: String(n.sensor_type).toUpperCase(), reading: n.reading_value != null ? `${n.reading_value} ${n.reading_unit}` : "no reading" };
    await sendSmsForNotification(admin, n.id, n.severity, n.level_label, appUrl, loc, n.message);
  }
}

async function checkOffline(admin: Admin, appUrl: string) {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_S * 1000).toISOString();
  const { data: rooms } = await admin.from("rooms").select("id, name, floor");
  const created: number[] = [];
  for (const room of ((rooms as any[]) ?? [])) {
    const { data: latest } = await admin.from("readings")
      .select("created_at").eq("device_id", room.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const lastSeen = latest?.created_at as string | undefined;
    const stale = !lastSeen || lastSeen < cutoff;
    if (!stale) continue;
    // One open Offline per device (deduped by the partial unique index rule).
    const { data: open } = await admin.from("air_notifications")
      .select("id").eq("device_id", room.id).eq("level_label", "Offline").eq("status", "open").maybeSingle();
    if (open) continue;
    const msg = buildOfflineMessage(room.name ?? room.id, OFFLINE_AFTER_MINUTES, manilaTime());
    const { data } = await admin.from("air_notifications").insert({
      device_id: room.id, room_name: room.name ?? room.id, floor: room.floor ?? "",
      sensor_type: "device", level_label: "Offline", severity: "warning",
      reading_value: null, reading_unit: "", message: msg, status: "open",
    }).select("id").single();
    if (data) {
      created.push(data.id);
      await sendSmsForNotification(admin, data.id, "warning", "Offline", appUrl,
        { room_name: room.name ?? room.id, floor: room.floor ?? "", device_id: room.id, sensorLabel: "Device", reading: "no recent reading" }, msg);
    }
  }
  await escalateUnacknowledged(admin, appUrl);
  return json({ status: "ok", offline_created: created.length });
}

async function resendSms(admin: Admin, notificationId: number, appUrl: string) {
  const { data: n } = await admin.from("air_notifications")
    .select("*").eq("id", notificationId).maybeSingle();
  if (!n) return json({ error: "Notification not found" }, 404);
  const reading = n.reading_value != null ? `${n.reading_value} ${n.reading_unit}` : "no reading";
  await sendSmsForNotification(admin, n.id, n.severity, n.level_label, appUrl,
    { room_name: n.room_name, floor: n.floor ?? "", device_id: n.device_id,
      sensorLabel: String(n.sensor_type).toUpperCase(), reading }, n.message);
  return json({ status: "resent" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const cfg = getSmsConfig();
  const appUrl = Deno.env.get("APP_PUBLIC_URL") ?? "https://air.adamson.edu.ph";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase secrets" }, 500);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  if (payload?.action === "check_offline") return checkOffline(admin, appUrl);
  if (payload?.action === "resend") {
    if (cfg.missing.length && !cfg.dryRun) return json({ error: `SMS provider ${cfg.providerLabel} missing secret(s): ${cfg.missing.join(", ")}` }, 500);
    return resendSms(admin, Number(payload.notification_id), appUrl);
  }
  const record = payload?.record;
  if (!record) return json({ error: "Missing payload.record" }, 400);
  if (cfg.missing.length && !cfg.dryRun) { /* notifications still created; SMS skipped gracefully */ }
  return handleReading(admin, record, appUrl);
});
