/**
 * supabase/functions/send-sms-alert/index.ts
 *
 * Database webhook: called by Supabase on INSERT to the readings table.
 * Sends an SMS via iProg when a sensor reading reaches a danger level.
 *
 * Rules:
 *  - Reads thresholds from the database (room_thresholds > platform_thresholds)
 *  - Role-based recipient filtering: Maintenance gets Elevated Gas and above,
 *    Security/Admin get Danger and Critical only
 *  - Cooldown: no same-device+sensor+level within 10 minutes (escalation bypasses)
 *  - Escalation (e.g. Danger → Critical) always sends immediately
 *  - One phone failure does not stop others; failures are logged per-recipient
 *  - Message body kept short (<100 chars) because iProg adds header &
 *    footer automatically. Do NOT repeat "A.I.R" or college name in body.
 *  - Asia/Manila time
 *  - iProg API: POST https://sms.iprogtech.com/api/v1/sms_messages
 *    Body: { api_token, phone_number: "09XXXXXXXXX", message }
 */

import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";

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

// ---------------------------------------------------------------------------
// Cooldown constant: milliseconds
// ---------------------------------------------------------------------------
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Threshold evaluation – mirrors the app's severity logic but returns a level
// string ("Elevated Gas" | "Danger" | "Critical") rather than a numeric grade.
// ---------------------------------------------------------------------------

function evaluateLevel(
  sensor: string,
  value: number | null,
  th: Record<string, { warning: number; high: number; danger: number }>
): string | null {
  if (value == null || !Number.isFinite(value)) return null;

  const t = th[sensor];
  if (!t) return null;

  if (sensor === "lpg") {
    if (value >= 2100 && value <= 4000) return "Danger";
    if (value > 4000) return "Critical";
    if (value >= 1000 && value <= 2000) return "Elevated Gas";
    return null; // safe
  }

  if (sensor === "co2") {
    if (value > 3500) return "Danger";
    return null;
  }

  if (sensor === "temp") {
    if (value < 5 || value > 35) return "Danger";
    return null;
  }

  if (sensor === "humidity") {
    if (value < 20 || value > 80) return "Danger";
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Load thresholds from database: room-specific override then global fallback
// ---------------------------------------------------------------------------

async function loadThresholds(
  admin: ReturnType<typeof createClient>,
  roomId: string
): Promise<Record<string, { warning: number; high: number; danger: number }>> {
  // 1) Check per-room overrides
  const { data: roomTh, error: roomThError } = await admin
    .from("room_thresholds")
    .select("*")
    .eq("room_id", roomId)
    .maybeSingle();

  if (!roomThError && roomTh && roomTh.active) {
    return {
      lpg: {
        warning: roomTh.lpg_warning ?? undefined,
        high: roomTh.lpg_high ?? undefined,
        danger: roomTh.lpg_danger ?? undefined,
      },
      co2: {
        warning: roomTh.co2_warning ?? undefined,
        high: roomTh.co2_high ?? undefined,
        danger: roomTh.co2_danger ?? undefined,
      },
      temp: {
        warning: roomTh.temp_freeze_below ?? undefined,
        high: roomTh.temp_cool_below ?? undefined,
        danger: roomTh.temp_heat_above ?? undefined,
      },
      humidity: {
        warning: roomTh.humidity_dry_below ?? undefined,
        high: roomTh.humidity_low_below ?? undefined,
        danger: roomTh.humidity_mold_above ?? undefined,
      },
    };
  }

  // 2) Fall back to global platform_thresholds (via resolve_thresholds RPC)
  const { data: global, error: globalError } = await admin.rpc("resolve_thresholds", {
    p_at: null,
  });
  if (globalError || !global) {
    return {
      lpg: { warning: 1000, high: 2000, danger: 3500 },
      co2: { warning: 2000, high: 3000, danger: 3500 },
      temp: { warning: 5, high: 35, danger: 35 },
      humidity: { warning: 20, high: 80, danger: 80 },
    };
  }

  const row = global as Record<string, unknown>;
  const pick = (key: string) => {
    const v = Number(row[key]);
    return Number.isFinite(v) ? v : undefined;
  };

  return {
    lpg: { warning: pick("lpg_warning"), high: pick("lpg_high"), danger: pick("lpg_danger") },
    co2: { warning: pick("co2_warning"), high: pick("co2_high"), danger: pick("co2_danger") },
    temp: {
      warning: pick("temp_freeze_below"),
      high: pick("temp_cool_below"),
      danger: pick("temp_heat_above"),
    },
    humidity: {
      warning: pick("humidity_dry_below"),
      high: pick("humidity_low_below"),
      danger: pick("humidity_mold_above"),
    },
  };
}

// Helper: convert a column name like "lpg_warning" -> "lpg"
function asciiToKey(col: string): string {
  const map: Record<string, string> = {
    co2_warning: "co2",
    co2_high: "co2",
    co2_danger: "co2",
    lpg_warning: "lpg",
    lpg_high: "lpg",
    lpg_danger: "lpg",
    temp_freeze_below: "temp",
    temp_cool_below: "temp",
    temp_heat_above: "temp",
    humidity_dry_below: "humidity",
    humidity_low_below: "humidity",
    humidity_mold_above: "humidity",
  };
  return map[col] || "";
}

// ---------------------------------------------------------------------------
// Load active alert recipients for the given room, filtered by role.
// ---------------------------------------------------------------------------

async function loadRecipients(
  admin: ReturnType<typeof createClient>,
  roomId: string,
  sensorLevel: string,
  callerRole: "admin" | "maintenance" | "security"
): Promise<{ phone_number: string; role: string }[]> {
  // Load all active recipients; room_ids null means "all rooms"
  const { data: recipients, error: recipientsError } = await admin
    .from("alert_recipients")
    .select("id, name, phone_number, role, room_ids")
    .eq("active", true);

  if (recipientsError || !recipients) return [];

  // Partition recipients by room coverage
  const adminRecipients: string[] = [];
  const maintenanceRecipients: string[] = [];
  const securityRecipients: string[] = [];

  for (const r of recipients as any[]) {
    const coversAll = r.room_ids === null || r.room_ids.length === 0;
    const coversRoom = coversAll || r.room_ids?.some((id: any) => id === roomId);

    if (r.role === "admin" && coversRoom) {
      // Admin gets Danger and Critical only; Elevated Gas is excluded
      if (sensorLevel === "Danger" || sensorLevel === "Critical") {
        adminRecipients.push(r.phone_number);
      }
    } else if (r.role === "maintenance" && coversRoom) {
      // Maintenance gets Elevated Gas and above
      if (
        sensorLevel === "Elevated Gas" ||
        sensorLevel === "Danger" ||
        sensorLevel === "Critical"
      ) {
        maintenanceRecipients.push(r.phone_number);
      }
    } else if (r.role === "security" && coversRoom) {
      // Security gets Danger and Critical only
      if (sensorLevel === "Danger" || sensorLevel === "Critical") {
        securityRecipients.push(r.phone_number);
      }
    }
  }

  return [
    ...adminRecipients.map((p) => ({ phone_number: p, role: "admin" })),
    ...maintenanceRecipients.map((p) => ({ phone_number: p, role: "maintenance" })),
    ...securityRecipients.map((p) => ({ phone_number: p, role: "security" })),
]);

/** Normalize a phone number to iProG's expected "09XXXXXXXXX" format.
 *  Accepts: 09…, 9…, +639…, 639…  Rejects invalid numbers. */
function normalizeIprogPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (!d) return null;
  // Strip country code prefixes to get to the 10-digit national number
  if (d.startsWith("0063")) d = d.slice(4);       // 0063 -> strip
  if (d.startsWith("63") && d.length === 12) d = d.slice(2);  // 639XXXXXXXXX -> 9XXXXXXXXX
  if (d.startsWith("+63") && d.length >= 13) d = d.slice(3);  // +639XXXXXXXXX -> 9XXXXXXXXX
  // Now normalize to 09XXXXXXXXX
  if (d.startsWith("09") && d.length === 11) return d;              // already 09XXXXXXXXX
  if (d.startsWith("9") && d.length === 10) return "0" + d;        // 9XXXXXXXXX -> 09XXXXXXXXX
  if (d.length === 11 && d.startsWith("09")) return d;             // fallback
  // If we have a 10-digit number starting with 9, prepend 0
  if (d.length === 10 && d.startsWith("9")) return "0" + d;
  // Last resort: if 11 digits starting with 09, return as-is
  if (d.length === 11 && d.startsWith("09")) return d;
  return null;
}

/** Send a single iProg SMS with a 10-second timeout using AbortController. */
async function sendIprogSms(phoneNumber: string, message: string): Promise<{
  ok: boolean; response: string; error: string | null;
}> {
  const token = Deno.env.get("IPROG_SMS_API_TOKEN");
  if (!token) return { ok: false, response: "", error: "iProg SMS is not configured" };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch("https://sms.iprogtech.com/api/v1/sms_messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ api_token: token, phone_number: phoneNumber, message }),
    });
    clearTimeout(timeoutId);
    const text = await res.text();

    if (!res.ok) {
      const errMsg = text.slice(0, 300);
      // Map iProg HTTP status to readable messages
      if (res.status === 401 || res.status === 403) {
        return { ok: false, response: "", error: "Invalid or rejected iProg token" };
      }
      if (res.status === 400) {
        return { ok: false, response: "", error: "Invalid phone number" };
      }
      if (res.status === 429 || res.status === 500) {
        return { ok: false, response: "", error: "Insufficient iProg credits" };
      }
      return { ok: false, response: errMsg, error: `iProg error ${res.status}` };
    }
    return { ok: true, response: text.slice(0, 300), error: null };
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      return { ok: false, response: "", error: "iProg unreachable (timeout)" };
    }
    return { ok: false, response: "", error: `Network error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Main handler – Supabase Database Webhook payload
// The payload from a readings INSERT webhook contains payload.record with the
// new row: { id, device_id, co2, lpg, temp, humidity, severity, created_at }
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ---- Webhook auth check ----
  const webhookSecret = Deno.env.get("SMS_ALERT_WEBHOOK_SECRET");
  const authHeader = req.headers.get("authorization") ?? "";
  if (webhookSecret && authHeader !== `Bearer ${webhookSecret}`) {
    return json({ error: "Unauthorized webhook call" }, 401);
  }

  // ---- Read environment secrets ----
  const iprogToken = Deno.env.get("IPROG_SMS_API_TOKEN");
  if (!iprogToken) {
    return json({ error: "iProg SMS is not configured" }, 500);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ---- Parse payload ----
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON payload" }, 400);
  }

  // The webhook payload from Supabase DB webhook:
  // { event: "INSERT", schema: "public", table: "readings", record: { ... } }
  const record = (payload as any)?.record;
  if (!record || typeof record !== "object") {
    return json({ error: "Missing payload.record (new reading row)" }, 400);
  }

  const {
    device_id,
    co2,
    lpg,
    temp,
    humidity,
    created_at,
  } = record as {
    device_id: string;
    co2: number | null;
    lpg: number | null;
    temp: number | null;
    humidity: number | null;
    created_at: string;
  };

  if (!device_id) {
    return json({ error: "Reading has no device_id" }, 400);
  }

  // ---- Look up the room via the device ----
  let { data: roomRow, error: roomError } = await admin
    .from("rooms")
    .select("id, name, floor, type, active")
    .eq("id", device_id)
    .maybeSingle();

  if (roomError || !roomRow) {
    // Fallback: try devices table
    const { data: devRow, error: devError } = await admin
      .from("devices")
      .select("room_id")
      .eq("device_id", device_id)
      .maybeSingle();

    if (devError || !devRow) {
      console.error("Room/device lookup failed:", roomError?.message, devError?.message);
      return json({ error: "Could not determine room for device" }, 404);
    }
    const roomId = devRow.room_id;
    const { data: roomInfo, error: roomInfoError } = await admin
      .from("rooms")
      .select("id, name, active")
      .eq("id", roomId)
      .maybeSingle();

    if (roomInfoError || !roomInfo || !roomInfo.active) {
      return json({ error: "Room not found or inactive" }, 404);
    }
    // Use the device's room as the effective row for the rest of the flow.
    roomRow = { id: roomInfo.id, name: roomInfo.name } as any;
  }

  // Determine alert levels using global thresholds (no room override)
  const thresholds = await loadThresholds(admin, roomRow.id as string);

  // Evaluate each sensor for alert level
  const levels: Record<string, string | null> = {
    lpg: evaluateLevel("lpg", lpg as number, thresholds),
    co2: evaluateLevel("co2", co2 as number, thresholds),
    temp: evaluateLevel("temp", temp as number, thresholds),
    humidity: evaluateLevel("humidity", humidity as number, thresholds),
  };

  // Collect all triggered levels (non-null)
  const triggered: { sensor: string; level: string }[] = [];
  for (const [sensor, level] of Object.entries(levels)) {
    if (level) triggered.push({ sensor, level });
  }

  if (triggered.length === 0) {
    return json({ status: "no_alert", message: "No sensor thresholds exceeded." });
  }

  // ---- Determine the "primary" level for recipient filtering ----
  const levelRank: Record<string, number> = { "Elevated Gas": 1, Danger: 2, Critical: 3 };
  const highestLevel = triggered.reduce<
    | "Elevated Gas" | "Danger" | "Critical" | null
  >((highest, { level }) => {
    const r = levelRank[level] ?? 0;
    const hr = levelRank[highest] ?? 0;
    return r > hr ? level : highest;
  }, null as any);

  if (!highestLevel) {
    return json({ status: "no_alert", message: "No alert levels determined." });
  }

  // ---- Load recipients for the affected room ----
  const allRecipients = await loadRecipients(admin, roomRow.id as string, highestLevel, "admin");

  // ---- Check cooldown for each triggered sensor/level ----
  const cooldownChecks: Record<string, { blocked: boolean; previousLevel?: string }> = {};
  for (const { sensor, level } of triggered) {
    cooldownChecks[sensor] = await checkCooldown(admin, device_id, sensor, level);
  }

  // Build the message using Asia/Manila time
  const nowManila = new Date(
    new Date(created_at).getTime() + 480 * 60 * 1000 // UTC+8 offset
  );
  const dayStr = nowManila.toLocaleDateString("en-PH", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeStr = nowManila.toLocaleTimeString("en-PH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Manila",
  });

  // Message body kept short (<100 chars) because iProg adds header and footer automatically.
  // Format: "Room 106 (AIR-D02): LPG CRITICAL 4200 ppm. 11/10 3:45 PM"
  // iProg prepends "A.I.R - Asian College Air Quality Monitoring System" and
  // appends "Automated alert from A.I.R Monitoring System. Please check...".
  // We keep the body to ~70 chars so the total stays under ~160.
  const msgBase = `${roomRow.name} (${device_id}): ${triggered[0]?.sensor.toUpperCase()} ${triggered[0]?.level.toUpperCase()} ${triggered[0]?.level === "Elevated Gas" ? (lpg ?? co2 ?? temp ?? humidity ?? "??").toString() : (lpg ?? co2 ?? temp ?? humidity ?? "??").toString()} ppm. ${dayStr} ${timeStr}`;

  // Cap the body so even with iProg header+footer the total stays reasonable.
  const maxBodyChars = 70;
  const message = msgBase.length > maxBodyChars
    ? msgBase.slice(0, maxBodyChars) : msgBase;

  // ---- Send SMS to each recipient, handling failures individually ----
  const smsPromises = allRecipients.map(async (recipient) => {
    const { phone_number, role } = recipient;

    // Determine which sensor/level(s) this recipient should get based on role
    const shouldSend = determineIfRecipientGetsLevel(
      role,
      highestLevel,
      triggered
    );
    if (!shouldSend) return null;

    // Check cooldown per recipient - if blocked, skip
    const sensorForLevel = triggered[0]?.sensor ?? "";
    const levelForLevel = triggered[0]?.level ?? "";
    const cooldown = cooldownChecks[sensorForLevel];
    if (cooldown.blocked) {
      // Log the cooldown skip
      await admin.from("alert_log").insert({
        device_id,
        room_id: roomRow.id as string,
        room_name: roomRow.name,
        sensor: sensorForLevel,
        level: levelForLevel,
        sms_status: "skipped_cooldown",
        sms_response: "cooldown active within 10 minutes",
      });
      return null;
    }

    // Normalize phone number to iProG format
    const normalizedPhone = normalizeIprogPhone(phone_number);
    if (!normalizedPhone) {
      // Log the invalid number
      await admin.from("alert_log").insert({
        device_id,
        room_id: roomRow.id as string,
        room_name: roomRow.name,
        sensor: sensorForLevel,
        level: levelForLevel,
        sms_status: "failed",
        sms_response: "Invalid phone number format",
      });
      return {
        name: recipient.name ?? "Unknown",
        role,
        phone_masked: maskPhone(phone_number),
        ok: false,
        error: "Invalid phone number format",
      };
    }

    // Send SMS via iProg
    const result = await sendIprogSms(normalizedPhone, message);

    // Log the attempt
    await admin.from("alert_log").insert({
      device_id,
      room_id: roomRow.id as string,
      room_name: roomRow.name,
      sensor: sensorForLevel,
      level: levelForLevel,
      sms_status: result.ok ? "sent" : "failed",
      sms_response: result.error ?? result.response,
    });

    if (!result.ok) {
      // Never log the token or full phone numbers in error output
      console.error(`${result.error} SMS failed for recipient`);
    }

    return {
      name: recipient.name ?? "Unknown",
      role,
      phone_masked: maskPhone(normalizedPhone),
      ok: result.ok,
      error: result.error ?? null,
    };
  });

  await Promise.allSettled(smsPromises);

  return json({
    status: "processed",
    triggered_sensors: triggered.map((t) => ({
      sensor: t.sensor,
      level: t.level,
    })),
    recipients_notified: allRecipients.length,
    message,
  });
});

// ---------------------------------------------------------------------------
// Cooldown check: look up alert_log for same device_id + sensor + level within
// the cooldown window. Return true if the alert should be blocked by cooldown.
// Escalation (new level > previous level for same device+sensor) bypasses cooldown.
// ---------------------------------------------------------------------------

async function checkCooldown(
  admin: ReturnType<typeof createClient>,
  deviceId: string,
  sensor: string,
  level: string
): Promise<{ blocked: boolean; previousLevel?: string }> {
  const cutoff = new Date(Date.now() - COOLDOWN_MS).toISOString();

  const { data: rows, error } = await admin
    .from("alert_log")
    .select("level, created_at")
    .eq("device_id", deviceId)
    .eq("sensor", sensor)
    .gte("created_at", cutoff);

  if (error || !rows || rows.length === 0) {
    return { blocked: false };
  }

  // Find the most recent entry for this device+sensor
  const sorted = (rows as any[]).sort(
    (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const latest = sorted[0];

  // Escalation: if the new level is higher than the previous, always send
  const levelRank: Record<string, number> = { "Elevated Gas": 1, Danger: 2, Critical: 3 };
  const newRank = levelRank[level] ?? 0;
  const prevRank = levelRank[sorted[0].level] ?? 0;

  if (newRank > prevRank) {
    // Escalation bypasses cooldown
    return { blocked: false, previousLevel: sorted[0].level };
  }

  return { blocked: true, previousLevel: sorted[0].level };
}

/** Determine if a recipient role should get this alert level. */
function determineIfRecipientGetsLevel(
  role: string,
  highestLevel: string | null,
  triggered: { sensor: string; level: string }[]
): boolean {
  if (!highestLevel) return false;

  const levelRank: Record<string, number> = { "Elevated Gas": 1, Danger: 2, Critical: 3 };
  const highestRank = levelRank[highestLevel] ?? 0;

  // Admin/maintenance: check if role includes this level
  if (role === "admin" || role === "maintenance") {
    // Maintenance gets Elevated Gas and above
    if (role === "maintenance") {
      return highestRank >= levelRank["Elevated Gas"];
    }
    // Admin gets Danger and Critical only (Elevated Gas excluded)
    if (role === "admin") {
      return highestRank >= levelRank["Danger"];
    }
  }

  // Security role check
  if (role === "security") {
    return highestRank >= levelRank["Danger"];
  }

  return false;
}