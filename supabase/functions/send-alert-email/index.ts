// supabase/functions/send-alert-email/index.ts
//
// Email alert for a safety-threshold breach.
//
// Two things this deliberately does NOT do:
//
//  1. It does not use the ESP32's `severity` column. The firmware grades
//     against tiers compiled into it, which do not change when an admin re-tunes
//     the dashboard configuration. Trusting it would mean the alert email could
//     say "safe" for a value the dashboard is showing as danger. Severity here
//     is computed from the raw readings and the SAVED thresholds.
//
//  2. It does not carry threshold numbers of its own. They are read from
//     public.platform_thresholds through resolve_thresholds(), so an edit on the
//     Platform Safety & System Configuration page changes what this function
//     considers a breach without a redeploy.
//
// Grading rules are identical to src/lib/thresholdConfig.ts:
//   CO2 / LPG   one-sided ascending: >= danger, >= high, >= warning
//   Temperature freeze below / cool below / heat above
//   Humidity    dry below / low below / mold above
// All boundaries are inclusive.

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

type Severity = "ok" | "warning" | "high" | "danger";

const RANK: Record<Severity, number> = { ok: 0, warning: 1, high: 2, danger: 3 };
const LABEL: Record<Severity, string> = {
  ok: "OK",
  warning: "Warning",
  high: "High",
  danger: "Danger",
};

// --------------------------------------------------------------------------
// Thresholds
// --------------------------------------------------------------------------

interface Thresholds {
  co2_warning: number;
  co2_high: number;
  co2_danger: number;
  lpg_warning: number;
  lpg_high: number;
  lpg_danger: number;
  temp_freeze_below: number;
  temp_cool_below: number;
  temp_heat_above: number;
  humidity_dry_below: number;
  humidity_low_below: number;
  humidity_mold_above: number;
  threshold_source?: string;
  effective_from?: string;
}

/** Last-resort values, used only if the database read itself fails. */
const FALLBACK: Thresholds = {
  co2_warning: 1000,
  co2_high: 2000,
  co2_danger: 3500,
  lpg_warning: 1000,
  lpg_high: 2100,
  lpg_danger: 4200,
  temp_freeze_below: 5,
  temp_cool_below: 18,
  temp_heat_above: 35,
  humidity_dry_below: 20,
  humidity_low_below: 30,
  humidity_mold_above: 80,
};

async function loadThresholds(
  admin: ReturnType<typeof createClient>
): Promise<{ thresholds: Thresholds; fromFallback: boolean }> {
  const { data, error } = await admin.rpc("resolve_thresholds", { p_at: null });
  if (error || !data) {
    console.error("resolve_thresholds failed; using built-in fallback values:", error?.message);
    return { thresholds: FALLBACK, fromFallback: true };
  }
  const row = data as Record<string, unknown>;
  const pick = (key: keyof Thresholds) => {
    const v = Number(row[key]);
    return Number.isFinite(v) ? v : FALLBACK[key];
  };
  return {
    thresholds: {
      co2_warning: pick("co2_warning"),
      co2_high: pick("co2_high"),
      co2_danger: pick("co2_danger"),
      lpg_warning: pick("lpg_warning"),
      lpg_high: pick("lpg_high"),
      lpg_danger: pick("lpg_danger"),
      temp_freeze_below: pick("temp_freeze_below"),
      temp_cool_below: pick("temp_cool_below"),
      temp_heat_above: pick("temp_heat_above"),
      humidity_dry_below: pick("humidity_dry_below"),
      humidity_low_below: pick("humidity_low_below"),
      humidity_mold_above: pick("humidity_mold_above"),
      threshold_source: typeof row.threshold_source === "string" ? row.threshold_source : undefined,
      effective_from: typeof row.effective_from === "string" ? row.effective_from : undefined,
    },
    fromFallback: false,
  };
}

// --------------------------------------------------------------------------
// Grading — mirrors src/lib/thresholdConfig.ts
// --------------------------------------------------------------------------

interface Reading {
  device_id: string;
  co2: number | null;
  lpg: number | null;
  temp: number | null;
  humidity: number | null;
  created_at: string;
}

// Boundary semantics must match public.report_is_danger() and the React
  // grading in src/lib/thresholdConfig.ts: inclusive (>=) on the gas danger
  // limits, strict on the two-sided lower bounds. Also guard non-finite
  // values the same way the app does, so a NaN can never grade "ok" here while
  // the dashboard grades it something else.
function gasSeverity(
  v: number | null,
  t: { warning: number; high: number; danger: number }
): Severity {
  if (v == null || !Number.isFinite(v)) return "ok";
  if (v >= t.danger) return "danger";
  if (v >= t.high) return "high";
  if (v >= t.warning) return "warning";
  return "ok";
}

function tempSeverity(v: number | null, t: Thresholds): Severity {
  if (v == null || !Number.isFinite(v)) return "ok";
  if (v < t.temp_freeze_below) return "danger";
  if (v <= t.temp_cool_below) return "warning";
  if (v > t.temp_heat_above) return "danger";
  return "ok";
}

function humiditySeverity(v: number | null, t: Thresholds): Severity {
  if (v == null || !Number.isFinite(v)) return "ok";
  if (v < t.humidity_dry_below) return "danger";
  if (v <= t.humidity_low_below) return "warning";
  if (v > t.humidity_mold_above) return "danger";
  return "ok";
}

export interface DeviceGrade {
  device_id: string;
  roomName: string;
  floor: string;
  severity: Severity;
  /** Per-metric detail, for the email body. */
  breaches: { metric: string; value: number; unit: string; severity: Severity }[];
  measured: number;
  at: string;
}

function gradeDevice(room: { id: string; name: string; floor: string }, r: Reading, t: Thresholds): DeviceGrade {
  const candidates: { metric: string; value: number | null; unit: string; severity: Severity }[] = [
    { metric: "CO2", value: r.co2, unit: "ppm", severity: gasSeverity(r.co2, { warning: t.co2_warning, high: t.co2_high, danger: t.co2_danger }) },
    { metric: "LPG", value: r.lpg, unit: "ppm", severity: gasSeverity(r.lpg, { warning: t.lpg_warning, high: t.lpg_high, danger: t.lpg_danger }) },
    { metric: "Temperature", value: r.temp, unit: "°C", severity: tempSeverity(r.temp, t) },
    { metric: "Humidity", value: r.humidity, unit: "% RH", severity: humiditySeverity(r.humidity, t) },
  ];

  const measured = candidates.filter((c) => c.value != null);
  // A device that has never reported is not a device that is safe, so it is
  // reported as unmeasured rather than graded "ok".
  const severity = measured.reduce<Severity>(
    (worst, c) => (RANK[c.severity] > RANK[worst] ? c.severity : worst),
    "ok"
  );

  return {
    device_id: room.id,
    roomName: room.name,
    floor: room.floor,
    severity,
    breaches: measured
      .filter((c) => c.severity !== "ok")
      .map((c) => ({ metric: c.metric, value: c.value as number, unit: c.unit, severity: c.severity })),
    measured: measured.length,
    at: r.created_at,
  };
}

/**
 * Newest reading per registered device.
 *
 * Devices with no reading at all are returned with severity "ok" and
 * measured = 0 so the caller can distinguish "safe" from "silent".
 */
async function gradeAllDevices(
  admin: ReturnType<typeof createClient>,
  t: Thresholds
): Promise<{ grades: DeviceGrade[]; unmeasured: string[] }> {
  const { data: rooms, error: roomsError } = await admin
    .from("rooms")
    .select("id, name, floor")
    .order("id");
  if (roomsError) throw new Error(`rooms fetch failed: ${roomsError.message}`);

  const list = (rooms ?? []) as { id: string; name: string; floor: string }[];
  if (list.length === 0) return { grades: [], unmeasured: [] };

  // Newest reading per device, queried PER DEVICE.
  //
  // A single `.in(...).order(...).limit(n * 5)` window does not give one row
  // per device: at the firmware's ~3s cadence a chatty device fills the entire
  // window on its own, so a second device that is reporting perfectly well is
  // pushed out of it and gets reported to the safety officer as "has never
  // reported a reading". A false all-clear/false alarm from the safety system
  // is worse than no email at all, so this must be per-device.
  //
  // `severity` is deliberately not selected: grades are recomputed from raw
  // values against the live thresholds rather than trusted from the row.
  const newest = new Map<string, Reading>();
  for (const room of list) {
    const { data: row, error } = await admin
      .from("readings")
      .select("device_id, co2, lpg, temp, humidity, created_at")
      .eq("device_id", room.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<Reading>();
    if (error) throw new Error(`readings fetch failed for ${room.id}: ${error.message}`);
    if (row) newest.set(room.id, row as Reading);
  }

  const grades: DeviceGrade[] = [];
  const unmeasured: string[] = [];
  for (const room of list) {
    const r = newest.get(room.id);
    if (!r) {
      unmeasured.push(room.id);
      grades.push({
        device_id: room.id,
        roomName: room.name,
        floor: room.floor,
        severity: "ok",
        breaches: [],
        measured: 0,
        at: "",
      });
      continue;
    }
    grades.push(gradeDevice(room, r, t));
  }

  return { grades, unmeasured };
}

// --------------------------------------------------------------------------
// Email
// --------------------------------------------------------------------------

function severityColor(s: Severity): string {
  switch (s) {
    case "danger":
      return "#dc2626";
    case "high":
      return "#ea6c2e";
    case "warning":
      return "#d97706";
    default:
      return "#0d9488";
  }
}

function buildEmail(grades: DeviceGrade[], unmeasured: string[], t: Thresholds, sourceNote: string): string {
  const rows = grades
    .filter((g) => g.measured > 0)
    .map((g) => {
      const detail = g.breaches.length
        ? g.breaches
            .map(
              (b) =>
                `${b.metric} ${b.value}${b.unit === "% RH" ? "%" : b.unit} (${LABEL[b.severity]})`
            )
            .join(" &middot; ")
        : "Within limits";
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(g.roomName)}<br>
          <span style="color:#94a3b8;font-size:11px;">${escapeHtml(g.floor)} &middot; ${escapeHtml(g.device_id)}</span></td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;color:${severityColor(
          g.severity
        )};">${LABEL[g.severity]}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${detail}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px;">${escapeHtml(
          g.at
        )}</td>
      </tr>`;
    })
    .join("");

  return `
  <h2 style="margin:0 0 4px;">A.I.R. — environmental safety alert</h2>
  <p style="color:#475569;font-size:13px;margin:0 0 16px;">
    Grades below are computed from the raw readings and the safety limits saved in
    <b>Platform Safety &amp; System Configuration</b>. They do not use the severity
    value reported by the device, which grades against its own fixed tiers.
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;font-family:system-ui,sans-serif;">
    <thead>
      <tr style="text-align:left;color:#94a3b8;font-size:11px;text-transform:uppercase;">
        <th style="padding:6px 10px;">Device</th>
        <th style="padding:6px 10px;">Grade</th>
        <th style="padding:6px 10px;">Reading</th>
        <th style="padding:6px 10px;">Measured at</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${
    unmeasured.length
      ? `<p style="color:#b45309;font-size:12px;margin-top:14px;">
           ${unmeasured.length} registered device(s) have never reported a reading:
           ${unmeasured.map(escapeHtml).join(", ")}. That is an absence of data, not a safe reading.
         </p>`
      : ""
  }
  <p style="color:#94a3b8;font-size:11px;margin-top:18px;border-top:1px solid #e2e8f9;padding-top:8px;">
    Limits applied — CO2 ${t.co2_warning}/${t.co2_high}/${t.co2_danger} ppm &middot;
    LPG ${t.lpg_warning}/${t.lpg_high}/${t.lpg_danger} ppm &middot;
    temperature ${t.temp_freeze_below}/${t.temp_cool_below}/${t.temp_heat_above} °C &middot;
    humidity ${t.humidity_dry_below}/${t.humidity_low_below}/${t.humidity_mold_above} % RH.
    ${sourceNote}
  </p>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

async function sendEmail(to: string[], subject: string, html: string): Promise<string | null> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_EMAIL_FROM") ?? "A.I.R. <onboarding@resend.dev>";
  if (!apiKey) return "RESEND_API_KEY not configured";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) return await res.text();
  return null;
}

// --------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("ALERT_WEBHOOK_SECRET");
  if (!secret) return json({ error: "ALERT_WEBHOOK_SECRET not configured" }, 500);
  if ((req.headers.get("Authorization") ?? "") !== `Bearer ${secret}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Missing Supabase service env" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  try {
    const { thresholds, fromFallback } = await loadThresholds(admin);
    const { grades, unmeasured } = await gradeAllDevices(admin, thresholds);

    const breaching = grades.filter((g) => g.measured > 0 && g.severity !== "ok");
    const worst = breaching.reduce<Severity>(
      (w, g) => (RANK[g.severity] > RANK[w] ? g.severity : w),
      "ok"
    );

    // `dry_run` lets the caller (and a test) see exactly what would be graded
    // and sent without sending anything.
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const dryRun = body.dry_run === true;

    const sourceNote = fromFallback
      ? "These limits could NOT be read from the database for this run; the built-in reference values were used. Check the alert job."
      : `Source: ${thresholds.threshold_source ?? "current"} configuration, effective ${thresholds.effective_from ?? "unknown"}.`;

    const summary = {
      ok: true,
      dry_run: dryRun,
      thresholds_source: fromFallback ? "built-in fallback" : thresholds.threshold_source ?? "current",
      graded: grades.length,
      unmeasured_devices: unmeasured,
      worst_severity: worst,
      breaching_devices: breaching.map((g) => ({
        device_id: g.device_id,
        room: g.roomName,
        severity: g.severity,
        breaches: g.breaches,
      })),
      email_sent: false,
    };

    if (breaching.length === 0) {
      return json({ ...summary, message: "No device crossed a configured threshold; no email sent." });
    }

    const recipients = (Deno.env.get("ALERT_EMAIL_TO") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (dryRun || recipients.length === 0) {
      return json({
        ...summary,
        message: dryRun
          ? "Dry run: no email sent."
          : "ALERT_EMAIL_TO not configured; no email sent.",
      });
    }

    const html = buildEmail(grades, unmeasured, thresholds, sourceNote);
    const subject = `[A.I.R.] ${worst.toUpperCase()} — ${breaching.length} device(s) over threshold`;
    const sendError = await sendEmail(recipients, subject, html);
    // 200 even when the mail provider failed. The grading itself succeeded and
    // is returned in the body; returning 5xx here invites the caller's retry
    // logic (or the platform's) to re-run the whole alert and turn one mail
    // outage into a flood of duplicate safety emails.
    if (sendError) return json({ ...summary, email_sent: false, error: sendError });

    return json({ ...summary, email_sent: true, recipients });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("send-alert-email failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});