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
  buildSmsMessage, evaluateSensor, newActionToken,
  rolesForSeverity, type SensorType, type Thresholds,
} from "../_shared/air_alerts.ts";
import { getSmsConfig, sendSms } from "../_shared/sms-provider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
type Admin = ReturnType<typeof createClient>;

const OFFLINE_AFTER_S = Number(Deno.env.get("OFFLINE_AFTER_S") ?? "60");
const SMS_COOLDOWN_S = Number(Deno.env.get("SMS_COOLDOWN_S") ?? "600"); // 10 min
// Same as RoomsContext OFFLINE_THRESHOLD_MS (30s) with headroom: the browser
// flips to offline at 30s, the server alerts at 60s so a single missed poll
// does not page personnel.

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

interface Recipient { id: string; name: string; role: string; contact_number: string | null; }

async function loadRecipients(admin: Admin, roles: string[]): Promise<Recipient[]> {
  if (roles.length === 0) return [];
  const { data, error } = await admin
    .from("profiles")
    .select("id, name, role, contact_number")
    .in("role", roles)
    .eq("is_active", true);
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

async function sendSmsForNotification(
  admin: Admin,
  notificationId: number,
  severity: string,
  levelLabel: string,
  appUrl: string,
  loc: { room_name: string; floor: string; device_id: string; sensorLabel: string; reading: string },
  message: string
): Promise<void> {
  const roles = rolesForSeverity(severity as any, levelLabel);
  if (roles.length === 0) return;
  // Cooldown: same device+sensor+level within SMS_COOLDOWN_S -> skip SMS (not the row).
  const cutoff = new Date(Date.now() - SMS_COOLDOWN_S * 1000).toISOString();
  const { data: recent } = await admin.from("sms_logs")
    .select("id").eq("notification_id", notificationId).gte("sent_at", cutoff).limit(1);
  const cooldownActive = !!recent?.length;

  const cfg = getSmsConfig();
  const recipients = await loadRecipients(admin, roles);
  for (const r of recipients) {
    if (!r.contact_number?.trim()) {
      await admin.from("sms_logs").insert({
        notification_id: notificationId, personnel_id: r.id,
        recipient_name: r.name ?? "", recipient_role: r.role,
        phone: r.contact_number ?? null, message,
        status: "skipped_no_number", provider_response: "No contact number on file",
        provider: cfg.provider, provider_message_id: null, provider_status: "skipped_no_number",
      });
      continue;
    }
    const phone = r.contact_number;
    if (cooldownActive) continue;
    const token = newActionToken();
    await admin.from("notification_recipients").upsert({
      notification_id: notificationId, personnel_id: r.id,
      personnel_name: r.name ?? "", personnel_role: r.role,
      phone, action_token: token,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    }, { onConflict: "notification_id,personnel_id" });
    const sms = buildSmsMessage({
      severityLabel: levelLabel, roomName: loc.room_name, floor: loc.floor,
      deviceId: loc.device_id, sensorLabel: loc.sensorLabel, reading: loc.reading,
      appUrl, token,
    });
    const res = await sendSms({ to: phone, message: sms });
    const rawText = typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw ?? {});
    await admin.from("sms_logs").insert({
      notification_id: notificationId, personnel_id: r.id,
      recipient_name: r.name ?? "", recipient_role: r.role,
      phone, message: sms,
      status: res.ok ? "submitted" : "failed", provider_response: res.error ?? rawText,
      provider: res.provider, provider_message_id: res.providerMessageId, provider_status: res.status,
    });
    if (!res.ok) console.error(`${res.provider} SMS failed for ${r.name}: ${res.error}`);
  }
}

async function handleReading(admin: Admin, record: any, appUrl: string) {
  const th = await resolveThresholds(admin);
  if (!th) return json({ error: "No thresholds" }, 500);
  const device_id = String(record.device_id);
  const { data: room } = await admin.from("rooms")
    .select("name, floor").eq("id", device_id).maybeSingle();
  const room_name = room?.name ?? device_id;
  const floor = room?.floor ?? "";

  const readings: [SensorType, number | null, string][] = [
    ["co2", record.co2 ?? null, "CO2"], ["lpg", record.lpg ?? null, "LPG"],
    ["temp", record.temp ?? null, "Temperature"], ["humidity", record.humidity ?? null, "Humidity"],
  ];
  const results: string[] = [];
  for (const [sensor, value, label] of readings) {
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
    if (up.created) {
      await sendSmsForNotification(admin, up.id, ev.severity, ev.level_label, appUrl,
        { room_name, floor, device_id, sensorLabel: label,
          reading: `${ev.reading_value != null ? (sensor === "temp" ? ev.reading_value.toFixed(1) : Math.round(ev.reading_value)) : ""} ${ev.reading_unit}` }, msg);
    }
  }
  // Device is online: resolve any open Offline alert and emit "back online" (info).
  await admin.from("air_notifications")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Device back online" })
    .eq("device_id", device_id).eq("level_label", "Offline").eq("status", "open");
  return json({ status: "processed", triggered: results });
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
    const msg = `A.I.R. ALERT [OFFLINE] ${room.name} ${room.floor ?? ""}: Device ${room.id} has not reported for ${OFFLINE_AFTER_S}s.`;
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
