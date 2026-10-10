// ============================================================================
// supabase/functions/run-monthly-archive/index.ts
//
// Scheduled reporting job. Runs on pg_cron regardless of whether anyone has
// the app open.
//
// Flow, in order, per invocation:
//
//   1. refresh_daily_summaries + refresh_graph_buckets for the recent window
//      (and for every month still awaiting archival). Aggregates MUST exist
//      before any raw row can be deleted.
//   2. monthly_report_candidates() -> every complete calendar month with raw
//      readings and no succeeded report yet. Returning every overdue month is
//      what makes a missed run self-heal on the next daily invocation.
//   3. Per candidate: claim_monthly_report() is the single-writer guard. If it
//      returns false another run owns this device-month, so we skip it - that
//      is the no-duplicate-reports guarantee.
//   4. Build the PDF (summary + numbered appendix parts) and the full CSV,
//      upload each, and VERIFY each by listing it back out of Storage.
//   5. complete_monthly_report(verified = true|false).
//   6. Only when verified, delete_readings_for_archived_month() - a SQL-side
//      fail-closed function that independently re-checks archived + verified +
//      fully elapsed + every reading at least one calendar month old +
//      aggregates present.
//
// Note the age rule is per-reading, not per-month: month M's raw rows are only
// eligible from the 1st of the month AFTER next, because the youngest reading
// in M falls on M's last day at 23:59 Manila. Deleting M on the 1st of M+1
// would remove readings that were only hours old. In practice the database
// always holds the current partial month plus the complete previous one.
//
// Any failure at any step: fail_monthly_report() marks the row failed, the raw
// readings are left completely untouched, and the next daily run retries the
// same month without producing a second report.
//
// Authorization: static bearer token (CRON_SECRET) compared against the
// matching Authorization header. No user JWT is involved, so no privileged key
// ever reaches the browser.
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";

import {
  Analysis,
  AdminClient,
  COLORS,
  CSV_HEADER,
  CSV_PREAMBLE,
  DailyRow,
  DEFAULT_APPENDIX_ROWS_PER_PART,
  EXPECTED_SAMPLE_SECONDS,
  MONTHLY_BUCKET,
  MonthStats,
  MetricKey,
  PdfBuilder,
  ReadingRow,
  Thresholds,
  buildAnalysis,
  concatBytes,
  csvRow,
  fmtDateShort,
  fmtTs,
  isDangerRow,
  manilaDateString,
  manilaDayStartIso,
  monthLabel,
  num,
  parseManilaDate,
  streamReadings,
  triggeredBy,
  uploadAndVerify,
} from "../_shared/reporting.ts";

const BUCKET = MONTHLY_BUCKET;

/** Hourly buckets for the monthly trend graphs (~744 points per month). */
const MONTHLY_BUCKET_SECONDS = 3600;

/** How many trailing days to re-aggregate on every run. Covers late-arriving
 *  readings and gives a retry a clean slate. */
const REFRESH_TRAILING_DAYS = 4;

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

function appendixRowsPerPart(): number {
  const raw = Deno.env.get("APPENDIX_ROWS_PER_PART");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_APPENDIX_ROWS_PER_PART;
}

interface Candidate {
  device_id: string;
  month_start: string;
  month_end: string;
  month_label: string;
  reading_count: number;
}

interface DeviceMeta {
  name: string;
  floor: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ---- Authorization -------------------------------------------------------
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) {
    console.error("CRON_SECRET is not configured on this function.");
    return json({ error: "CRON_SECRET not configured" }, 500);
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  // ---- Privileged keys stay on the server ---------------------------------
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    return json({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let mode = "daily";
  try {
    const body = await req.json();
    if (body && typeof body.mode === "string") mode = body.mode;
  } catch {
    // An empty body is fine - default to the full daily maintenance pass.
  }

  const startedAt = new Date();
  const summary = {
    mode,
    started_at: startedAt.toISOString(),
    refreshed: { days: 0, daily_summary_rows: 0, graph_bucket_rows: 0 },
    archived: [] as unknown[],
    failed: [] as unknown[],
    skipped_claimed: 0,
    retention: [] as unknown[],
    duration_ms: 0,
  };

  try {
    // -----------------------------------------------------------------------
    // 1. Refresh durable aggregates.
    // -----------------------------------------------------------------------
    const todayManila = manilaDateString(startedAt.toISOString());
    const fromDate = new Date(parseManilaDate(todayManila));
    fromDate.setUTCDate(fromDate.getUTCDate() - REFRESH_TRAILING_DAYS);
    const refreshFrom = fromDate.toISOString().slice(0, 10);

    const { data: refreshed, error: refreshError } = await admin.rpc(
      "refresh_daily_summaries",
      {
        p_from: refreshFrom,
        p_to: todayManila,
        p_expected_sample_seconds: EXPECTED_SAMPLE_SECONDS,
      }
    );
    if (refreshError) throw new Error(`refresh_daily_summaries failed: ${refreshError.message}`);
    summary.refreshed.daily_summary_rows = Number(refreshed ?? 0);

    const { data: bucketed, error: bucketError } = await admin.rpc(
      "refresh_graph_buckets",
      {
        p_from: refreshFrom,
        p_to: todayManila,
        p_bucket_seconds: MONTHLY_BUCKET_SECONDS,
      }
    );
    if (bucketError) throw new Error(`refresh_graph_buckets failed: ${bucketError.message}`);
    summary.refreshed.graph_bucket_rows = Number(bucketed ?? 0);

    const days = Math.round(
      (parseManilaDate(todayManila).getTime() - parseManilaDate(refreshFrom).getTime()) /
        86_400_000
    );
    summary.refreshed.days = days + 1;

    // -----------------------------------------------------------------------
    // 2. Find every complete month awaiting an archive.
    // -----------------------------------------------------------------------
    const { data: candidates, error: candError } = await admin.rpc(
      "monthly_report_candidates",
      { p_only_month: null }
    );
    if (candError) throw new Error(`monthly_report_candidates failed: ${candError.message}`);

    const list = (candidates ?? []) as Candidate[];

    if (list.length === 0) {
      console.log(`[run-monthly-archive] No months awaiting archival (mode=${mode}).`);
      summary.duration_ms = Date.now() - startedAt.getTime();
      return json({ ok: true, ...summary });
    }

    // Devices can be renamed/removed between the candidate query and now.
    const { data: roomRows } = await admin
      .from("rooms")
      .select("id, name, floor");
    const meta = new Map<string, DeviceMeta>(
      ((roomRows ?? []) as { id: string; name: string; floor: string }[]).map((r) => [
        r.id,
        { name: r.name, floor: r.floor },
      ])
    );

    for (const c of list) {
      try {
        const result = await archiveMonth(admin, c, meta.get(c.device_id));
        summary.archived.push(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[run-monthly-archive] ${c.device_id} ${c.month_start} FAILED: ${message}`);

        // Mark failed so the next daily run retries. Readings stay put: the
        // delete below is never reached for a failed month.
        const { error: failError } = await admin.rpc("fail_monthly_report", {
          p_device_id: c.device_id,
          p_month_start: c.month_start,
          p_error_reason: message,
        });
        if (failError) {
          console.error(`  fail_monthly_report also failed: ${failError.message}`);
        }

        summary.failed.push({
          device_id: c.device_id,
          month_start: c.month_start,
          error: message,
          readings_retained: true,
        });
      }
    }

    summary.duration_ms = Date.now() - startedAt.getTime();
    return json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[run-monthly-archive] fatal: ${message}`);
    summary.duration_ms = Date.now() - startedAt.getTime();
    return json({ ok: false, error: message, ...summary }, 500);
  }
});

// ============================================================================
// Per device-month archive
// ============================================================================

async function archiveMonth(
  admin: AdminClient,
  c: Candidate,
  meta: DeviceMeta | undefined
) {
  const deviceName = meta?.name ?? c.device_id;
  const deviceFloor = meta?.floor ?? "-";

  // ---- 3. Single-writer claim --------------------------------------------
  const { data: claimed, error: claimError } = await admin.rpc("claim_monthly_report", {
    p_device_id: c.device_id,
    p_month_start: c.month_start,
    p_device_name: deviceName,
    p_device_floor: deviceFloor,
  });
  if (claimError) throw new Error(`claim_monthly_report failed: ${claimError.message}`);
  if (!claimed) {
    console.log(
      `[run-monthly-archive] ${c.device_id} ${c.month_start}: another run owns this month, skipping.`
    );
    return { device_id: c.device_id, month_start: c.month_start, skipped: true };
  }

  const monthStart = c.month_start;
  const monthEnd = c.month_end;
  const label = c.month_label || monthLabel(monthStart);

  // ---- Boundaries (Asia/Manila, half-open) --------------------------------
  const startIso = manilaDayStartIso(monthStart);
  const nextMonthStartDate = new Date(parseManilaDate(monthStart));
  nextMonthStartDate.setUTCMonth(nextMonthStartDate.getUTCMonth() + 1);
  const nextMonthStart = nextMonthStartDate.toISOString().slice(0, 10);
  const endIso = manilaDayStartIso(nextMonthStart);

  // ---- Rebuild this month's aggregates before reading them -----------------
  // The daily job only refreshes a trailing few days, so a month whose daily
  // job was down for a stretch would otherwise be archived with blank daily
  // rows and blank graphs. Aggregating the whole month here makes the archive
  // self-healing, and both calls are upserts so re-running is harmless.
  //
  // This MUST happen before the retention delete, which independently refuses
  // to run unless daily_summaries exist for the month.
  console.log(`[run-monthly-archive] refreshing aggregates for ${deviceName} ${label}...`);
  {
    const { error: dsErr } = await admin.rpc("refresh_daily_summaries", {
      p_from: monthStart,
      p_to: monthEnd,
      p_expected_sample_seconds: EXPECTED_SAMPLE_SECONDS,
    });
    if (dsErr) throw new Error(`refresh_daily_summaries for ${monthStart} failed: ${dsErr.message}`);

    const { error: gbErr } = await admin.rpc("refresh_graph_buckets", {
      p_from: monthStart,
      p_to: monthEnd,
      p_bucket_seconds: MONTHLY_BUCKET_SECONDS,
    });
    if (gbErr) throw new Error(`refresh_graph_buckets for ${monthStart} failed: ${gbErr.message}`);
  }

  // ---- Thresholds actually in effect -------------------------------------
  const { data: thRows, error: thError } = await admin.rpc("resolve_thresholds", {
    p_at: endIso,
  });
  if (thError) throw new Error(`resolve_thresholds failed: ${thError.message}`);
  const thresholds = thRows as Thresholds;

  // ---- Stats + daily rows + graph series ---------------------------------
  const { data: statsRaw, error: statsError } = await admin.rpc("monthly_stats", {
    p_device_id: c.device_id,
    p_month_start: monthStart,
  });
  if (statsError) throw new Error(`monthly_stats failed: ${statsError.message}`);
  const stats = statsRaw as unknown as MonthStats;

  const { data: dailyRows, error: dailyError } = await admin
    .from("daily_summaries")
    .select("*")
    .eq("device_id", c.device_id)
    .gte("day", monthStart)
    .lte("day", monthEnd)
    .order("day", { ascending: true });
  if (dailyError) throw new Error(`daily_summaries fetch failed: ${dailyError.message}`);

  const daily = ((dailyRows ?? []) as Record<string, unknown>[]).map(
    toDailyRow
  ) as DailyRow[];

  const { data: bucketRows, error: bucketError } = await admin
    .from("graph_buckets")
    .select(
      "bucket_start, reading_count, co2_avg, lpg_avg, temp_avg, humidity_avg, danger_readings"
    )
    .eq("device_id", c.device_id)
    .eq("bucket_seconds", MONTHLY_BUCKET_SECONDS)
    .gte("bucket_start", startIso)
    .lt("bucket_start", endIso)
    .order("bucket_start", { ascending: true });
  if (bucketError) throw new Error(`graph_buckets fetch failed: ${bucketError.message}`);

  const buckets = (bucketRows ?? []) as Record<string, unknown>[];

  const seriesFor = (m: MetricKey) =>
    buckets.map((b) => ({
      t: new Date(b.bucket_start as string).getTime(),
      v: b[`${m}_avg`] === null || b[`${m}_avg`] === undefined
        ? null
        : Number(b[`${m}_avg`]),
    }));

  // ---- Total days in the month (including days with no readings) ----------
  const totalDays = Math.round(
    (parseManilaDate(monthEnd).getTime() - parseManilaDate(monthStart).getTime()) /
      86_400_000
  ) + 1;
  const daysWithData = daily.filter((d) => d.reading_count > 0).length;

  // ---- Analysis -----------------------------------------------------------
  const analysis: Analysis = buildAnalysis({
    scopeLabel: label,
    deviceName,
    deviceFloor,
    stats,
    daily,
    thresholds,
    totalDays,
    daysWithData,
  });

  // ---- 4. Stream every reading once: CSV + appendix parts -----------------
  const rowsPerPart = appendixRowsPerPart();
  const basePath = `${c.device_id}/${monthStart}`;
  const totalRows = Number(c.reading_count ?? stats.reading_count ?? 0);
  const estimatedParts = Math.max(1, Math.ceil(totalRows / rowsPerPart));

  console.log(
    `[run-monthly-archive] ${deviceName} ${label}: ${totalRows.toLocaleString("en-US")} readings, ` +
      `~${estimatedParts} appendix part(s) of ${rowsPerPart} rows.`
  );

  // Part 1 carries the summary; the appendix starts on the same part and
  // continues across as many numbered parts as the data requires.
  const pdfPaths: string[] = [];
  const csvChunks: Uint8Array[] = [
    new TextEncoder().encode(CSV_PREAMBLE + "\r\n" + CSV_HEADER + "\r\n"),
  ];

  let partIndex = 0;
  let rowsWritten = 0;
  let csvRowCount = 0;

  // Table rows for the current part, buffered so we know the total page count.
  let buffer: ReadingRow[] = [];
  let builder: PdfBuilder | null = null;

  const flushPart = async () => {
    if (!builder || buffer.length === 0) {
      return;
    }
    const b = builder;
    renderAppendix(b, buffer, {
      monthLabel: label,
      deviceName,
      deviceFloor,
      partNumber: partIndex,
      partsTotal: estimatedParts,
      firstRowIndex: rowsWritten - buffer.length,
      totalRows,
      thresholds,
    });
    const bytes = await b.finish();

    const partName = String(partIndex).padStart(4, "0");
    const path = `${basePath}/part-${partName}.pdf`;
    const result = await uploadAndVerify(admin, BUCKET, path, bytes, "application/pdf");
    if (!result.ok) throw new Error(`part ${partIndex} ${result.reason}`);
    pdfPaths.push(path);
    buffer = [];
    builder = null;
  };

  for await (const row of streamReadings(admin, {
    deviceId: c.device_id,
    startIso,
    endIso,
  })) {
    csvChunks.push(new TextEncoder().encode(csvRow(row, deviceName, deviceFloor, thresholds) + "\r\n"));
    csvRowCount += 1;

    if (buffer.length === 0) {
      partIndex += 1;
      builder = await PdfBuilder.create(
        "A.I.R. Sensor Monitoring System",
        `Monthly report | ${deviceName} (${c.device_id}) | ${label}`
      );
      if (partIndex === 1) {
        renderSummary(builder, {
          deviceId: c.device_id,
          deviceName,
          deviceFloor,
          label,
          monthStart,
          monthEnd,
          generatedAt: new Date(),
          stats,
          daily,
          totalDays,
          daysWithData,
          analysis,
          thresholds,
          seriesFor,
          estimatedParts,
        });
      }
      rowsWritten += 1;
    }

    buffer.push(row);
    if (buffer.length >= rowsPerPart) {
      await flushPart();
    }
  }
  await flushPart();

  if (pdfPaths.length === 0) {
    throw new Error("no appendix part was produced - nothing to verify");
  }

  // ---- CSV upload ----------------------------------------------------------
  const csvBytes = concatBytes(csvChunks);
  const csvPath = `${basePath}/raw-readings.csv`;
  const csvResult = await uploadAndVerify(admin, BUCKET, csvPath, csvBytes, "text/csv");
  if (!csvResult.ok) throw new Error(`CSV ${csvResult.reason}`);

  // ---- 5. Record completion. verified = every part AND the CSV checked out.
  const { error: completeError } = await admin.rpc("complete_monthly_report", {
    p_device_id: c.device_id,
    p_month_start: monthStart,
    p_part_count: pdfPaths.length,
    p_pdf_paths: pdfPaths,
    p_csv_path: csvPath,
    p_csv_row_count: csvRowCount,
    p_reading_count: stats.reading_count,
    p_danger_reading_count: stats.danger_reading_count,
    p_stats: stats as unknown as Record<string, unknown>,
    p_daily_rows: daily as unknown as Record<string, unknown>,
    p_analysis: {
      paragraphs: analysis.paragraphs,
      attention_days: analysis.attentionDays,
    } as unknown as Record<string, unknown>,
    p_thresholds: thresholds as unknown as Record<string, unknown>,
    p_threshold_source: thresholds.threshold_source,
    p_verified: true,
  });
  if (completeError) {
    throw new Error(`complete_monthly_report failed: ${completeError.message}`);
  }

  // ---- 6. Retention. Fail-closed in SQL; readings survive if it refuses. --
  let deleted = 0;
  let retentionNote = "deleted";
  try {
    const { data: del, error: delError } = await admin.rpc(
      "delete_readings_for_archived_month",
      { p_device_id: c.device_id, p_month_start: monthStart }
    );
    if (delError) {
      retentionNote = `retained (${delError.message})`;
    } else {
      deleted = Number(del ?? 0);
    }
  } catch (e) {
    retentionNote = `retained (${e instanceof Error ? e.message : String(e)})`;
  }

  // ---- Notify admins ------------------------------------------------------
  await notifyAdmins(admin, {
    deviceName,
    monthLabel: label,
    parts: pdfPaths.length,
    readings: stats.reading_count,
    dangerReadings: stats.danger_reading_count,
  });

  console.log(
    `[run-monthly-archive] ${deviceName} ${label}: archived ${stats.reading_count.toLocaleString("en-US")} readings ` +
      `across ${pdfPaths.length} PDF part(s) + 1 CSV; raw rows ${retentionNote}` +
      (deleted ? ` (${deleted.toLocaleString("en-US")})` : "") + "."
  );

  return {
    device_id: c.device_id,
    device_name: deviceName,
    month_start: monthStart,
    reading_count: stats.reading_count,
    danger_reading_count: stats.danger_reading_count,
    parts: pdfPaths.length,
    csv_rows: csvRowCount,
    readings_deleted: deleted,
    retention: retentionNote,
  };
}

// ============================================================================
// Rendering
// ============================================================================

function renderSummary(
  b: PdfBuilder,
  ctx: {
    deviceId: string;
    deviceName: string;
    deviceFloor: string;
    label: string;
    monthStart: string;
    monthEnd: string;
    generatedAt: Date;
    stats: MonthStats;
    daily: DailyRow[];
    totalDays: number;
    daysWithData: number;
    analysis: Analysis;
    thresholds: Thresholds;
    seriesFor: (m: MetricKey) => { t: number; v: number | null }[];
    estimatedParts: number;
  }
): void {
  const {
    deviceName, deviceFloor, label, monthStart, monthEnd, generatedAt,
    stats, daily, totalDays, daysWithData, analysis, thresholds,
  } = ctx;

  // -- Title block ---------------------------------------------------------
  b.page.drawText("Monthly Environmental Report", {
    x: 40,
    y: b.y - 20,
    size: 20,
    font: b.bold,
    color: COLORS.ink,
  });
  b.space(30);

  b.text(label, { size: 14, bold: true, color: COLORS.teal });
  b.space(4);
  b.text(
    `Device: ${deviceName} (${ctx.deviceId})    Room location: ${deviceFloor}`,
    { size: 10 }
  );
  b.space(2);
  b.text(
    `Reporting period: ${fmtDateShort(monthStart + "T00:00:00Z")} - ${fmtDateShort(
      monthEnd + "T00:00:00Z"
    )} (calendar month, Asia/Manila)`,
    { size: 10 }
  );
  b.space(2);
  b.text(`Report generated: ${fmtTs(generatedAt.toISOString())} (Asia/Manila)`, { size: 10 });
  b.space(14);

  // -- Headline figures ----------------------------------------------------
  b.heading("Summary");
  b.text(
    `Total readings recorded: ${stats.reading_count.toLocaleString("en-US")}    |    ` +
      `Readings that reached a danger threshold: ${stats.danger_reading_count.toLocaleString("en-US")}`,
    { size: 10, bold: true }
  );
  b.space(4);
  b.text(
    `Days in period: ${totalDays}    |    Days with recorded readings: ${daysWithData}    |    ` +
      `Days with no recorded readings: ${Math.max(0, totalDays - daysWithData)}`,
    { size: 9.5 }
  );
  b.space(12);

  // -- Per-metric statistics table ----------------------------------------
  const cols = [
    { header: "Metric", width: 130, align: "left" as const },
    { header: "Min", width: 88, align: "right" as const },
    { header: "Max", width: 88, align: "right" as const },
    { header: "Average", width: 88, align: "right" as const },
    { header: "Unit", width: 62, align: "left" as const },
    { header: "Measurements", width: 96, align: "right" as const },
  ];
  const rows = (["co2", "lpg", "temp", "humidity"] as MetricKey[]).map((m) => {
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
  });
  b.table(cols, rows);

  b.note(
    "Averages and extremes are computed only from recorded measurements. " +
      "The 'Measurements' column shows how many real samples backed each statistic - " +
      "a sensor that returned no data contributes nothing and is never counted as a zero. " +
      "Readings above that count returned no value for that metric and were excluded from that metric's statistics only."
  );

  // -- Plain-language analysis --------------------------------------------
  b.heading("Analysis");
  b.text(
    "The following describes only what is present in the recorded data. It does not infer causes, " +
      "health effects, or future conditions, and it does not treat missing readings as safe.",
    { size: 8.6, italic: true, color: COLORS.muted }
  );
  b.space(6);
  for (const p of analysis.paragraphs) {
    b.text(p, { size: 9.3, indent: 6 });
    b.space(6);
  }

  // -- Graphs ---------------------------------------------------------------
  b.heading("Sensor trends");
  b.text(
    "Plotted from time-bucketed averages of the recorded readings (aggregated data, not individual samples). " +
      "Blank stretches are periods with no recorded readings - the line is deliberately left broken across them.",
    { size: 8.6, italic: true, color: COLORS.muted }
  );
  b.space(6);
  const xLabel = (t: number) => fmtDateShort(new Date(t).toISOString());
  for (const m of ["co2", "lpg", "temp", "humidity"] as MetricKey[]) {
    if ((stats.metrics[m]?.count ?? 0) === 0) {
      b.subheading(`${m.toUpperCase()} trend`);
      b.text("No measurements were recorded for this metric during the period.", {
        size: 9,
        italic: true,
        color: COLORS.muted,
      });
      continue;
    }
    b.chart(`${m === "co2" ? "CO2" : m === "lpg" ? "LPG" : m === "temp" ? "Temperature" : "Humidity"} trend`, m, thresholds, ctx.seriesFor(m), xLabel);
  }

  b.dangerBars(daily, (d) => fmtDateShort(d + "T00:00:00Z"));

  // -- Daily summary table --------------------------------------------------
  b.heading("Daily summary");
  b.table(
    [
      { header: "Date", width: 74, align: "left" },
      { header: "Readings", width: 74, align: "right" },
      { header: "Coverage", width: 72, align: "right" },
      { header: "CO2 avg", width: 68, align: "right" },
      { header: "CO2 max", width: 68, align: "right" },
      { header: "LPG avg", width: 68, align: "right" },
      { header: "Temp avg", width: 66, align: "right" },
      { header: "Hum avg", width: 64, align: "right" },
      { header: "Danger", width: 60, align: "right" },
    ],
    // Every calendar day appears, including days with no readings, so the
    // table can never imply a day was monitored when it was not.
    buildDailyTableRows(daily, totalDays, monthStart),
    { headerRepeatLabel: "Daily summary" }
  );
  b.note(
    "'No data' in the Readings column means zero readings were recorded that day. " +
      "A Reading count of 0 and a Danger count of 0 are different facts and are shown differently: " +
      "no data is never reported as 'safe'."
  );

  // -- Reading count reconciliation ---------------------------------------
  b.subheading("Consistency check");
  const dailySum = daily.reduce((s, d) => s + Number(d.reading_count ?? 0), 0);
  const dailyDanger = daily.reduce((s, d) => s + Number(d.danger_readings ?? 0), 0);
  b.text(
    `Daily summaries total ${dailySum.toLocaleString("en-US")} readings and ` +
      `${dailyDanger.toLocaleString("en-US")} danger readings. ` +
      `The whole-month totals in this report are ${stats.reading_count.toLocaleString("en-US")} readings and ` +
      `${stats.danger_reading_count.toLocaleString("en-US")} danger readings. ` +
      (dailySum === stats.reading_count && dailyDanger === stats.danger_reading_count
        ? "These agree."
        : "THESE DISAGREE - the figures above should not be relied on until this is resolved."),
    { size: 9, indent: 6 }
  );
}

function buildDailyTableRows(
  daily: DailyRow[],
  totalDays: number,
  monthStart: string
): string[][] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: string[][] = [];
  const start = parseManilaDate(monthStart);

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    const row = byDay.get(day);

    if (!row || row.reading_count === 0) {
      out.push([
        fmtDateShort(day + "T00:00:00Z"),
        "No data",
        "-",
        "-", "-", "-", "-", "-",
        "No data",
      ]);
      continue;
    }

    out.push([
      fmtDateShort(day + "T00:00:00Z"),
      Number(row.reading_count).toLocaleString("en-US"),
      `${Number(row.coverage_pct).toFixed(1)}%`,
      num(row.co2_avg, 0),
      num(row.co2_max, 0),
      num(row.lpg_avg, 0),
      num(row.temp_avg, 1),
      num(row.humidity_avg, 0),
      Number(row.danger_readings) > 0
        ? String(row.danger_readings)
        : "0",
    ]);
  }
  return out;
}

function renderAppendix(
  b: PdfBuilder,
  rows: ReadingRow[],
  ctx: {
    monthLabel: string;
    deviceName: string;
    deviceFloor: string;
    partNumber: number;
    partsTotal: number;
    firstRowIndex: number;
    totalRows: number;
    thresholds: Thresholds;
  }
): void {
  b.heading(
    `Appendix - recorded readings (part ${ctx.partNumber} of ${ctx.partsTotal})`
  );

  b.text(
    `Every recorded reading for ${ctx.deviceName} during ${ctx.monthLabel}, including readings that were ` +
      `within normal range. Rows ${ctx.firstRowIndex.toLocaleString("en-US")} - ` +
      `${(ctx.firstRowIndex + rows.length).toLocaleString("en-US")} of ` +
      `${ctx.totalRows.toLocaleString("en-US")}. ` +
      `A blank cell means the sensor recorded no value for that measurement; it does not mean zero.`,
    { size: 8.8 }
  );
  b.space(8);

  b.table(
    [
      { header: "Timestamp (Asia/Manila)", width: 168, align: "left" },
      { header: "Device", width: 116, align: "left" },
      { header: "Room / Floor", width: 168, align: "left" },
      { header: "CO2 (ppm)", width: 74, align: "right" },
      { header: "LPG (ppm)", width: 74, align: "right" },
      { header: "Temp (C)", width: 68, align: "right" },
      { header: "Humidity (%)", width: 78, align: "right" },
      { header: "Severity", width: 62, align: "right" },
      { header: "Assessment", width: 84, align: "left" },
    ],
    rows.map((r) => {
      const danger = isDangerRow(r, ctx.thresholds);
      const by = triggeredBy(r, ctx.thresholds);
      return [
        fmtTs(r.created_at),
        r.device_id,
        `${ctx.deviceName} / ${ctx.deviceFloor}`,
        r.co2 !== null ? num(r.co2, 0) : "-",
        r.lpg !== null ? num(r.lpg, 0) : "-",
        r.temp !== null ? num(r.temp, 1) : "-",
        r.humidity !== null ? num(r.humidity, 0) : "-",
        // Severity is the device's own recorded classification, shown only
        // when the firmware actually wrote one. NULL stays blank rather than
        // being invented.
        r.severity !== null ? String(r.severity) : "not recorded",
        danger ? `DANGER: ${by.join(", ")}` : "within thresholds",
      ];
    }),
    { headerRepeatLabel: "Appendix - recorded readings" }
  );
}

// ============================================================================
// Helpers
// ============================================================================

function toDailyRow(r: Record<string, unknown>): DailyRow {
  return {
    day: String(r.day),
    reading_count: Number(r.reading_count ?? 0),
    coverage_pct: Number(r.coverage_pct ?? 0),
    expected_count: Number(r.expected_count ?? 0),
    first_reading_at: (r.first_reading_at as string) ?? null,
    last_reading_at: (r.last_reading_at as string) ?? null,
    co2_avg: r.co2_avg === null ? null : Number(r.co2_avg),
    co2_max: r.co2_max === null ? null : Number(r.co2_max),
    lpg_avg: r.lpg_avg === null ? null : Number(r.lpg_avg),
    lpg_max: r.lpg_max === null ? null : Number(r.lpg_max),
    temp_avg: r.temp_avg === null ? null : Number(r.temp_avg),
    temp_max: r.temp_max === null ? null : Number(r.temp_max),
    humidity_avg: r.humidity_avg === null ? null : Number(r.humidity_avg),
    humidity_max: r.humidity_max === null ? null : Number(r.humidity_max),
    danger_readings: Number(r.danger_readings ?? 0),
    danger_by_metric: (r.danger_by_metric as Record<string, number>) ?? {},
  };
}

async function notifyAdmins(
  admin: AdminClient,
  ctx: {
    deviceName: string;
    monthLabel: string;
    parts: number;
    readings: number;
    dangerReadings: number;
  }
): Promise<void> {
  const { data: admins, error } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .eq("account_status", "approved");

  if (error || !admins || admins.length === 0) {
    console.warn(`[run-monthly-archive] could not notify admins: ${error?.message ?? "none found"}`);
    return;
  }

  const { error: insertError } = await admin.from("notifications").insert(
    (admins as { id: string }[]).map((a) => ({
      user_id: a.id,
      kind: "report_ready",
      title: `Monthly report ready - ${ctx.monthLabel}`,
      body:
        `${ctx.deviceName}: ${ctx.readings.toLocaleString("en-US")} readings for ${ctx.monthLabel} ` +
        `(${ctx.dangerReadings.toLocaleString("en-US")} danger readings). ` +
        `${ctx.parts} PDF part${ctx.parts === 1 ? "" : "s"} plus a full CSV are ready to download on the Reports page.`,
      read: false,
    }))
  );

  if (insertError) {
    console.warn(`[run-monthly-archive] notification insert failed: ${insertError.message}`);
  }
}