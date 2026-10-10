// ============================================================================
// supabase/functions/daily-report/index.ts
//
// Generates and returns a downloadable PDF for ONE device on ONE Asia/Manila
// calendar day. Invoked by the Reports page "Download Daily PDF" button.
//
// Two source modes, and the PDF says which one it used:
//
//   raw      - raw `readings` rows still exist for that day. The appendix
//              lists every row, paginated.
//   archived - raw rows were already deleted by the retention job. Only
//              daily_summaries + graph_buckets remain. The PDF is labelled
//              as aggregated data throughout and contains no row-level appendix,
//              because none exists any more.
//
// Authorization: the caller must present a valid Supabase user JWT AND that
// user must be an approved admin, matching the RoleRoute allow=["admin"] guard
// in App.tsx and the RLS policies on monthly-reports / daily_summaries.
// The service-role key is used only here, on the server.
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";

import {
  AdminClient,
  COLORS,
  DailyRow,
  EXPECTED_SAMPLE_SECONDS,
  MONTHLY_BUCKET,
  MetricKey,
  MonthStats,
  PdfBuilder,
  Thresholds,
  buildAnalysis,
  fmtTs,
  humanDate,
  isDangerRow,
  manilaDayEndIso,
  manilaDayStartIso,
  manilaDateString,
  num,
  streamReadings,
  triggeredBy,
  uploadAndVerify,
} from "../_shared/reporting.ts";

const BUCKET = MONTHLY_BUCKET;

/** 5-minute buckets for a single-day graph: 288 points, readable at A4 width.
 *  The scheduled job only maintains hourly buckets, so they are refreshed here
 *  on demand - otherwise a one-day graph would be a 24-point step function. */
const DAY_BUCKET_SECONDS = 300;

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    return json({ error: "Missing Supabase environment variables" }, 500);
  }

  // ---- Verify the caller's identity ---------------------------------------
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return json({ error: "Missing Authorization header" }, 401);
  }
  const token = header.slice("Bearer ".length).trim();

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userData?.user) {
    return json({ error: "Invalid or expired session" }, 401);
  }
  const userId = userData.user.id;

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: profile } = await admin
    .from("profiles")
    .select("role, account_status")
    .eq("id", userId)
    .maybeSingle();

  if (!profile || profile.role !== "admin" || profile.account_status !== "approved") {
    return json({ error: "You are not authorized to download reports" }, 403);
  }

  // ---- Request ------------------------------------------------------------
  let body: { device_id?: string; day?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const deviceId = body.device_id;
  const day = body.day;

  if (!deviceId || typeof deviceId !== "string") {
    return json({ error: "device_id is required" }, 400);
  }
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return json({ error: "day must be a YYYY-MM-DD Asia/Manila calendar date" }, 400);
  }

  // A future Manila date cannot have readings. Reject it rather than emitting
  // an empty PDF that could be mistaken for a day with no problems.
  const todayManila = manilaDateString(new Date().toISOString());
  if (day > todayManila) {
    return json(
      {
        error: `${day} is in the future (today is ${todayManila} in Asia/Manila). ` +
          `No readings can exist for a date that has not happened yet.`,
      },
      400
    );
  }

  try {
    return json(await buildDailyReport(admin, deviceId, day));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[daily-report] ${deviceId} ${day} failed: ${message}`);
    return json({ error: message }, 500);
  }
});

// ============================================================================

async function buildDailyReport(
  admin: AdminClient,
  deviceId: string,
  day: string
) {
  // Rebuild this day's aggregates BEFORE reading them, so a day opened before
  // the nightly cron caught up still reports correctly. Both calls are
  // upserts keyed on the day, so repeating them is harmless, and both are
  // no-ops when the day's raw rows have already been deleted - in that case
  // the stored daily_summaries and graph_buckets are returned unchanged, which
  // is exactly what keeps an archived date useful.
  const [summaryRefresh, bucketRefresh] = await Promise.all([
    admin.rpc("refresh_daily_summaries", {
      p_from: day,
      p_to: day,
      p_expected_sample_seconds: EXPECTED_SAMPLE_SECONDS,
    }),
    admin.rpc("refresh_graph_buckets", {
      p_from: day,
      p_to: day,
      p_bucket_seconds: DAY_BUCKET_SECONDS,
    }),
  ]);

  for (const [label, res] of [
    ["daily_summaries", summaryRefresh],
    ["graph_buckets", bucketRefresh],
  ] as const) {
    if (res.error) {
      // Not fatal. The stored aggregates are still valid, just possibly
      // slightly stale, and the PDF labels its graphs as bucket averages
      // either way.
      console.warn(`[daily-report] ${label} refresh for ${day} failed: ${res.error.message}`);
    }
  }

  // Single RPC gives us the summary, graph buckets and the raw/archived flag.
  const { data: bundleRaw, error: bundleError } = await admin.rpc("daily_report_bundle", {
    p_device_id: deviceId,
    p_day: day,
  });
  if (bundleError) throw new Error(`daily_report_bundle failed: ${bundleError.message}`);

  const bundle = bundleRaw as {
    device_name: string;
    device_floor: string;
    source: "raw" | "archived" | "none";
    raw_reading_count: number;
    summary: Record<string, unknown> | null;
    graph_buckets: Record<string, unknown>[];
  };

  if (bundle.source === "none") {
    return {
      ok: false,
      status: "no_data" as const,
      day,
      device_id: deviceId,
      message:
        "No readings were recorded for this device on this date, and no archived summary exists for it. " +
        "This is a day with no data, which is different from a day with data that had no danger readings.",
    };
  }

  const deviceName = bundle.device_name;
  const deviceFloor = bundle.device_floor;
  const isRaw = bundle.source === "raw";
  const startIso = manilaDayStartIso(day);
  const endIso = manilaDayEndIso(day);

  const summary = bundle.summary ?? {};
  const thresholds = (summary.thresholds_used as Thresholds) ?? (await resolveCurrent(admin, day));

  // ---- Stats. Raw mode counts the actual rows; archived mode uses the
  //      stored aggregate, which is the only thing that exists.
  let stats: MonthStats;
  let daily: DailyRow[];

  if (isRaw) {
    const { data: statsRaw, error } = await admin.rpc("monthly_stats", {
      p_device_id: deviceId,
      p_month_start: `${day.slice(0, 7)}-01`,
    });
    if (error) throw new Error(`monthly_stats failed: ${error.message}`);
    const month = statsRaw as unknown as MonthStats;
    stats = {
      ...month,
      reading_count: Number(summary.reading_count ?? 0),
      danger_reading_count: Number(summary.danger_readings ?? 0),
      first_reading_at: (summary.first_reading_at as string) ?? null,
      last_reading_at: (summary.last_reading_at as string) ?? null,
    };
  } else {
    stats = {
      reading_count: Number(summary.reading_count ?? 0),
      danger_reading_count: Number(summary.danger_readings ?? 0),
      first_reading_at: (summary.first_reading_at as string) ?? null,
      last_reading_at: (summary.last_reading_at as string) ?? null,
      metrics: {
        co2: {
          unit: "ppm",
          count: Number(summary.co2_count ?? 0),
          min: nOrNull(summary.co2_min),
          max: nOrNull(summary.co2_max),
          avg: nOrNull(summary.co2_avg),
        },
        lpg: {
          unit: "ppm",
          count: Number(summary.lpg_count ?? 0),
          min: nOrNull(summary.lpg_min),
          max: nOrNull(summary.lpg_max),
          avg: nOrNull(summary.lpg_avg),
        },
        temp: {
          unit: "°C",
          count: Number(summary.temp_count ?? 0),
          min: nOrNull(summary.temp_min),
          max: nOrNull(summary.temp_max),
          avg: nOrNull(summary.temp_avg),
        },
        humidity: {
          unit: "%",
          count: Number(summary.humidity_count ?? 0),
          min: nOrNull(summary.humidity_min),
          max: nOrNull(summary.humidity_max),
          avg: nOrNull(summary.humidity_avg),
        },
      },
    };
  }

  daily = [
    {
      day,
      reading_count: Number(summary.reading_count ?? 0),
      coverage_pct: Number(summary.coverage_pct ?? 0),
      expected_count: Number(summary.expected_count ?? 0),
      first_reading_at: (summary.first_reading_at as string) ?? null,
      last_reading_at: (summary.last_reading_at as string) ?? null,
      co2_avg: nOrNull(summary.co2_avg),
      co2_max: nOrNull(summary.co2_max),
      lpg_avg: nOrNull(summary.lpg_avg),
      lpg_max: nOrNull(summary.lpg_max),
      temp_avg: nOrNull(summary.temp_avg),
      temp_max: nOrNull(summary.temp_max),
      humidity_avg: nOrNull(summary.humidity_avg),
      humidity_max: nOrNull(summary.humidity_max),
      danger_readings: Number(summary.danger_readings ?? 0),
      danger_by_metric: (summary.danger_by_metric as Record<string, number>) ?? {},
    },
  ];

  // ---- Graph series -------------------------------------------------------
  const seriesFor = (m: MetricKey) =>
    bundle.graph_buckets.map((b) => {
      const v = b[`${m}_avg`];
      return {
        t: new Date(b.bucket_start as string).getTime(),
        v: v === null || v === undefined ? null : Number(v),
      };
    });

  // ---- Analysis -----------------------------------------------------------
  const analysis = buildAnalysis({
    scopeLabel: humanDate(day),
    deviceName,
    deviceFloor,
    stats,
    daily,
    thresholds,
    totalDays: 1,
    daysWithData: Number(summary.reading_count ?? 0) > 0 ? 1 : 0,
  });

  // ---- Render -------------------------------------------------------------
  const generatedAt = new Date();
  const b = await PdfBuilder.create(
    "A.I.R. Sensor Monitoring System",
    `Daily report | ${deviceName} (${deviceId}) | ${day}`
  );

  b.page.drawText("Daily Environmental Report", {
    x: 40,
    y: b.y - 20,
    size: 20,
    font: b.bold,
    color: COLORS.ink,
  });
  b.space(30);

  b.text(humanDate(day), { size: 14, bold: true, color: COLORS.teal });
  b.space(4);
  b.text(`Device: ${deviceName} (${deviceId})    Room location: ${deviceFloor}`, { size: 10 });
  b.space(2);
  b.text(`Report generated: ${fmtTs(generatedAt.toISOString())} (Asia/Manila)`, { size: 10 });
  b.space(12);

  // Source banner - the single most important thing to get right on this PDF.
  b.heading("Data source");
  if (isRaw) {
    b.text(
      `This report was built from the raw recorded readings for ${day} ` +
        `(${stats.reading_count.toLocaleString("en-US")} rows, retrieved with pagination). ` +
        `Every reading is listed in the appendix.`,
      { size: 9.3 }
    );
  } else {
    b.note(
      "AGGREGATED DATA - NOT RAW READINGS. The raw reading rows for this date have already been " +
        "removed by the retention policy, which only runs after the monthly archive for that month was " +
        "generated, saved, and verified. The figures and graphs below are pre-computed daily aggregates " +
        "(counts, minimums, maximums, averages and danger-reading counts) and time-bucketed averages. " +
        "Individual readings cannot be listed because they no longer exist; use the companion CSV from " +
        "the monthly report if row-level data is required."
    );
  }

  // ---- Headline -----------------------------------------------------------
  b.heading("Summary");
  b.text(
    `Readings recorded: ${stats.reading_count.toLocaleString("en-US")}    |    ` +
      `Readings that reached a danger threshold: ${stats.danger_reading_count.toLocaleString("en-US")}`,
    { size: 10, bold: true }
  );
  b.space(4);
  b.text(
    `Data coverage: ${Number(summary.coverage_pct ?? 0).toFixed(1)}% of the expected ${Number(
      summary.expected_count ?? 0
    ).toLocaleString("en-US")} readings for the full day` +
      (Number(summary.coverage_pct ?? 0) < 100
        ? `. ${(100 - Number(summary.coverage_pct)).toFixed(1)}% of the day had no recorded readings, and what happened during those periods is unknown from this data.`
        : `. The day is fully covered by recorded readings.`),
    { size: 9.5 }
  );
  b.space(10);

  if (Number(summary.reading_count ?? 0) === 0) {
    b.note(
      "No readings were recorded for this device on this date. This is different from a day on which " +
        "readings were recorded but none reached a danger threshold. No condition can be concluded either way."
    );
  }

  // ---- Statistics ---------------------------------------------------------
  b.heading("Readings summary");
  b.table(
    [
      { header: "Metric", width: 130, align: "left" },
      { header: "Min", width: 88, align: "right" },
      { header: "Max", width: 88, align: "right" },
      { header: "Average", width: 88, align: "right" },
      { header: "Unit", width: 62, align: "left" },
      { header: "Measurements", width: 96, align: "right" },
    ],
    (["co2", "lpg", "temp", "humidity"] as MetricKey[]).map((m) => {
      const s = stats.metrics[m];
      const digits = m === "temp" ? 1 : 0;
      return [
        { co2: "CO2", lpg: "LPG", temp: "Temperature", humidity: "Humidity" }[m],
        num(s?.min, digits),
        num(s?.max, digits),
        num(s?.avg, digits),
        s?.unit ?? "",
        (s?.count ?? 0).toLocaleString("en-US"),
      ];
    })
  );
  b.note(
    "Statistics are computed only from recorded measurements. The Measurements column shows how many " +
      "real samples backed each figure; a sensor that returned nothing contributes nothing and is never " +
      "counted as a zero."
  );

  // ---- Analysis -----------------------------------------------------------
  b.heading("Analysis");
  b.text(
    "This describes only what is present in the recorded data. It does not infer causes, health effects, " +
      "or future conditions, and it does not treat missing readings as safe.",
    { size: 8.6, italic: true, color: COLORS.muted }
  );
  b.space(6);
  for (const p of analysis.paragraphs) {
    b.text(p, { size: 9.3, indent: 6 });
    b.space(6);
  }

  // ---- Graphs -------------------------------------------------------------
  b.heading("Trends");
  b.text(
    "Plotted from time-bucketed averages of the recorded readings (aggregated data, not individual " +
      "samples). Blank stretches are periods with no recorded readings.",
    { size: 8.6, italic: true, color: COLORS.muted }
  );
  b.space(6);
  const xLabel = (t: number) => fmtTs(new Date(t).toISOString());
  for (const m of ["co2", "lpg", "temp", "humidity"] as MetricKey[]) {
    if ((stats.metrics[m]?.count ?? 0) === 0) {
      b.subheading(`${m.toUpperCase()} trend`);
      b.text("No measurements were recorded for this metric on this date.", {
        size: 9,
        italic: true,
        color: COLORS.muted,
      });
      continue;
    }
    b.chart(
      { co2: "CO2", lpg: "LPG", temp: "Temperature", humidity: "Humidity" }[m],
      m,
      thresholds,
      seriesFor(m),
      xLabel
    );
  }

  b.dangerBars(daily, () => day);

  // ---- Appendix (raw mode only) ------------------------------------------
  if (isRaw) {
    b.drawFooter();
    b.addPage();
    b.heading("Appendix - every reading recorded on this date");

    const columns = [
      { header: "Timestamp (Asia/Manila)", width: 168, align: "left" as const },
      { header: "Device", width: 116, align: "left" as const },
      { header: "Room / Floor", width: 168, align: "left" as const },
      { header: "CO2 (ppm)", width: 74, align: "right" as const },
      { header: "LPG (ppm)", width: 74, align: "right" as const },
      { header: "Temp (C)", width: 68, align: "right" as const },
      { header: "Humidity (%)", width: 78, align: "right" as const },
      { header: "Severity", width: 62, align: "right" as const },
      { header: "Assessment", width: 84, align: "left" as const },
    ];

    let tableRows: string[][] = [];
    let first = true;
    let total = 0;

    for await (const row of streamReadings(admin, { deviceId, startIso, endIso })) {
      total += 1;
      const danger = isDangerRow(row, thresholds);
      tableRows.push([
        fmtTs(row.created_at),
        row.device_id,
        `${deviceName} / ${deviceFloor}`,
        row.co2 !== null ? num(row.co2, 0) : "-",
        row.lpg !== null ? num(row.lpg, 0) : "-",
        row.temp !== null ? num(row.temp, 1) : "-",
        row.humidity !== null ? num(row.humidity, 0) : "-",
        row.severity !== null ? String(row.severity) : "not recorded",
        danger ? `DANGER: ${triggeredBy(row, thresholds).join(", ")}` : "within thresholds",
      ]);

      // Flush in chunks so a very busy day does not build one enormous
      // in-memory table. Nothing is dropped: the loop continues to the end.
      if (tableRows.length >= 3000) {
        if (first) {
          b.table(columns, tableRows, { headerRepeatLabel: "Appendix - readings" });
          first = false;
        } else {
          b.table(columns, tableRows, {});
        }
        tableRows = [];
      }
    }

    if (tableRows.length > 0) {
      b.table(columns, tableRows, first ? { headerRepeatLabel: "Appendix - readings" } : {});
    }
    if (total === 0) {
      b.text("No readings were recorded on this date.", { size: 9, italic: true, color: COLORS.muted });
    }
  }

  const bytes = await b.finish();

  // ---- Store, verify, hand back a short-lived signed URL ------------------
  const path = `daily/${deviceId}/${day}.pdf`;
  const result = await uploadAndVerify(admin, BUCKET, path, bytes, "application/pdf");
  if (!result.ok) throw new Error(`daily PDF ${result.reason}`);

  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, 300);
  if (signError) throw new Error(`createSignedUrl failed: ${signError.message}`);

  return {
    ok: true,
    status: (isRaw ? "raw" : "archived") as "raw" | "archived",
    day,
    device_id: deviceId,
    device_name: deviceName,
    reading_count: stats.reading_count,
    danger_reading_count: stats.danger_reading_count,
    coverage_pct: Number(summary.coverage_pct ?? 0),
    size_bytes: bytes.length,
    signed_url: signed?.signedUrl ?? null,
    message: isRaw
      ? "Daily PDF generated from the raw recorded readings."
      : "Daily PDF generated from archived aggregates. The raw readings for this date have already been deleted.",
  };
}

async function resolveCurrent(
  admin: AdminClient,
  day: string
): Promise<Thresholds> {
  const { data, error } = await admin.rpc("resolve_thresholds", {
    p_at: manilaDayStartIso(day),
  });
  if (error) throw new Error(`resolve_thresholds failed: ${error.message}`);
  return data as Thresholds;
}

function nOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}