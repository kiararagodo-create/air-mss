// supabase/functions/run-weekly-archive/index.ts
// 7-day sensor archival job. Invoked daily by pg_cron at 00:10 Manila time.
//
// Data flow:
//   1. archive_completed_reports()   → candidate (device, start, end) tuples
//   2. sensor_readings_stats()      → per-metric min/max/avg/median/stddev/safe%
//   3. sensor_readings_downsample() → time-bucketed averages for charts
//   4. sensor_readings_events()     → contiguous warning/danger runs + peak values
//   5. sensor_readings_daily_summary() → per-day rollup with first/last timestamps
//   6. sensor_trend_slope()          → linear regression slope per metric
//   7. buildPdf()                   → Legal-size PDF with professional charts
//   8. uploadPdf() / verifyUpload() → Storage bucket + size-check
//   9. mark_report_succeeded()       → sensor_reports upsert
//  10. delete_archived_readings()    → safety-guarded row deletion
//
// NOTE: This file runs on Deno (Supabase Edge Functions), not Node.js.
// URL imports and Deno globals are valid here but the local TypeScript
// compiler (tsc) doesn't understand them. The `// @ts-nocheck` below
// suppresses those false positives without affecting runtime behavior.

// @ts-nocheck

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1?target=deno&standalone";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "sensor-reports";

const EXPECTED_SAMPLE_SECONDS = 3;
const PDF_CHART_BUCKET_SECONDS = 15 * 60;

// A downsample bucket with NO readings must never be silently connected to
// its neighbours as if data were continuous. Any gap larger than 2x the
// bucket size is treated as "no data" and the line breaks. (Previously a
// flat 2-hour constant unrelated to the actual bucket size.)
const GAP_MS = PDF_CHART_BUCKET_SECONDS * 1000 * 2;

// Threshold constants — keep in sync with src/data/Data.ts and firmware.
const CO2_WARN = 1000, CO2_DANGER = 3500;
const LPG_WARN = 1000, LPG_DANGER = 5000;
const TEMP_DANGER_LOW = 5, TEMP_DANGER_HIGH = 35;
const HUM_DANGER_LOW = 20, HUM_DANGER_HIGH = 80;

// --------------------------------------------------------------------------
// LEGAL paper dimensions (8.5 x 14 inches, portrait, in PDF points).
// 1 inch = 72 points.
// --------------------------------------------------------------------------
const PAGE_W = 864;   // 8.5 * 72
const PAGE_H = 1008;  // 14 * 72
const MARGIN = 40;   // points from page edge
const FOOTER_H = 20; // space reserved for footer

// Usable content area
const CONTENT_W = PAGE_W - MARGIN * 2; // 784pt
const CONTENT_H = PAGE_H - MARGIN * 2; // 928pt

// --------------------------------------------------------------------------
// TypeScript interfaces mirroring the updated SQL helper returns.
// --------------------------------------------------------------------------

interface CandidatePeriod {
  device_id: string;
  report_start: string;
  report_end: string;
  reading_count: number;
}

interface MetricStats {
  metric: string;
  reading_count: number;
  min_val: number | null;
  max_val: number | null;
  avg_val: number | null;
  median_val: number | null;
  stddev_val: number | null;
  safe_count: number;
  warning_count: number;
  danger_count: number;
  warning_threshold: number;
  danger_threshold: number;
  min_val_at: string | null;
  max_val_at: string | null;
}

interface DSRow {
  bucket_start: string;
  co2_avg: number | null;
  lpg_avg: number | null;
  temp_avg: number | null;
  humidity_avg: number | null;
}

interface EventRow {
  status: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  reading_count: number;
  peak_val: number | null;
  peak_val_at: string | null;
}

interface DailyRow {
  day: string;
  first_reading: string | null;
  last_reading: string | null;
  reading_count: number;
  co2_avg: number | null;
  co2_max: number | null;
  lpg_avg: number | null;
  lpg_max: number | null;
  temp_avg: number | null;
  temp_max: number | null;
  humidity_avg: number | null;
  humidity_max: number | null;
  dominant_status: string | null;
}

// A single chart point. `y` stays nullable all the way through — a null
// means "no reading in this bucket" and must NEVER be coerced to 0 before
// reaching the chart, or a missing period gets drawn as a fabricated zero
// reading instead of a visible gap.
interface ChartPoint {
  x: number;
  y: number | null;
}

// --------------------------------------------------------------------------
// 0. Entry + auth
// --------------------------------------------------------------------------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) return json({ error: "CRON_SECRET not configured" }, 500);
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) return json({ error: "Unauthorized" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: `Missing env: URL=${!!url} KEY=${!!serviceKey}` }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  try {
    const result = await runArchive(admin);
    return json({ ok: true, ...result }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Archive run failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

// --------------------------------------------------------------------------
// 1. Candidate periods (which devices have a closed 7-day window ready)
// --------------------------------------------------------------------------
async function fetchCandidatePeriods(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin.rpc("archive_completed_reports", { grace_minutes: 60 });
  if (error) throw new Error(`archive_completed_reports failed: ${error.message}`);
  return (data ?? []) as CandidatePeriod[];
}

// --------------------------------------------------------------------------
// 2. Per-metric stats (with min/max timestamps)
// --------------------------------------------------------------------------
async function fetchStats(admin: ReturnType<typeof createClient>, device_id: string, start: string, end: string): Promise<MetricStats[]> {
  const { data, error } = await admin.rpc("sensor_readings_stats", { p_device_id: device_id, p_window_start: start, p_window_end: end });
  if (error) throw new Error(`sensor_readings_stats failed: ${error.message}`);
  return (data ?? []) as MetricStats[];
}

// --------------------------------------------------------------------------
// 3. Downsampled averages for chart rendering
// --------------------------------------------------------------------------
async function fetchDownsample(admin: ReturnType<typeof createClient>, device_id: string, start: string, end: string, bucket_seconds: number): Promise<DSRow[]> {
  const { data, error } = await admin.rpc("sensor_readings_downsample", {
    p_device_id: device_id, p_window_start: start, p_window_end: end, p_bucket_seconds: bucket_seconds,
  });
  if (error) throw new Error(`sensor_readings_downsample failed: ${error.message}`);
  return (data ?? []) as DSRow[];
}

// --------------------------------------------------------------------------
// 4. Warning/danger events (with peak value + peak timestamp)
// --------------------------------------------------------------------------
async function fetchEvents(admin: ReturnType<typeof createClient>, device_id: string, start: string, end: string, metric: string, warn: number, danger: number): Promise<EventRow[]> {
  const { data, error } = await admin.rpc("sensor_readings_events", {
    p_device_id: device_id, p_window_start: start, p_window_end: end,
    p_metric: metric, p_warning_threshold: warn, p_danger_threshold: danger,
  });
  if (error) throw new Error(`sensor_readings_events failed: ${error.message}`);
  return (data ?? []) as EventRow[];
}

// --------------------------------------------------------------------------
// 5. Per-day summary (with first/last timestamps)
// --------------------------------------------------------------------------
async function fetchDailySummary(admin: ReturnType<typeof createClient>, device_id: string, start: string, end: string): Promise<DailyRow[]> {
  const { data, error } = await admin.rpc("sensor_readings_daily_summary", { p_device_id: device_id, p_window_start: start, p_window_end: end });
  if (error) throw new Error(`sensor_readings_daily_summary failed: ${error.message}`);
  return (data ?? []) as DailyRow[];
}

// --------------------------------------------------------------------------
// 6. Linear regression slope for trend classification
// --------------------------------------------------------------------------
async function fetchTrendSlope(admin: ReturnType<typeof createClient>, device_id: string, start: string, end: string, metric: string): Promise<number> {
  const { data, error } = await admin.rpc("sensor_trend_slope", { p_device_id: device_id, p_window_start: start, p_window_end: end, p_metric: metric });
  if (error) throw new Error(`sensor_trend_slope failed: ${error.message}`);
  return typeof data === "number" ? data : Number(data ?? 0);
}

// --------------------------------------------------------------------------
// 7. Helper utilities
// --------------------------------------------------------------------------
function pct(n: number, d: number) { return d ? Math.round((n / d) * 1000) / 10 : 0; }
function fmt(n: number | null | undefined, digits = 0) { return n == null || !Number.isFinite(n) ? "N/A" : n.toFixed(digits); }
function fmtNum(n: number | null | undefined) { return n == null ? "—" : fmt(n, 0); }

function classifyTrend(slope: number, stddev: number, avg: number): string {
  if (!avg || !stddev || avg === 0) return "STABLE";
  const normalized = slope * 3600;
  const snr = Math.abs(normalized) / (stddev || 1);
  if (snr < 0.05) return "STABLE";
  if (snr >= 1.5) return normalized > 0 ? "GENERALLY INCREASING" : "GENERALLY DECREASING";
  return "FLUCTUATING";
}

function renderInterpretation(metricLabel: string, unit: string, stats: MetricStats | undefined, events: EventRow[], trend: string): string {
  if (!stats || stats.reading_count === 0) return `${metricLabel}: insufficient data was recorded during this period.`;
  const total = stats.safe_count + stats.warning_count + stats.danger_count;
  const safeP = pct(stats.safe_count, total);
  const warnP = pct(stats.warning_count, total);
  const dangerP = pct(stats.danger_count, total);
  const dangerEvents = events.filter((e) => e.status === "DANGER");
  const warnEvents = events.filter((e) => e.status === "WARNING");
  const longestDanger = dangerEvents.reduce((m, e) => Math.max(m, e.duration_seconds), 0);
  const longestWarn = warnEvents.reduce((m, e) => Math.max(m, e.duration_seconds), 0);
  const parts: string[] = [];
  parts.push(
    `${metricLabel} remained ${trend === "STABLE" ? "generally stable" : trend === "FLUCTUATING" ? "moderately fluctuating" : trend.toLowerCase()} ` +
    `throughout the monitoring period, ranging from ${fmt(stats.min_val)} to ${fmt(stats.max_val)} ${unit} (average ${fmt(stats.avg_val)} ${unit}).`
  );
  parts.push(`${safeP.toFixed(1)}% of recorded measurements stayed within the safe range; ${warnP.toFixed(1)}% reached the warning range; ${dangerP.toFixed(1)}% reached the danger range.`);
  if (dangerEvents.length > 0) {
    parts.push(`${dangerEvents.length} danger event${dangerEvents.length === 1 ? "" : "s"} ${longestDanger > 60 ? `were detected, with the longest lasting approximately ${Math.round(longestDanger / 60)} minutes` : "were detected, all brief"}.`);
  } else if (warnEvents.length > 0) {
    parts.push(`${warnEvents.length} warning event${warnEvents.length === 1 ? "" : "s"} ${longestWarn > 60 ? `were detected, the longest lasting approximately ${Math.round(longestWarn / 60)} minutes` : "were detected, all brief"}.`);
  } else {
    parts.push("No warning or danger events were detected during this period.");
  }
  return parts.join(" ");
}

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString("en-PH", { timeZone: "Asia/Manila" }); } catch { return "—"; }
}

function fmtDateShort(ts: string | null | undefined): string {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" }); } catch { return "—"; }
}

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }); } catch { return "—"; }
}

// --------------------------------------------------------------------------
// 9. PDF layout constants and helpers
// --------------------------------------------------------------------------
const CHART_H = 270;
const CHART_PAD_L = 65;
const CHART_PAD_R = 15;
const CHART_PAD_T = 18;
const CHART_PAD_B = 48;
const CHART_INNER_H = CHART_H - CHART_PAD_T - CHART_PAD_B;
const CHART_INNER_W = CONTENT_W - CHART_PAD_L - CHART_PAD_R;

// Per-metric danger ceiling for Y-axis scaling. The previous version
// hardcoded CO2_DANGER as the floor for BOTH co2 and lpg charts — LPG's
// real 5000ppm threshold was silently ignored.
const METRIC_DANGER_HIGH: Record<string, number> = {
  co2: CO2_DANGER,
  lpg: LPG_DANGER,
  temp: TEMP_DANGER_HIGH,
  humidity: HUM_DANGER_HIGH,
};

// --------------------------------------------------------------------------
// drawText — pdf-lib renders from bottom-left of glyph; `y` is top of page.
// --------------------------------------------------------------------------
function drawText(page: any, x: number, y: number, s: string, size: number, color: any, font: any) {
  page.drawText(s, { x, y: y - size * 0.85, size, font, color });
}

function wrapText(s: string, maxChars: number): string[] {
  const out: string[] = []; let line = "";
  for (const word of s.split(" ")) {
    if ((line + " " + word).trim().length > maxChars) { out.push(line.trim()); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
}

function estimateWrappedHeight(lines: string[], fontSize: number, lineH: number): number {
  return lines.length * lineH;
}

// --------------------------------------------------------------------------
// Y-axis range (handles extreme spikes).
//
// Fix: previously scaled straight from raw min/max, so a single extreme
// spike (e.g. an LPG glitch reading 90,003.9 ppm) stretched the axis so
// far that every normal reading flattened into an unreadable near-flat
// line. Now scales to a representative range (95th percentile of the
// actual downsampled series, with the metric's own danger threshold as a
// floor) and lets fullWidthChart clamp+annotate any point above that
// ceiling as "off-scale" instead of compressing everything else. The
// real recorded value is never dropped or altered.
// --------------------------------------------------------------------------
function computeYRange(
  s: MetricStats,
  metricKey: string,
  seriesValues: number[],
): { yMin: number; yMax: number; clipped: boolean } {
  const dangerHigh = METRIC_DANGER_HIGH[metricKey] ?? (s.max_val ?? 1);
  const rawMin = s.min_val ?? 0;

  let yMin = Math.max(0, rawMin * 0.85);
  let percentileCeiling = dangerHigh;
  if (seriesValues.length > 0) {
    const sorted = [...seriesValues].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    percentileCeiling = Math.max(percentileCeiling, sorted[idx]);
  }
  let yMax = percentileCeiling * 1.25;

  if (metricKey === "co2" || metricKey === "lpg") yMax = Math.max(yMax, dangerHigh + 300);
  if (metricKey === "temp") { yMin = Math.min(yMin, TEMP_DANGER_LOW - 2); yMax = Math.max(yMax, TEMP_DANGER_HIGH + 2); }
  if (metricKey === "humidity") { yMin = Math.min(yMin, HUM_DANGER_LOW - 5); yMax = Math.max(yMax, HUM_DANGER_HIGH + 5); }

  const clipped = (s.max_val ?? 0) > yMax;
  return { yMin, yMax, clipped };
}

// --------------------------------------------------------------------------
// fullWidthChart — 7-day line chart with real timestamps, labeled axes,
// threshold lines, gap detection, and max annotation.
// --------------------------------------------------------------------------
function fullWidthChart(
  page: any,
  x: number, y: number,
  label: string,
  unit: string,
  warnVal: number | null,
  dangerVal: number | null,
  dangerLow: number | null,
  series: ChartPoint[],
  yMin: number, yMax: number,
  stats: MetricStats | undefined,
  clipped: boolean,
) {
  const BLACK = rgb(0.06, 0.09, 0.16);
  const GRAY = rgb(0.58, 0.64, 0.72);
  const TEAL = rgb(0.05, 0.58, 0.53);
  const AMBER = rgb(0.96, 0.62, 0.04);
  const RED = rgb(0.86, 0.15, 0.15);
  const GRID = rgb(0.93, 0.95, 0.97);

  const ix = x + CHART_PAD_L;
  const iy = y - CHART_H + CHART_PAD_B;
  const iw = CHART_INNER_W;
  const ih = CHART_INNER_H;

  // Background
  page.drawRectangle({ x: ix, y: iy, width: iw, height: ih, color: rgb(0.98, 0.99, 1), borderColor: GRID, borderWidth: 0.5 });

  const yRange = yMax - yMin || 1;
  const yTicks = 6;
  const yTickFS = 8;

  // ---- Y-axis tick labels with unit suffix ----
  for (let i = 0; i < yTicks; i++) {
    const val = yMax - (i / (yTicks - 1)) * yRange;
    const tickY = iy + (i / (yTicks - 1)) * ih;
    const rounded = Math.round(val);
    const lbl = `${rounded.toLocaleString()} ${unit}`;
    const lw = lbl.length * yTickFS * 0.55;
    drawText(page, ix - lw - 4, tickY, lbl, yTickFS, GRAY, undefined);
    if (i > 0 && i < yTicks - 1) {
      page.drawLine({ start: { x: ix, y: tickY }, end: { x: ix + iw, y: tickY }, color: GRID, thickness: 0.25 });
    }
  }

  // ---- Y-axis title ----
  const yAxisTitle = `${label} (${unit})`;
  drawText(page, ix - 45, y - CHART_H / 2 + 4, yAxisTitle, 9, GRAY, undefined);

  // Points with a real reading in the bucket — `y` stays null for missing
  // buckets all the way to here, so the gap-break loop below has actual
  // gaps to detect instead of a fabricated flat line at zero.
  const validPoints = series.filter((p) => p.y != null && Number.isFinite(p.y as number)) as Array<{ x: number; y: number }>;
  if (validPoints.length > 0) {
    const xMin = validPoints[0].x;
    const xMax = validPoints[validPoints.length - 1].x;
    const xRange = xMax - xMin || 1;
    const xTickFS = 7;
    const tickCount = 8;

    for (let i = 0; i <= tickCount; i++) {
      const frac = i / tickCount;
      const ts = xMin + frac * xRange;
      const tx = ix + frac * iw;
      const d = new Date(ts);
      try {
        const dateLbl = d.toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" });
        const timeLbl = d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
        drawText(page, tx - 22, iy - 18, dateLbl, xTickFS, GRAY, undefined);
        drawText(page, tx - 20, iy - 28, timeLbl, xTickFS, GRAY, undefined);
      } catch {}
      if (i < tickCount) {
        page.drawLine({ start: { x: tx, y: iy }, end: { x: tx, y: iy + 4 }, color: GRAY, thickness: 0.25 });
      }
    }

    // ---- X-axis title ----
    drawText(page, ix + iw / 2 - 25, iy - 38, "Date / Time", 8, GRAY, undefined);

    // ---- Threshold lines ----
    const safeY = (v: number) => iy + ((yMax - v) / yRange) * ih;
    const drawTH = (val: number, color: any, lbl: string, dash: [number, number]) => {
      if (val < yMin || val > yMax) return;
      const ty = safeY(val);
      page.drawLine({ start: { x: ix, y: ty }, end: { x: ix + iw, y: ty }, color, thickness: 0.5, dashArray: dash });
      const lw = lbl.length * 6.5 * 0.55;
      drawText(page, ix + iw - lw - 2, ty + 1, lbl, 6.5, color, undefined);
    };
    if (dangerVal != null) drawTH(dangerVal, RED, `Danger: ${dangerVal.toLocaleString()} ${unit}`, [3, 2]);
    if (warnVal != null) drawTH(warnVal, AMBER, `Warn: ${warnVal.toLocaleString()} ${unit}`, [2, 2]);
    // Low-side danger bound — temperature/humidity have both a floor and a
    // ceiling; only the high threshold was ever drawn before.
    if (dangerLow != null) drawTH(dangerLow, RED, `Danger: ${dangerLow.toLocaleString()} ${unit}`, [3, 2]);

    // ---- Data polyline — break across real gaps only ----
    // GAP_MS is derived from the actual downsample bucket size (module
    // scope, above), not a flat guess. A segment is only ever drawn
    // between two REAL readings; a missing bucket produces a visible
    // break, never a connecting line or a fabricated zero.
    const drawSeg = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
      const px1 = ix + ((p1.x - xMin) / xRange) * iw;
      const py1 = safeY(p1.y);
      const px2 = ix + ((p2.x - xMin) / xRange) * iw;
      const py2 = safeY(p2.y);
      const cx1 = Math.max(ix, Math.min(ix + iw, px1));
      const cy1 = Math.max(iy, Math.min(iy + ih, py1));
      const cx2 = Math.max(ix, Math.min(ix + iw, px2));
      const cy2 = Math.max(iy, Math.min(iy + ih, py2));
      page.drawLine({ start: { x: cx1, y: cy1 }, end: { x: cx2, y: cy2 }, color: TEAL, thickness: 0.8 });
    };
    let prev: { x: number; y: number } | null = null;
    for (const p of validPoints) {
      if (prev !== null && (p.x - prev.x) <= GAP_MS) drawSeg(prev, p);
      prev = p;
    }

    // ---- Max annotation ----
    // Always shows the REAL recorded value/timestamp, even when it sits
    // above the visible Y range (clipped). The dot is pinned to the top
    // edge in that case and the label says "(off-scale)" — nothing
    // hidden or altered, just not allowed to flatten the rest of the
    // chart.
    if (stats?.max_val != null && stats.max_val_at != null) {
      const maxTs = new Date(stats.max_val_at).getTime();
      if (maxTs >= xMin && maxTs <= xMax) {
        const mx = ix + ((maxTs - xMin) / xRange) * iw;
        const rawMy = safeY(stats.max_val);
        const my = Math.max(iy, Math.min(iy + ih, rawMy));
        page.drawCircle({ x: mx, y: my, size: 2.5, color: RED, borderColor: RED, borderWidth: 0 });
        const txt = clipped
          ? `Max: ${stats.max_val.toLocaleString()} ${unit} (off-scale)`
          : `Max: ${stats.max_val.toLocaleString()} ${unit}`;
        const tw = txt.length * 6.5 * 0.55;
        const labelY = clipped ? Math.min(iy + ih - 8, my + 5) : my + 5;
        drawText(page, Math.min(ix + iw - tw - 2, Math.max(ix, mx - tw / 2)), labelY, txt, 7, RED, undefined);
      }
    }
  } else {
    drawText(page, ix + iw / 2 - 60, iy + ih / 2, "No readings recorded in this period", 9, GRAY, undefined);
  }
}

// --------------------------------------------------------------------------
// buildPdf — Legal-size (8.5 x 14 inches), professional layout with
// full-width charts, real timestamps, page-break protection, and footer.
// --------------------------------------------------------------------------
interface BuildPdfArgs {
  device: { id: string; name: string; floor: string };
  reportStart: Date; reportEnd: Date; generatedAt: Date;
  readingCount: number;
  dataCoveragePct: number;
  stats: MetricStats[];
  events: Record<string, EventRow[]>;
  trend: Record<string, string>;
  dailySummary: DailyRow[];
  interpretations: Record<string, string>;
  downsampled: Record<string, ChartPoint[]>;
}

async function buildPdf(args: BuildPdfArgs): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const BLACK = rgb(0.06, 0.09, 0.16);
  const GRAY = rgb(0.58, 0.64, 0.72);
  const TEAL = rgb(0.05, 0.58, 0.53);
  const RED = rgb(0.86, 0.15, 0.15);
  const AMBER = rgb(0.96, 0.62, 0.04);
  const GRID_COLOR = rgb(0.93, 0.95, 0.97);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  let pageNum = 1;

  const drawFooter = () => {
    const footerY = MARGIN + FOOTER_H;
    page.drawLine({ start: { x: MARGIN, y: footerY + 10 }, end: { x: PAGE_W - MARGIN, y: footerY + 10 }, color: GRAY, thickness: 0.3 });
    page.drawText("A.I.R. Sensor Monitoring System", { x: MARGIN, y: footerY, size: 8, font: helv, color: GRAY });
    page.drawText(`Page ${pageNum}`, { x: PAGE_W - MARGIN - 40, y: footerY, size: 8, font: helv, color: GRAY });
  };

  const drawPageHeader = () => {
    page.drawText("A.I.R. Sensor Monitoring System  |  7-Day Report", { x: MARGIN, y: y - 12, size: 9, font: helv, color: GRAY });
    y -= 18;
    page.drawText(`${args.device.name} (${args.device.id}) — ${args.device.floor}`, { x: MARGIN, y, size: 10, font: helvB, color: BLACK });
    y -= 16;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, color: GRID_COLOR, thickness: 0.5 });
    y -= 12;
  };

  // Ensure enough space for next section; start new page if not.
  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN + FOOTER_H + 20) {
      drawFooter();
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      pageNum++;
      drawPageHeader();
    }
  };

  // ---- PAGE 1: Header + Executive Summary ----
  drawPageHeader();

  page.drawText("7-Day Sensor Monitoring Report", { x: MARGIN, y, size: 20, font: helvB, color: BLACK });
  y -= 30;

  const metaLines = [
    `Monitoring period:  ${fmtTs(args.reportStart.toISOString())}  to  ${fmtTs(args.reportEnd.toISOString())} (Asia/Manila)`,
    `Report generated:   ${fmtTs(args.generatedAt.toISOString())}`,
    `Total readings:     ${args.readingCount.toLocaleString()}  |  Data coverage: ${args.dataCoveragePct.toFixed(1)}%`,
  ];
  for (const ln of metaLines) {
    page.drawText(ln, { x: MARGIN, y, size: 10, font: helv, color: GRAY });
    y -= 15;
  }
  y -= 20;

  const co2Stats = args.stats.find((s) => s.metric === "co2");
  const dominant = (co2Stats?.danger_count ?? 0) > 0 ? "DANGER" : (co2Stats?.warning_count ?? 0) > 0 ? "WARNING" : "SAFE";
  const domColor = dominant === "DANGER" ? RED : dominant === "WARNING" ? AMBER : TEAL;

  page.drawText("Executive Summary", { x: MARGIN, y, size: 13, font: helvB, color: BLACK });
  y -= 18;
  page.drawText(`Overall sensor condition: ${dominant}`, { x: MARGIN, y, size: 11, font: helvB, color: domColor });
  y -= 28;

  // ---- Per-metric sections (one full-width chart each) ----
  const metrics: Array<{
    key: string; label: string; unit: string;
    warn: number | null; danger: number | null; dangerLow: number | null;
  }> = [
    { key: "co2", label: "CO\u2082", unit: "ppm", warn: CO2_WARN, danger: CO2_DANGER, dangerLow: null },
    { key: "lpg", label: "LPG", unit: "ppm", warn: LPG_WARN, danger: LPG_DANGER, dangerLow: null },
    { key: "temp", label: "Temperature", unit: "\u00b0C", warn: null, danger: TEMP_DANGER_HIGH, dangerLow: TEMP_DANGER_LOW },
    { key: "humidity", label: "Humidity", unit: "%", warn: null, danger: HUM_DANGER_HIGH, dangerLow: HUM_DANGER_LOW },
  ];

  for (const m of metrics) {
    const s = args.stats.find((x) => x.metric === m.key);
    if (!s || s.reading_count === 0) continue;

    const interpLines = wrapText(args.interpretations[m.key] ?? "", 95);
    const sectionH = 28 + CHART_H + 16 + 130 + 14 + estimateWrappedHeight(interpLines, 10, 13) + 20;
    ensureSpace(sectionH);

    page.drawText(`${m.label} Monitoring`, { x: MARGIN, y, size: 13, font: helvB, color: BLACK });
    y -= 18;

    const series: ChartPoint[] = args.downsampled?.[m.key] ?? [];
    const seriesValues = series.filter((p) => p.y != null && Number.isFinite(p.y as number)).map((p) => p.y as number);
    const { yMin, yMax, clipped } = computeYRange(s, m.key, seriesValues);
    fullWidthChart(page, MARGIN, y, m.label, m.unit, m.warn, m.danger, m.dangerLow, series, yMin, yMax, s, clipped);
    y -= CHART_H + 16;

    // Statistics block
    page.drawText("Statistics", { x: MARGIN, y, size: 11, font: helvB, color: BLACK });
    y -= 15;

    const total = s.safe_count + s.warning_count + s.danger_count;
    const statLines = [
      `Min: ${fmt(s.min_val, 1)} ${m.unit}  |  Max: ${fmt(s.max_val, 1)} ${m.unit}  |  Avg: ${fmt(s.avg_val, 1)} ${m.unit}  |  Median: ${fmt(s.median_val, 1)} ${m.unit}  |  Std Dev: ${fmt(s.stddev_val, 1)} ${m.unit}`,
      `Safe: ${pct(s.safe_count, total).toFixed(1)}%  |  Warning: ${pct(s.warning_count, total).toFixed(1)}%  |  Danger: ${pct(s.danger_count, total).toFixed(1)}%  |  Trend: ${args.trend[m.key] ?? "STABLE"}`,
    ];
    if (s.min_val_at) statLines.push(`Minimum recorded: ${fmt(s.min_val, 1)} ${m.unit} at ${fmtTs(s.min_val_at)}`);
    if (s.max_val_at) statLines.push(`Maximum recorded: ${fmt(s.max_val, 1)} ${m.unit} at ${fmtTs(s.max_val_at)}${clipped ? " (off-scale on chart above)" : ""}`);

    for (const ln of statLines) {
      page.drawText(ln, { x: MARGIN, y, size: 10, font: helv, color: BLACK });
      y -= 14;
    }
    y -= 6;

    // Interpretation
    page.drawText("Interpretation", { x: MARGIN, y, size: 11, font: helvB, color: BLACK });
    y -= 15;
    for (const ln of interpLines) {
      page.drawText(ln, { x: MARGIN, y, size: 10, font: helv, color: BLACK });
      y -= 13;
    }
    y -= 20;
  }

  // ---- Daily Summary ----
  ensureSpace(200);
  page.drawText("Daily Summary", { x: MARGIN, y, size: 13, font: helvB, color: BLACK });
  y -= 18;

  const dsCols = [
    { lbl: "Date", w: 72 },
    { lbl: "First Reading", w: 110 },
    { lbl: "Last Reading", w: 110 },
    { lbl: "CO\u2082 Avg", w: 65 },
    { lbl: "CO\u2082 Max", w: 65 },
    { lbl: "LPG Avg", w: 60 },
    { lbl: "Temp Avg", w: 55 },
    { lbl: "Hum Avg", w: 55 },
    { lbl: "Readings", w: 55 },
    { lbl: "Status", w: 55 },
  ];

  const drawDsHeader = () => {
    let cx = MARGIN;
    for (const col of dsCols) {
      page.drawText(col.lbl, { x: cx, y, size: 8, font: helvB, color: GRAY });
      cx += col.w;
    }
    y -= 14;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, color: GRID_COLOR, thickness: 0.3 });
    y -= 12;
  };
  drawDsHeader();

  for (const row of args.dailySummary) {
    if (y < MARGIN + FOOTER_H + 30) {
      drawFooter();
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      pageNum++;
      drawPageHeader();
      // Table continues on a new page — column headers must repeat or a
      // reader landing mid-table has no idea which column is which.
      page.drawText("Daily Summary (continued)", { x: MARGIN, y, size: 11, font: helvB, color: BLACK });
      y -= 16;
      drawDsHeader();
    }
    // A day with zero readings must show NO DATA rather than blank/zero
    // averages, which would make an offline day look continuously
    // monitored.
    const noData = row.reading_count === 0;
    const dayStr = fmtDateShort(row.day);
    const timeRange = noData ? "NO DATA" : `${fmtTime(row.first_reading)} - ${fmtTime(row.last_reading)}`;
    const lc = noData ? GRAY : row.dominant_status === "DANGER" ? RED : row.dominant_status === "WARNING" ? AMBER : BLACK;
    const vals = noData
      ? [dayStr, timeRange, "—", "—", "—", "—", "—", "0", "NO DATA"]
      : [
          dayStr, timeRange,
          fmt(row.co2_avg, 0), fmt(row.co2_max, 0),
          fmt(row.lpg_avg, 0), fmt(row.temp_avg, 1), fmt(row.humidity_avg, 0),
          row.reading_count.toLocaleString(),
          row.dominant_status ?? "SAFE",
        ];
    let cx = MARGIN;
    for (let i = 0; i < vals.length; i++) {
      page.drawText(vals[i], { x: cx, y, size: 8.5, font: helv, color: lc });
      cx += dsCols[i].w;
    }
    y -= 13;
  }
  y -= 16;

  // ---- Warning / Danger Events ----
  const allEvents: Array<{ metric: string } & EventRow> = [];
  for (const [k, list] of Object.entries(args.events)) {
    for (const e of list) allEvents.push({ metric: k.toUpperCase(), ...e });
  }

  if (allEvents.length > 0) {
    ensureSpace(180);
    page.drawText("Warning / Danger Events", { x: MARGIN, y, size: 13, font: helvB, color: BLACK });
    y -= 18;

    const evCols = [
      { lbl: "Started", w: 120 },
      { lbl: "Ended", w: 120 },
      { lbl: "Metric", w: 55 },
      { lbl: "Status", w: 55 },
      { lbl: "Peak", w: 65 },
      { lbl: "Peak Time", w: 110 },
      { lbl: "Duration", w: 60 },
    ];

    const drawEvHeader = () => {
      let cx = MARGIN;
      for (const col of evCols) {
        page.drawText(col.lbl, { x: cx, y, size: 8.5, font: helvB, color: GRAY });
        cx += col.w;
      }
      y -= 14;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, color: GRID_COLOR, thickness: 0.3 });
      y -= 12;
    };
    drawEvHeader();

    for (const ev of allEvents) {
      if (y < MARGIN + FOOTER_H + 30) {
        drawFooter();
        page = pdf.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
        pageNum++;
        drawPageHeader();
        page.drawText("Warning / Danger Events (continued)", { x: MARGIN, y, size: 11, font: helvB, color: BLACK });
        y -= 16;
        drawEvHeader();
      }
      const mins = Math.max(1, Math.round(ev.duration_seconds / 60));
      const evColor = ev.status === "DANGER" ? RED : AMBER;
      const rowVals = [
        fmtTs(ev.started_at), fmtTs(ev.ended_at), ev.metric, ev.status,
        ev.peak_val != null ? fmt(ev.peak_val, 0) : "—", fmtTs(ev.peak_val_at), `${mins} min`,
      ];
      let cx = MARGIN;
      for (let i = 0; i < rowVals.length; i++) {
        page.drawText(rowVals[i], { x: cx, y, size: 8.5, font: helv, color: evColor });
        cx += evCols[i].w;
      }
      y -= 13;
    }
  }

  drawFooter();
  return await pdf.save();
}

// ----------------------------------------------------------------------
// 10. Upload PDF to Storage.
// ----------------------------------------------------------------------
async function uploadPdf(
  admin: ReturnType<typeof createClient>,
  deviceId: string, reportStart: Date, reportEnd: Date, pdf: Uint8Array
): Promise<{ bucket: string; path: string }> {
  const startIso = reportStart.toISOString().slice(0, 10);
  const endIso = reportEnd.toISOString().slice(0, 10);
  const path = `${deviceId}/${startIso}_to_${endIso}.pdf`;
  const { error } = await admin.storage.from(BUCKET).upload(path, pdf, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  return { bucket: BUCKET, path };
}

// ----------------------------------------------------------------------
// 11. Verify the upload actually exists (HEAD via Storage SDK).
// ----------------------------------------------------------------------
async function verifyUpload(admin: ReturnType<typeof createClient>, bucket: string, path: string) {
  const { data, error } = await admin.storage.from(bucket).list(path.split("/").slice(0, -1).join("/"), {
    limit: 1, search: path.split("/").pop(),
  });
  if (error) throw new Error(`storage verify failed: ${error.message}`);
  if (!data || data.length === 0) throw new Error("storage verify: file not found after upload");
  if ((data[0]?.metadata?.size ?? 0) < 1024) throw new Error("storage verify: uploaded file too small");
  return true;
}

// ----------------------------------------------------------------------
// 12. Mark succeeded via SQL helper.
// ----------------------------------------------------------------------
async function markReportSucceeded(
  admin: ReturnType<typeof createClient>,
  args: {
    device_id: string; report_start: string; report_end: string;
    pdf_path: string; reading_count: number;
    stats: MetricStats[]; dominant_status: string; data_coverage_pct: number;
  }
) {
  const co2 = args.stats.find((s) => s.metric === "co2");
  const lpg = args.stats.find((s) => s.metric === "lpg");
  const temp = args.stats.find((s) => s.metric === "temp");
  const hum = args.stats.find((s) => s.metric === "humidity");
  const { error } = await admin.rpc("mark_report_succeeded", {
    p_device_id: args.device_id,
    p_report_start: args.report_start,
    p_report_end: args.report_end,
    p_pdf_path: args.pdf_path,
    p_reading_count: args.reading_count,
    p_co2_min: co2?.min_val ?? null, p_co2_max: co2?.max_val ?? null, p_co2_avg: co2?.avg_val ?? null,
    p_co2_danger_events: (await fetchEvents(admin, args.device_id, args.report_start, args.report_end, "co2", CO2_WARN, CO2_DANGER)).filter((e) => e.status === "DANGER").length,
    p_lpg_min: lpg?.min_val ?? null, p_lpg_max: lpg?.max_val ?? null, p_lpg_avg: lpg?.avg_val ?? null,
    p_lpg_danger_events: (await fetchEvents(admin, args.device_id, args.report_start, args.report_end, "lpg", LPG_WARN, LPG_DANGER)).filter((e) => e.status === "DANGER").length,
    p_temp_min: temp?.min_val ?? null, p_temp_max: temp?.max_val ?? null, p_temp_avg: temp?.avg_val ?? null,
    p_humidity_min: hum?.min_val ?? null, p_humidity_max: hum?.max_val ?? null, p_humidity_avg: hum?.avg_val ?? null,
    p_dominant_status: args.dominant_status,
    p_data_coverage_pct: args.data_coverage_pct,
  });
  if (error) throw new Error(`mark_report_succeeded failed: ${error.message}`);
}

// ----------------------------------------------------------------------
// 13. Delete archived raw readings via the safety-guarded SQL fn.
// ----------------------------------------------------------------------
async function deleteArchivedReadings(
  admin: ReturnType<typeof createClient>,
  device_id: string, report_start: string, report_end: string,
): Promise<number> {
  const { data, error } = await admin.rpc("delete_archived_readings", {
    p_device_id: device_id, p_report_start: report_start, p_report_end: report_end,
  });
  if (error) throw new Error(`delete_archived_readings failed: ${error.message}`);
  return Number(data ?? 0);
}

// ----------------------------------------------------------------------
// MAIN ORCHESTRATION
// ----------------------------------------------------------------------
async function runArchive(admin: ReturnType<typeof createClient>) {
  console.log("Step 1: fetchCandidatePeriods");
  const candidates = await fetchCandidatePeriods(admin);
  console.log("Candidates:", JSON.stringify(candidates));
  const results: any[] = [];

  for (const c of candidates) {
    const start = c.report_start;
    const end = c.report_end;
    try {
      console.log(`Step 2: processing ${c.device_id} from ${start} to ${end}`);
      const [allStats, daily, trendCo2, trendLpg, trendTemp, trendHum] = await Promise.all([
        fetchStats(admin, c.device_id, start, end),
        fetchDailySummary(admin, c.device_id, start, end),
        fetchTrendSlope(admin, c.device_id, start, end, "co2"),
        fetchTrendSlope(admin, c.device_id, start, end, "lpg"),
        fetchTrendSlope(admin, c.device_id, start, end, "temp"),
        fetchTrendSlope(admin, c.device_id, start, end, "humidity"),
      ]);
      console.log("Stats fetched:", allStats.length, "metrics");

      const dsCo2 = await fetchDownsample(admin, c.device_id, start, end, PDF_CHART_BUCKET_SECONDS);
      const dsLpg = await fetchDownsample(admin, c.device_id, start, end, PDF_CHART_BUCKET_SECONDS);
      const dsTemp = await fetchDownsample(admin, c.device_id, start, end, PDF_CHART_BUCKET_SECONDS);
      const dsHum = await fetchDownsample(admin, c.device_id, start, end, PDF_CHART_BUCKET_SECONDS);
      console.log("Downsample done:", dsCo2.length, "buckets");

      const events = {
        co2: await fetchEvents(admin, c.device_id, start, end, "co2", CO2_WARN, CO2_DANGER),
        lpg: await fetchEvents(admin, c.device_id, start, end, "lpg", LPG_WARN, LPG_DANGER),
        temp: await fetchEvents(admin, c.device_id, start, end, "temp", -Infinity, TEMP_DANGER_HIGH),
        humidity: await fetchEvents(admin, c.device_id, start, end, "humidity", -Infinity, HUM_DANGER_HIGH),
      };

      const co2S = allStats.find((s) => s.metric === "co2");
      const lpgS = allStats.find((s) => s.metric === "lpg");
      const tempS = allStats.find((s) => s.metric === "temp");
      const humS = allStats.find((s) => s.metric === "humidity");
      const trend = {
        co2: classifyTrend(trendCo2, co2S?.stddev_val ?? 0, co2S?.avg_val ?? 0),
        lpg: classifyTrend(trendLpg, lpgS?.stddev_val ?? 0, lpgS?.avg_val ?? 0),
        temp: classifyTrend(trendTemp, tempS?.stddev_val ?? 0, tempS?.avg_val ?? 0),
        humidity: classifyTrend(trendHum, humS?.stddev_val ?? 0, humS?.avg_val ?? 0),
      };

      const totalSeconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
      const expected = Math.max(1, totalSeconds / EXPECTED_SAMPLE_SECONDS);
      const dataCoveragePct = Math.min(100, (c.reading_count / expected) * 100);

      const dominant =
        (co2S?.danger_count ?? 0) > 0 || (lpgS?.danger_count ?? 0) > 0 ? "DANGER" :
        (co2S?.warning_count ?? 0) > 0 || (lpgS?.warning_count ?? 0) > 0 ? "WARNING" : "SAFE";

      const interpretations = {
        co2: renderInterpretation("CO2", "ppm", co2S, events.co2, trend.co2),
        lpg: renderInterpretation("LPG", "ppm", lpgS, events.lpg, trend.lpg),
        temp: renderInterpretation("Temperature", "C", tempS, events.temp, trend.temp),
        humidity: renderInterpretation("Humidity", "%", humS, events.humidity, trend.humidity),
      };

      console.log("Step 3: look up room metadata");
      const { data: roomRow } = await admin.from("rooms").select("name, floor").eq("id", c.device_id).maybeSingle();
      const device = {
        id: c.device_id,
        name: (roomRow as any)?.name ?? c.device_id,
        floor: (roomRow as any)?.floor ?? "-",
      };

      // IMPORTANT: co2_avg etc. are left as `null` here when a bucket has
      // no readings — do NOT coerce with `?? 0`. The previous version did
      // that, which silently turned "no data in this 15-minute window"
      // into a real plotted 0 ppm reading, defeating the gap-break logic
      // entirely (a missing period was drawn as a flat line at zero
      // instead of a visible gap).
      console.log("Step 4: buildPdf");
      const pdf = await buildPdf({
        device,
        reportStart: new Date(start),
        reportEnd: new Date(end),
        generatedAt: new Date(),
        readingCount: c.reading_count,
        dataCoveragePct,
        stats: allStats,
        events,
        trend,
        dailySummary: daily,
        interpretations,
        downsampled: {
          co2: dsCo2.map((r) => ({ x: new Date(r.bucket_start).getTime(), y: r.co2_avg })),
          lpg: dsLpg.map((r) => ({ x: new Date(r.bucket_start).getTime(), y: r.lpg_avg })),
          temp: dsTemp.map((r) => ({ x: new Date(r.bucket_start).getTime(), y: r.temp_avg })),
          humidity: dsHum.map((r) => ({ x: new Date(r.bucket_start).getTime(), y: r.humidity_avg })),
        },
      });

      console.log("Step 5: uploadPdf");
      const { bucket, path } = await uploadPdf(admin, c.device_id, new Date(start), new Date(end), pdf);
      console.log("Step 6: verifyUpload");
      await verifyUpload(admin, bucket, path);

      await markReportSucceeded(admin, {
        device_id: c.device_id, report_start: start, report_end: end,
        pdf_path: path, reading_count: c.reading_count,
        stats: allStats, dominant_status: dominant, data_coverage_pct: dataCoveragePct,
      });

      const deleted = await deleteArchivedReadings(admin, c.device_id, start, end);

      results.push({ device_id: c.device_id, status: "succeeded", readings_deleted: deleted, pdf_path: path });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`archive failed for ${c.device_id}:`, msg);
      await admin.rpc("mark_report_failed", {
        p_device_id: c.device_id, p_report_start: start, p_report_end: end, p_error_reason: msg.slice(0, 1000),
      });
      results.push({ device_id: c.device_id, status: "failed", error: msg });
    }
  }
  return { processed: candidates.length, results };
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}