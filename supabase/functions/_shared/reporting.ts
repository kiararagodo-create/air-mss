// ============================================================================
// supabase/functions/_shared/reporting.ts
//
// Shared report-generation primitives for the monthly archive job and the
// on-demand daily PDF. Used by:
//   supabase/functions/run-monthly-archive/index.ts
//   supabase/functions/daily-report/index.ts
//
// Rules this module enforces:
//   * All calendar boundaries are Asia/Manila calendar months/days.
//   * Every read of `readings` is PAGINATED with keyset pagination on the
//     primary key. There is no implicit .limit() anywhere, and no report is
//     ever silently truncated.
//   * Missing (NULL) sensor values are never coerced to zero. They are counted
//     separately from real measurements.
//   * Narrative text describes only what is in the data. No causes, no health
//     conclusions, no predictions, no invented historical settings.
// ============================================================================

import {
  PDFDocument,
  StandardFonts,
  PDFFont,
  PDFPage,
  rgb,
  RGB,
} from "https://esm.sh/pdf-lib@1.17.1?target=deno&standalone";

import type { SupabaseClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";

/** The Edge Functions build their client with createClient(url, serviceKey),
 *  whose inferred generic differs from the bare SupabaseClient default. Widening
 *  to `any` here keeps one signature usable from both entrypoints. */
export type AdminClient = SupabaseClient<any>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPORT_TZ = "Asia/Manila";

/** The Philippines has no DST, so the offset is a constant 8 hours.
 *  Used for JS-side boundary math; SQL-side boundaries go through the
 *  manila_day_start()/manila_day_end() helpers which use `at time zone`. */
export const MANILA_OFFSET_MINUTES = 480;

/** Firmware reporting cadence, used only for the expected-count / coverage
 *  denominator. Never used to fill in a value. */
export const EXPECTED_SAMPLE_SECONDS = 3;

/** Rows per appendix PDF part. A month at 3s cadence is ~864k rows, so the
 *  appendix is split into clearly numbered parts. Override with the
 *  APPENDIX_ROWS_PER_PART edge secret. */
export const DEFAULT_APPENDIX_ROWS_PER_PART = 4000;

/** PostgREST page size for keyset pagination. Always followed by another
 *  query until an empty page comes back, so a server-side max-rows cap lower
 *  than this can never cause silent truncation. */
const PAGE_SIZE = 1000;

export const MONTHLY_BUCKET = "monthly-reports";

export const COLORS = {
  teal: rgb(0.05, 0.58, 0.53),
  amber: rgb(0.96, 0.62, 0.04),
  red: rgb(0.86, 0.15, 0.15),
  green: rgb(0.09, 0.64, 0.29),
  grid: rgb(0.90, 0.92, 0.95),
  ink: rgb(0.06, 0.09, 0.16),
  muted: rgb(0.40, 0.45, 0.53),
  faint: rgb(0.65, 0.69, 0.75),
  paper: rgb(0.98, 0.99, 1.0),
};

// Legal portrait, 72 pt/in
const PAGE_W = 864;
const PAGE_H = 1008;
const MARGIN = 40;
const FOOTER_H = 22;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_BOTTOM = MARGIN + FOOTER_H + 12;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReadingRow {
  id: number;
  device_id: string;
  co2: number | null;
  lpg: number | null;
  temp: number | null;
  humidity: number | null;
  severity: number | null;
  created_at: string;
}

export type MetricKey = "co2" | "lpg" | "temp" | "humidity";

export interface Thresholds {
  threshold_source: "historical" | "current" | "default";
  effective_from?: string;
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
}

export interface MetricStat {
  unit: string;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export interface MonthStats {
  reading_count: number;
  danger_reading_count: number;
  first_reading_at: string | null;
  last_reading_at: string | null;
  metrics: Record<MetricKey, MetricStat>;
}

/** The annual bundle's `stats` has the same shape as MonthStats. Aliased so the
 *  two concepts stay obviously related without duplicating the interface. */
export type MonthlyStatSet = MonthStats;

export const METRIC_LABEL: Record<MetricKey, string> = {
  co2: "CO2",
  lpg: "LPG",
  temp: "Temperature",
  humidity: "Humidity",
};

export const METRIC_UNIT: Record<MetricKey, string> = {
  co2: "ppm",
  lpg: "ppm",
  temp: "\u00b0C",
  humidity: "%",
};

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------
//
// All of these take/return Manila CALENDAR values. A "day" is a plain
// "YYYY-MM-DD" string that is always interpreted in Asia/Manila, never UTC.

export function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-PH", { timeZone: REPORT_TZ });
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("en-PH", {
    timeZone: REPORT_TZ,
    month: "short",
    day: "numeric",
  });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString("en-PH", {
    timeZone: REPORT_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "2026-08-01" -> Date object anchored at UTC midnight for pure calendar math. */
export function parseManilaDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Manila calendar date string for an instant. */
export function manilaDateString(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const shifted = new Date(d.getTime() + MANILA_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Start instant (ISO) of a Manila calendar day. */
export function manilaDayStartIso(day: string): string {
  const d = parseManilaDate(day);
  return new Date(d.getTime() - MANILA_OFFSET_MINUTES * 60_000).toISOString();
}

/** Exclusive end instant (ISO) of a Manila calendar day. */
export function manilaDayEndIso(day: string): string {
  const d = parseManilaDate(day);
  d.setUTCDate(d.getUTCDate() + 1);
  return new Date(d.getTime() - MANILA_OFFSET_MINUTES * 60_000).toISOString();
}

/** "2026-08" -> "1 August 2026" style label from the first of the month. */
export function monthLabel(monthStart: string): string {
  const d = parseManilaDate(monthStart);
  return d.toLocaleDateString("en-PH", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

export function humanDate(day: string): string {
  const d = parseManilaDate(day);
  return d.toLocaleDateString("en-PH", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return digits > 0 ? n.toFixed(digits) : Math.round(n).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Threshold evaluation
// ---------------------------------------------------------------------------

/** Was this reading row in the danger band? Mirrors reading_is_danger() in SQL. */
export function isDangerRow(
  r: Pick<ReadingRow, "co2" | "lpg" | "temp" | "humidity">,
  th: Thresholds
): boolean {
  return (
    (r.co2 !== null && r.co2 >= th.co2_danger) ||
    (r.lpg !== null && r.lpg >= th.lpg_danger) ||
    (r.temp !== null && (r.temp < th.temp_freeze_below || r.temp > th.temp_heat_above)) ||
    (r.humidity !== null &&
      (r.humidity < th.humidity_dry_below || r.humidity > th.humidity_mold_above))
  );
}

/** Which metrics breached in this row. May be more than one. */
export function triggeredBy(
  r: Pick<ReadingRow, "co2" | "lpg" | "temp" | "humidity">,
  th: Thresholds
): string[] {
  const out: string[] = [];
  if (r.co2 !== null && r.co2 >= th.co2_danger) out.push("CO2");
  if (r.lpg !== null && r.lpg >= th.lpg_danger) out.push("LPG");
  if (r.temp !== null && (r.temp < th.temp_freeze_below || r.temp > th.temp_heat_above))
    out.push("Temperature");
  if (
    r.humidity !== null &&
    (r.humidity < th.humidity_dry_below || r.humidity > th.humidity_mold_above)
  )
    out.push("Humidity");
  return out;
}

export function dangerHigh(th: Thresholds, m: MetricKey): number {
  switch (m) {
    case "co2":
      return th.co2_danger;
    case "lpg":
      return th.lpg_danger;
    case "temp":
      return th.temp_heat_above;
    case "humidity":
      return th.humidity_mold_above;
  }
}

export function dangerLow(th: Thresholds, m: MetricKey): number | null {
  switch (m) {
    case "co2":
    case "lpg":
      return null;
    case "temp":
      return th.temp_freeze_below;
    case "humidity":
      return th.humidity_dry_below;
  }
}

export function warnLine(th: Thresholds, m: MetricKey): number | null {
  // Temperature and humidity are two-sided in this system and have no
  // intermediate warning tier configured, so no warning line is drawn.
  switch (m) {
    case "co2":
      return th.co2_warning;
    case "lpg":
      return th.lpg_warning;
    case "temp":
    case "humidity":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Keyset pagination
// ---------------------------------------------------------------------------

export interface PageQuery {
  deviceId: string;
  startIso: string; // inclusive
  endIso: string;   // exclusive
}

/**
 * Streams every reading row in [startIso, endIso) for one device.
 *
 * Keyset pagination on the primary key: stable under concurrent inserts, and
 * immune to a server-side max-rows cap. Loops until an EMPTY page comes back,
 * so it can never stop early and silently truncate the report.
 */
export async function* streamReadings(
  admin: AdminClient,
  q: PageQuery
): AsyncGenerator<ReadingRow, void, undefined> {
  let cursor: number | null = null;

  for (;;) {
    let query = admin
      .from("readings")
      .select("id, device_id, co2, lpg, temp, humidity, severity, created_at")
      .eq("device_id", q.deviceId)
      .gte("created_at", q.startIso)
      .lt("created_at", q.endIso)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (cursor !== null) query = query.gt("id", cursor);

    const { data, error } = await query;
    if (error) {
      throw new Error(
        `readings page fetch failed (cursor=${cursor ?? "start"}): ${error.message}`
      );
    }

    const rows = (data ?? []) as ReadingRow[];
    if (rows.length === 0) return;

    for (const row of rows) yield row;

    // Advance the cursor and keep going until a page comes back empty. We do
    // NOT break on `rows.length < PAGE_SIZE`, because if the project's
    // max-rows setting is below PAGE_SIZE that would truncate the export.
    cursor = rows[rows.length - 1].id;
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Raw CSV header.
 *
 * Every column except the two derived flag columns is copied verbatim from the
 * `readings` row - no rounding, no unit conversion, no aggregation. An empty
 * cell means the sensor recorded NULL for that metric, which is a different
 * thing from a recorded zero.
 */
export const CSV_HEADER = [
  "reading_id",
  "timestamp_utc",
  "timestamp_asia_manila",
  "device_id",
  "device_name",
  "device_floor",
  "co2_ppm",
  "lpg_ppm",
  "temp_c",
  "humidity_pct",
  "severity_recorded",
  "is_danger_reading",
  "danger_metrics",
  "thresholds_applied",
].join(",");

export const CSV_PREAMBLE = [
  "# A.I.R. Sensor Monitoring System - raw readings export",
  "# Source: Supabase `readings` table, one row per recorded reading.",
  "# All measurement columns are the original stored values, copied verbatim.",
  "# No rounding, rescaling, interpolation or gap-filling has been applied.",
  "# An empty cell means the sensor recorded no value for that metric; it does NOT mean zero.",
  "# is_danger_reading and danger_metrics are DERIVED by comparing each row to the",
  "# thresholds recorded as in effect on that row's date - see thresholds_applied.",
  "# Counts derived from these readings are counts of reading rows, not incidents.",
].join("\r\n");

/** Human-readable description of the thresholds used, recorded per row. */
export function thresholdsColumn(th: Thresholds): string {
  return [
    `co2_danger=${th.co2_danger}`,
    `lpg_danger=${th.lpg_danger}`,
    `temp_range=${th.temp_freeze_below}..${th.temp_heat_above}`,
    `humidity_range=${th.humidity_dry_below}..${th.humidity_mold_above}`,
    `source=${th.threshold_source}`,
  ].join(";");
}

export function csvRow(
  r: ReadingRow,
  deviceName: string,
  deviceFloor: string,
  th: Thresholds
): string {
  const danger = isDangerRow(r, th);
  return [
    r.id,
    r.created_at,
    fmtTs(r.created_at),
    csvCell(r.device_id),
    csvCell(deviceName),
    csvCell(deviceFloor),
    // Verbatim. String() preserves the full stored precision; a NULL becomes an
    // empty cell rather than 0.
    r.co2 ?? "",
    r.lpg ?? "",
    r.temp ?? "",
    r.humidity ?? "",
    r.severity ?? "",
    danger ? "yes" : "no",
    danger ? csvCell(triggeredBy(r, th).join(";")) : "",
    csvCell(thresholdsColumn(th)),
  ].join(",");
}

/** Concatenates chunks into a single Uint8Array without blowing the call
 *  stack on very large exports. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain-language analysis
// ---------------------------------------------------------------------------

export interface DailyRow {
  day: string;
  reading_count: number;
  coverage_pct: number;
  expected_count: number;
  first_reading_at: string | null;
  last_reading_at: string | null;
  co2_avg: number | null;
  co2_max: number | null;
  lpg_avg: number | null;
  lpg_max: number | null;
  temp_avg: number | null;
  temp_max: number | null;
  humidity_avg: number | null;
  humidity_max: number | null;
  danger_readings: number;
  danger_by_metric: Record<string, number>;
}

export interface AnalysisInput {
  scopeLabel: string;
  deviceName: string;
  deviceFloor: string;
  stats: MonthStats;
  daily: DailyRow[];
  thresholds: Thresholds;
  /** Number of Manila days covered, including days with no readings at all. */
  totalDays: number;
  /** Days in scope for which a daily summary row exists. */
  daysWithData: number;
}

export interface Analysis {
  paragraphs: string[];
  /** Days that warrant a closer look, derived only from recorded data. */
  attentionDays: { day: string; reason: string }[];
}

/**
 * Builds a factual narrative.
 *
 * Deliberately does NOT: attribute a cause, state a health effect, predict
 * future behaviour, or assert that conditions were safe. Where data is missing
 * it says the data is missing rather than assuming the best case.
 */
export function buildAnalysis(input: AnalysisInput): Analysis {
  const { stats, daily, thresholds: th, scopeLabel, totalDays, daysWithData } = input;
  const paragraphs: string[] = [];

  // -- Coverage / gaps, first, because it bounds every other statement. ------
  const missingDays = Math.max(0, totalDays - daysWithData);
  const lowCoverage = daily
    .filter((d) => d.reading_count > 0 && Number(d.coverage_pct) < 90)
    .sort((a, b) => Number(a.coverage_pct) - Number(b.coverage_pct))
    .slice(0, 5);

  paragraphs.push(
    `Coverage. ${stats.reading_count.toLocaleString("en-US")} reading${
      stats.reading_count === 1 ? " was" : "s were"
    } recorded for this device during ${scopeLabel}. First recorded reading ` +
      `${fmtTs(stats.first_reading_at)}, last ${fmtTs(stats.last_reading_at)}.`
  );

  if (missingDays === 0 && lowCoverage.length === 0) {
    paragraphs.push(
      "Every day in this period has recorded readings and no day falls below 90% of the expected count, so there are no known monitoring gaps within the recorded span."
    );
  } else {
    const parts: string[] = [];
    if (missingDays > 0) {
      parts.push(
        `${missingDays} day${missingDays === 1 ? "" : "s"} in this period have no recorded readings at all. What the air was doing during those days is unknown from this data.`
      );
    }
    if (lowCoverage.length > 0) {
      parts.push(
        `${lowCoverage.length} day${
          lowCoverage.length === 1 ? "" : "s"
        } recorded less than 90% of the expected reading count (lowest: ` +
          lowCoverage
            .map((d) => `${fmtDateShort(d.day)} at ${Number(d.coverage_pct).toFixed(1)}%`)
            .join(", ") +
          `). Readings that were not recorded are not counted as safe; they are simply absent.`
      );
    }
    paragraphs.push(parts.join(" "));
  }

  // -- Danger readings (rows), explicitly NOT incidents. --------------------
  if (stats.danger_reading_count === 0) {
    paragraphs.push(
      `Danger-level readings. No recorded reading reached a danger threshold during ${scopeLabel}. ` +
        `This means no recorded sample was in the danger band - it is a statement about the readings that exist, ` +
        `not a claim that conditions were continuously safe throughout, particularly across the gaps noted above.`
    );
  } else {
    const pct = stats.reading_count
      ? ((stats.danger_reading_count / stats.reading_count) * 100).toFixed(2)
      : "0.00";
    const breakdown = (Object.keys(METRIC_LABEL) as MetricKey[])
      .map((m) => {
        const label = { co2: "CO2", lpg: "LPG", temp: "temperature", humidity: "humidity" }[m];
        return `${label} ${thresholdBreachCount(daily, m)}`;
      })
      .filter((s) => !s.endsWith(" 0"))
      .join(", ");

    paragraphs.push(
      `Danger-level readings. ${stats.danger_reading_count.toLocaleString("en-US")} recorded reading${
        stats.danger_reading_count === 1 ? "" : "s"
      } (${pct}% of all recorded readings) had at least one metric in the danger band. ` +
        `This is a count of reading rows, not a count of separate incidents and not a duration - ` +
        `consecutive danger readings are counted individually, so an unbroken run of danger readings is reported as its row count. ` +
        `It also describes only the readings that exist: any period with no recorded readings is excluded from the denominator, ` +
        `so this count is a lower bound on what was recorded, not a measure of how long any condition persisted. ` +
        `Per-metric row counts (a row breaching two metrics appears in both): ${breakdown || "none"}.`
    );
  }

  // -- Peaks, per metric, stated as observed facts. -------------------------
  const peakLines: string[] = [];
  for (const m of ["co2", "lpg", "temp", "humidity"] as MetricKey[]) {
    const s = stats.metrics[m];
    if (!s || s.count === 0) {
      peakLines.push(
        `${METRIC_LABEL[m]}: no ${METRIC_UNIT[m]} measurements were recorded.`
      );
      continue;
    }
    peakLines.push(
      `${METRIC_LABEL[m]} recorded minimum ${num(s.min, 1)} ${METRIC_UNIT[m]}, ` +
        `maximum ${num(s.max, 1)} ${METRIC_UNIT[m]}, average ${num(s.avg, 1)} ${METRIC_UNIT[m]} ` +
        `across ${s.count.toLocaleString("en-US")} measurement${
          s.count === 1 ? "" : "s"
        }.`
    );
  }
  paragraphs.push(`Observed extremes. ${peakLines.join(" ")}`);

  // -- Days warranting attention, derived only from data. -------------------
  const attentionDays: Analysis["attentionDays"] = [];
  for (const d of daily) {
    if (d.reading_count === 0) continue;
    if (d.danger_readings > 0) {
      const which = (Object.entries(d.danger_by_metric ?? {}) as [string, number][])
        .filter(([, n]) => Number(n) > 0)
        .map(([k]) => k.toUpperCase());
      attentionDays.push({
        day: d.day,
        reason: `${d.danger_readings} danger reading${
          d.danger_readings === 1 ? "" : "s"
        } (${which.join(", ") || "unspecified metric"})`,
      });
    }
  }
  attentionDays.sort((a, b) => a.day.localeCompare(b.day));

  if (attentionDays.length > 0) {
    paragraphs.push(
      `Days requiring attention. ${attentionDays.length} day${
        attentionDays.length === 1 ? "" : "s"
      } contained at least one danger-level reading: ` +
        attentionDays
          .slice(0, 12)
          .map((d) => `${fmtDateShort(d.day)} (${d.reason})`)
          .join("; ") +
        (attentionDays.length > 12 ? `; and ${attentionDays.length - 12} more.` : ".")
    );
  } else if (daysWithData > 0) {
    paragraphs.push(
      "Days requiring attention. No day in this period contained a recorded reading in the danger band."
    );
  }

  // -- Threshold provenance, always stated. ----------------------------------
  paragraphs.push(thresholdNote(th));

  return { paragraphs, attentionDays };
}

function thresholdBreachCount(daily: DailyRow[], m: MetricKey): number {
  return daily.reduce(
    (sum, d) => sum + Number((d.danger_by_metric ?? {})[m] ?? 0),
    0
  );
}

// ---------------------------------------------------------------------------
// Annual (yearly) analysis
// ---------------------------------------------------------------------------

export interface AnnualMonth {
  month_number: number;
  month_start: string;
  month_end: string;
  label: string;
  is_elapsed: boolean;
  reading_count: number;
  danger_readings: number;
  devices_reporting: number;
  days_with_data: number;
  days_in_month: number;
  coverage_pct: number;
  first_reading_at: string | null;
  last_reading_at: string | null;
  metrics: Record<MetricKey, MetricStat>;
}

export interface ThresholdChange {
  effective_from: string;
  co2_danger: number;
  lpg_danger: number;
  temp_freeze_below: number;
  temp_heat_above: number;
  humidity_dry_below: number;
  humidity_mold_above: number;
}

export interface AnnualAnalysisInput {
  year: number;
  /** True when the year is still in progress, so totals are partial. */
  isYearToDate: boolean;
  coverageStart: string | null;
  coverageEnd: string | null;
  /** Last Manila day included, e.g. "2026-09-30". Null when nothing recorded. */
  coverageLastDay: string | null;
  today: string;
  readingCount: number;
  dangerReadingCount: number;
  months: AnnualMonth[];
  monthsWithData: number;
  metrics: Record<MetricKey, MetricStat>;
  thresholds: Thresholds | null;
  thresholdChanges: ThresholdChange[];
}

export interface AnnualAnalysis {
  paragraphs: string[];
  attentionMonths: AnnualMonth[];
  /** Months ranked by recorded volume, used for the "peak" statements. */
  peakMonths: AnnualMonth[];
  zeroMonths: AnnualMonth[];
}

/**
 * Year-level narrative, same rules as the daily/monthly analysis:
 * describe only what the aggregates show, never infer a cause, a health
 * effect, or a future trend, and never treat an absent reading as a safe one.
 */
export function buildAnnualAnalysis(input: AnnualAnalysisInput): AnnualAnalysis {
  const {
    year, isYearToDate, coverageStart, coverageEnd, coverageLastDay, today,
    readingCount, dangerReadingCount, months, monthsWithData, metrics,
    thresholds, thresholdChanges,
  } = input;

  const paragraphs: string[] = [];
  const elapsed = months.filter((m) => m.is_elapsed);
  const zeroMonths = months.filter((m) => m.is_elapsed && m.reading_count === 0);
  const withData = months.filter((m) => m.reading_count > 0);

  // ---- Scope ---------------------------------------------------------------
  const scope = isYearToDate
    ? `the part of ${year} elapsed so far (through ${coverageLastDay ? fmtDateShort(coverageLastDay + "T00:00:00Z") : today} Asia/Manila)`
    : `${year}`;

  paragraphs.push(
    `Scope. This report covers ${scope}. It is labelled ${
      isYearToDate ? "\"Year to date\"" : "a full calendar year"
    } because ${
      isYearToDate
        ? `${year} has not finished; months after ${coverageLastDay ?? today} had not occurred when this report was generated and are not included in any total, average or graph below.`
        : `${year} had fully elapsed when this report was generated.`
    }`
  );

  paragraphs.push(
    `Totals. ${readingCount.toLocaleString("en-US")} reading${
      readingCount === 1 ? "" : "s"
    } were recorded across ${monthsWithData} month${
      monthsWithData === 1 ? "" : "s"
    }${monthsWithData === 12 ? "" : ` of 12 (${elapsed.length} month${elapsed.length === 1 ? "" : "s"} had elapsed)`}. ` +
      (coverageStart && coverageEnd
        ? `First recorded reading ${fmtTs(coverageStart)}, last ${fmtTs(coverageEnd)}.`
        : `No readings were recorded during ${scope}.`)
  );

  // ---- Gaps ----------------------------------------------------------------
  if (zeroMonths.length > 0) {
    paragraphs.push(
      `Months with no recorded readings. ${zeroMonths.length} elapsed month${
        zeroMonths.length === 1 ? "" : "s"
      } in ${year} recorded no readings at all (${zeroMonths.map((m) => m.label).join(", ")}). ` +
        `Nothing can be concluded about conditions during those months; they are not counted as safe.`
    );
  }

  const lowCoverage = withData
    .filter((m) => Number(m.coverage_pct) < 90)
    .sort((a, b) => Number(a.coverage_pct) - Number(b.coverage_pct));
  if (lowCoverage.length > 0) {
    paragraphs.push(
      `Coverage. ${lowCoverage.length} month${lowCoverage.length === 1 ? "" : "s"} with recorded data ` +
        `covered less than 90% of the expected reading count (lowest: ` +
        lowCoverage.map((m) => `${m.label} at ${Number(m.coverage_pct).toFixed(1)}%`).join(", ") +
        `). Unrecorded periods are absent from every figure here, not zero.`
    );
  } else if (withData.length > 0) {
    paragraphs.push(
      "Coverage. Every month with recorded data covered at least 90% of the expected reading count, " +
        "so there are no large known monitoring gaps in the months that reported."
    );
  }

  // ---- Danger readings ------------------------------------------------------
  if (dangerReadingCount === 0) {
    paragraphs.push(
      `Danger-level readings. No recorded reading reached a danger threshold during ${scope}. ` +
        `This is a statement about the readings that exist - it is not a claim that conditions were ` +
        `continuously safe throughout, particularly in months or periods listed above with no or low coverage.`
    );
  } else {
    const pct = readingCount ? ((dangerReadingCount / readingCount) * 100).toFixed(2) : "0.00";
    paragraphs.push(
      `Danger-level readings. ${dangerReadingCount.toLocaleString("en-US")} recorded reading${
        dangerReadingCount === 1 ? "" : "s"
      } (${pct}% of all recorded readings) had at least one metric in the danger band. ` +
        `This is a count of reading rows, not a count of separate incidents and not a duration - ` +
        `consecutive danger readings are counted individually, so an unbroken run is reported as its row count.`
    );
  }

  // ---- Peaks, derived only from recorded values ----------------------------
  const peakMonths = [...withData].sort((a, b) => b.reading_count - a.reading_count).slice(0, 3);
  if (peakMonths.length > 0) {
    const busiest = peakMonths[0];
    paragraphs.push(
      `Highest recorded volume. ${
        peakMonths
          .map((m) => `${m.label} ${m.reading_count.toLocaleString("en-US")} readings`)
          .join(", ")
      }. A higher reading count reflects more data recorded, not necessarily worse conditions - ` +
        `the busiest month was ${busiest.label}, and months with low or no coverage cannot be compared ` +
        `directly against months that were fully recorded.`
    );
  }

  const peakMetricLines = (Object.keys(METRIC_LABEL) as MetricKey[]).map((m) => {
    const s = metrics[m];
    const digits = m === "temp" ? 1 : 0;
    if (!s || s.count === 0) {
      return `${METRIC_LABEL[m]}: no ${METRIC_UNIT[m]} measurements were recorded during ${scope}.`;
    }
    return (
      `${METRIC_LABEL[m]} recorded minimum ${num(s.min, digits)} ${METRIC_UNIT[m]}, maximum ${num(
        s.max,
        digits
      )} ${METRIC_UNIT[m]}, average ${num(s.avg, digits)} ${METRIC_UNIT[m]} across ` +
      `${s.count.toLocaleString("en-US")} measurement${s.count === 1 ? "" : "s"}.`
    );
  });
  paragraphs.push(`Observed extremes across the year. ${peakMetricLines.join(" ")}`);

  // ---- Months needing attention -------------------------------------------
  const attentionMonths = months.filter((m) => m.danger_readings > 0);
  if (attentionMonths.length > 0) {
    paragraphs.push(
      `Months requiring attention. ${attentionMonths.length} month${
        attentionMonths.length === 1 ? "" : "s"
      } contained at least one danger-level reading: ` +
        attentionMonths
          .map((m) => `${m.label} (${m.danger_readings.toLocaleString("en-US")})`)
          .join("; ") +
        `. These are monthly counts of reading rows, not incident counts and not durations.`
    );
  } else if (monthsWithData > 0) {
    paragraphs.push(
      "Months requiring attention. No month in this period contained a recorded reading in the danger band."
    );
  }

  // ---- Month-to-month comparison, stated as movement not cause -------------
  if (withData.length >= 2) {
    const first = withData[0];
    const last = withData[withData.length - 1];
    const delta = last.reading_count - first.reading_count;
    const direction = delta > 0 ? "higher" : delta < 0 ? "lower" : "the same";
    paragraphs.push(
      `Month-to-month comparison. Recorded volume in ${last.label} was ${Math.abs(
        delta
      ).toLocaleString("en-US")} reading${Math.abs(delta) === 1 ? "" : "s"} ${direction} than in ${
        first.label
      }. This compares recorded data volume only; no cause for the difference is established here, ` +
        `and a difference may reflect how long a device was reporting rather than any change in conditions.`
    );
  }

  // ---- Threshold provenance, including mid-year changes --------------------
  paragraphs.push(
    thresholds ? thresholdNote(thresholds) : "Thresholds. No threshold record is available for this period."
  );

  if (thresholdChanges && thresholdChanges.length > 1) {
    paragraphs.push(
      `Thresholds changed during ${year}. ${thresholdChanges.length} threshold configurations took ` +
        `effect between ${fmtTs(thresholdChanges[0].effective_from)} and ${fmtTs(
          thresholdChanges[thresholdChanges.length - 1].effective_from
        )}. Month totals in this report were evaluated against the thresholds in effect for each ` +
        `month, so months with different configurations are not directly comparable on danger counts.`
    );
  }

  return { paragraphs, attentionMonths, peakMonths, zeroMonths };
}

export function thresholdNote(th: Thresholds): string {
  switch (th.threshold_source) {
    case "historical":
      return (
        `Thresholds. Readings in this report were evaluated against the thresholds recorded as in effect ` +
        `at the time (effective from ${fmtTs(
          th.effective_from
        )}): CO2 danger ${num(th.co2_danger)} ppm, LPG danger ${num(
          th.lpg_danger
        )} ppm, temperature danger below ${num(
          th.temp_freeze_below
        )} °C or above ${num(th.temp_heat_above)} °C, humidity danger below ${num(
          th.humidity_dry_below
        )}% or above ${num(th.humidity_mold_above)}%.`
      );
    case "default":
      return (
        `Thresholds. No threshold history exists for this period, and no current threshold configuration was ` +
        `found, so readings were evaluated against the built-in default values: CO2 danger ${num(
          th.co2_danger
        )} ppm, LPG danger ${num(th.lpg_danger)} ppm, temperature danger below ${num(
          th.temp_freeze_below
        )} °C or above ${num(
          th.temp_heat_above
        )} °C, humidity danger below ${num(
          th.humidity_dry_below
        )}% or above ${num(th.humidity_mold_above)}%.`
      );
    case "current":
    default:
      return (
        `Thresholds. No historical threshold record exists for this period, so readings were evaluated ` +
        `against the CURRENTLY configured thresholds (effective from ${fmtTs(
          th.effective_from
        )}): CO2 danger ${num(th.co2_danger)} ppm, LPG danger ${num(
          th.lpg_danger
      )} ppm, temperature danger below ${num(
          th.temp_freeze_below
        )} °C or above ${num(
          th.temp_heat_above
        )} °C, humidity danger below ${num(
          th.humidity_dry_below
        )}% or above ${num(th.humidity_mold_above)}%. ` +
        `Values in effect when these readings were originally taken are not recoverable and may have differed.`
      );
  }
}

// ---------------------------------------------------------------------------
// PDF document scaffolding
// ---------------------------------------------------------------------------

export class PdfBuilder {
  doc: PDFDocument;
  page!: PDFPage;
  y!: number;
  regular!: PDFFont;
  bold!: PDFFont;
  italic!: PDFFont;
  pageNumber = 0;
  /** Set by the caller so every page header can repeat the same context. */
  headerLeft = "";
  headerRight = "";

  private constructor(doc: PDFDocument) {
    this.doc = doc;
  }

  static async create(headerLeft: string, headerRight: string): Promise<PdfBuilder> {
    const doc = await PDFDocument.create();
    const [regular, bold, italic] = await Promise.all([
      doc.embedFont(StandardFonts.Helvetica),
      doc.embedFont(StandardFonts.HelveticaBold),
      doc.embedFont(StandardFonts.HelveticaOblique),
    ]);
    const b = new PdfBuilder(doc);
    b.regular = regular;
    b.bold = bold;
    b.italic = italic;
    b.headerLeft = headerLeft;
    b.headerRight = headerRight;
    b.addPage();
    return b;
  }

  addPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pageNumber += 1;
    this.y = PAGE_H - MARGIN;
    this.drawHeader();
  }

  drawHeader(): void {
    this.page.drawRectangle({
      x: 0,
      y: PAGE_H - 34,
      width: PAGE_W,
      height: 34,
      color: COLORS.paper,
    });
    this.page.drawLine({
      start: { x: MARGIN, y: PAGE_H - 34 },
      end: { x: PAGE_W - MARGIN, y: PAGE_H - 34 },
      thickness: 0.7,
      color: COLORS.grid,
    });
    this.page.drawText(this.headerLeft, {
      x: MARGIN,
      y: PAGE_H - 23,
      size: 8.5,
      font: this.bold,
      color: COLORS.muted,
    });
    this.page.drawText(this.headerRight, {
      x: MARGIN,
      y: PAGE_H - 23,
      size: 8.5,
      font: this.regular,
      color: COLORS.faint,
    });
    this.y = PAGE_H - 56;
  }

  drawFooter(): void {
    this.page.drawLine({
      start: { x: MARGIN, y: MARGIN + FOOTER_H },
      end: { x: PAGE_W - MARGIN, y: MARGIN + FOOTER_H },
      thickness: 0.5,
      color: COLORS.grid,
    });
    this.page.drawText("A.I.R. Sensor Monitoring System", {
      x: MARGIN,
      y: MARGIN + 8,
      size: 7.5,
      font: this.regular,
      color: COLORS.faint,
    });
    this.page.drawText(`All times Asia/Manila  |  Page ${this.pageNumber}`, {
      x: PAGE_W - MARGIN - 150,
      y: MARGIN + 8,
      size: 7.5,
      font: this.regular,
      color: COLORS.faint,
    });
  }

  /** Starts a new page when `needed` points will not fit. */
  ensureSpace(needed: number): void {
    if (this.y - needed < CONTENT_BOTTOM) {
      this.drawFooter();
      this.addPage();
    }
  }

  space(pts: number): void {
    this.y -= pts;
  }

  text(
    str: string,
    opts: {
      size?: number;
      bold?: boolean;
      italic?: boolean;
      color?: RGB;
      indent?: number;
      maxWidth?: number;
    } = {}
  ): number {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : opts.italic ? this.italic : this.regular;
    const x = MARGIN + (opts.indent ?? 0);
    const maxWidth = opts.maxWidth ?? CONTENT_W - (opts.indent ?? 0);
    const lines = this.wrap(str, font, size, maxWidth);

    for (const line of lines) {
      this.ensureSpace(size + 3);
      this.page.drawText(line, {
        x,
        y: this.y - size,
        size,
        font,
        color: opts.color ?? COLORS.ink,
      });
      this.y -= size + 3;
    }
    return lines.length;
  }

  wrap(str: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = str.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [""];
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Section heading with a rule underneath. */
  heading(title: string, continuation = false): void {
    this.ensureSpace(34);
    this.space(6);
    this.page.drawText(continuation ? `${title} (continued)` : title, {
      x: MARGIN,
      y: this.y - 13,
      size: 12.5,
      font: this.bold,
      color: COLORS.ink,
    });
    this.space(6);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + CONTENT_W, y: this.y },
      thickness: 1,
      color: COLORS.teal,
    });
    this.space(12);
  }

  subheading(title: string): void {
    this.ensureSpace(24);
    this.space(4);
    this.page.drawText(title, {
      x: MARGIN,
      y: this.y - 11,
      size: 10.5,
      font: this.bold,
      color: COLORS.ink,
    });
    this.space(8);
  }

  rule(): void {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + CONTENT_W, y: this.y },
      thickness: 0.6,
      color: COLORS.grid,
    });
    this.space(10);
  }

  finish(): Promise<Uint8Array> {
    this.drawFooter();
    return this.doc.save();
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  /**
   * Draws a table. `columns` is a list of { header, width, align }.
   * Repeats the header row on every new page and marks the repeat.
   */
  table(
    columns: { header: string; width: number; align?: "left" | "right" }[],
    rows: string[][],
    opts: { rowHeight?: number; headerRepeatLabel?: string } = {}
  ): void {
    const rowHeight = opts.rowHeight ?? 14;
    const drawHeader = (label: string) => {
      this.ensureSpace(rowHeight + 6);
      let x = MARGIN;
      for (const col of columns) {
        this.page.drawText(col.header, {
          x: x + 2,
          y: this.y - 9,
          size: 7.6,
          font: this.bold,
          color: COLORS.muted,
        });
        x += col.width;
      }
      this.space(3);
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: MARGIN + CONTENT_W, y: this.y },
        thickness: 0.7,
        color: COLORS.grid,
      });
      this.space(rowHeight - 4);
      void label;
    };

    drawHeader(columns.map((c) => c.header).join(" "));
    // Keep the header label around for continuation pages.
    const repeatLabel = opts.headerRepeatLabel;

    for (const row of rows) {
      if (this.y - rowHeight < CONTENT_BOTTOM) {
        this.drawFooter();
        this.addPage();
        if (repeatLabel) this.heading(repeatLabel, true);
        else drawHeader("");
      }

      let x = MARGIN;
      row.forEach((cell, i) => {
        const col = columns[i];
        const text = cell ?? "";
        const w = this.regular.widthOfTextAtSize(text, 7.8);
        const tx =
          col.align === "right" ? x + col.width - w - 2 : x + 2;
        this.page.drawText(text, {
          x: Math.max(x + 2, tx),
          y: this.y - 9,
          size: 7.8,
          font: this.regular,
          color: COLORS.ink,
        });
        x += col.width;
      });
      this.space(rowHeight);
      this.page.drawLine({
        start: { x: MARGIN, y: this.y + 3 },
        end: { x: MARGIN + CONTENT_W, y: this.y + 3 },
        thickness: 0.3,
        color: COLORS.grid,
      });
    }
    this.space(6);
  }

  // -------------------------------------------------------------------------
  // Charts
  // -------------------------------------------------------------------------

  /**
   * Line chart for one metric.
   * `series` is an array of { t: epochMs, v: number | null }. Null points are
   * preserved so gaps are drawn as gaps rather than being bridged.
   */
  chart(
    title: string,
    metric: MetricKey,
    th: Thresholds,
    series: { t: number; v: number | null }[],
    xLabel: (t: number) => string
  ): void {
    const H = 230;
    this.ensureSpace(H + 34);
    this.subheading(title);

    const padL = 68;
    const padR = 16;
    const padT = 16;
    const padB = 44;
    const innerW = CONTENT_W - padL - padR;
    const innerH = H - padT - padB;
    const top = this.y;

    this.page.drawRectangle({
      x: MARGIN,
      y: top - H,
      width: CONTENT_W,
      height: H,
      color: COLORS.paper,
      borderColor: COLORS.grid,
      borderWidth: 0.7,
    });
    this.y = top - H;

    // -- Domain ------------------------------------------------------------
    const values = series
      .map((p) => p.v)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    if (values.length === 0) {
      this.page.drawText(
        "No readings were recorded in this period, so no line could be plotted. This is a data gap, not a measurement of zero.",
        { x: MARGIN + 16, y: top - H / 2, size: 9, font: this.italic, color: COLORS.muted }
      );
      this.space(10);
      return;
    }

    const dMin = Math.min(...values);
    const dMax = Math.max(...values);
    const hi = dangerHigh(th, metric);
    const lo = dangerLow(th, metric);
    const warn = warnLine(th, metric);

    let yMin = Math.min(dMin, lo ?? Infinity, warn ?? Infinity);
    let yMax = Math.max(dMax, hi, warn ?? 0);
    const pad = (yMax - yMin) * 0.1 || Math.max(1, Math.abs(yMax) * 0.1);
    yMin -= pad;
    yMax += pad;
    if (metric !== "temp") yMin = Math.max(0, yMin);

    const times = series.map((p) => p.t);
    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    const tSpan = tMax - tMin || 1;

    const px = (t: number) => padL + ((t - tMin) / tSpan) * innerW;
    const py = (v: number) =>
      padT + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

    // -- Grid + Y axis ------------------------------------------------------
    for (let i = 0; i <= 4; i++) {
      const v = yMin + ((yMax - yMin) * i) / 4;
      const y = top - py(v);
      this.page.drawLine({
        start: { x: MARGIN + padL, y },
        end: { x: MARGIN + padL + innerW, y },
        thickness: 0.4,
        color: COLORS.grid,
      });
      this.page.drawText(`${num(v, 1)}`, {
        x: MARGIN + 2,
        y: y - 2.5,
        size: 6.8,
        font: this.regular,
        color: COLORS.faint,
      });
    }
    this.page.drawText(`${METRIC_LABEL[metric]} (${METRIC_UNIT[metric]})`, {
      x: MARGIN + 2,
      y: top - 8,
      size: 6.8,
      font: this.regular,
      color: COLORS.faint,
    });

    // -- Threshold lines ----------------------------------------------------
    const drawThreshold = (v: number, color: RGB, dash: [number, number], label: string) => {
      if (v < yMin || v > yMax) return;
      const y = top - py(v);
      this.page.drawLine({
        start: { x: MARGIN + padL, y },
        end: { x: MARGIN + padL + innerW, y },
        thickness: 0.8,
        color,
        dashArray: dash,
      });
      this.page.drawText(label, {
        x: MARGIN + padL + innerW - 104,
        y: y + 2.5,
        size: 6.5,
        font: this.regular,
        color,
      });
    };
    if (warn !== null) drawThreshold(warn, COLORS.amber, [2, 2], `Warning: ${num(warn)}`);
    drawThreshold(hi, COLORS.red, [3, 2], `Danger: ${num(hi)}`);
    if (lo !== null) drawThreshold(lo, COLORS.red, [3, 2], `Danger low: ${num(lo)}`);

    // -- X axis -------------------------------------------------------------
    for (let i = 0; i <= 5; i++) {
      const t = tMin + (tSpan * i) / 5;
      const x = MARGIN + px(t);
      this.page.drawText(xLabel(t), {
        x: Math.min(x - 22, MARGIN + CONTENT_W - 46),
        y: top - H + 6,
        size: 6.6,
        font: this.regular,
        color: COLORS.faint,
      });
    }

    // -- Polyline, broken across gaps --------------------------------------
    const GAP_MS = 2 * (tSpan / Math.max(1, series.length - 1)) * 2;
    let prev: { x: number; y: number } | null = null;
    for (const p of series) {
      if (p.v === null || !Number.isFinite(p.v)) {
        prev = null;
        continue;
      }
      const x = MARGIN + px(p.t);
      const y = top - py(p.v);
      if (prev && x - prev.x <= GAP_MS) {
        this.page.drawLine({
          start: { x: prev.x, y: prev.y },
          end: { x, y },
          thickness: 1,
          color: COLORS.teal,
        });
      }
      prev = { x, y };
    }

    // -- Peak marker --------------------------------------------------------
    const peakVal = dMax;
    const peakIdx = series.findIndex((p) => p.v === peakVal);
    if (peakIdx >= 0) {
      const x = MARGIN + px(series[peakIdx].t);
      const y = top - py(peakVal);
      this.page.drawCircle({ x, y, size: 2.4, color: COLORS.red });
      this.page.drawText(`Peak ${num(peakVal, 1)}`, {
        x: Math.min(x + 4, MARGIN + CONTENT_W - 70),
        y: Math.max(y + 3, top - H + padT + 2),
        size: 6.6,
        font: this.bold,
        color: COLORS.red,
      });
    }

    this.space(10);
  }

  /** Simple bar chart, used for danger-reading counts per day. */
  dangerBars(daily: DailyRow[], label: (d: string) => string): void {
    const H = 170;
    this.ensureSpace(H + 34);
    this.subheading("Danger-level reading count by day (count of reading rows)");

    const padL = 60;
    const padR = 14;
    const padT = 14;
    const padB = 40;
    const innerW = CONTENT_W - padL - padR;
    const innerH = H - padT - padB;
    const top = this.y;

    this.page.drawRectangle({
      x: MARGIN,
      y: top - H,
      width: CONTENT_W,
      height: H,
      color: COLORS.paper,
      borderColor: COLORS.grid,
      borderWidth: 0.7,
    });
    this.y = top - H;

    const maxCount = Math.max(1, ...daily.map((d) => Number(d.danger_readings ?? 0)));
    const bw = innerW / Math.max(1, daily.length);

    for (let i = 0; i <= 3; i++) {
      const v = (maxCount * i) / 3;
      const y = top - padT - innerH + (innerH * i) / 3;
      this.page.drawLine({
        start: { x: MARGIN + padL, y },
        end: { x: MARGIN + padL + innerW, y },
        thickness: 0.4,
        color: COLORS.grid,
      });
      this.page.drawText(String(Math.round(v)), {
        x: MARGIN + 2,
        y: y - 2.5,
        size: 6.6,
        font: this.regular,
        color: COLORS.faint,
      });
    }

    daily.forEach((d, i) => {
      const c = Number(d.danger_readings ?? 0);
      const x = MARGIN + padL + i * bw;
      if (d.reading_count === 0) {
        // Explicitly distinguish "no data" from "zero danger readings".
        this.page.drawText("no data", {
          x: x + 1,
          y: top - padT - 6,
          size: 5.4,
          font: this.italic,
          color: COLORS.faint,
        });
        return;
      }
      if (c === 0) {
        this.page.drawText("0", {
          x: x + bw / 2 - 1.5,
          y: top - padT - 6,
          size: 5.4,
          font: this.regular,
          color: COLORS.green,
        });
        return;
      }
      const bh = (c / maxCount) * innerH;
      this.page.drawRectangle({
        x: x + bw * 0.15,
        y: top - padT - innerH + innerH - bh,
        width: Math.max(0.8, bw * 0.7),
        height: bh,
        color: COLORS.red,
      });
    });

    // Sparse X labels so they never collide.
    const step = Math.max(1, Math.ceil(daily.length / 12));
    daily.forEach((d, i) => {
      if (i % step !== 0) return;
      this.page.drawText(label(d.day), {
        x: MARGIN + padL + i * bw,
        y: top - H + 6,
        size: 6.2,
        font: this.regular,
        color: COLORS.faint,
      });
    });

    this.space(10);
  }

  /**
   * 12-month bar chart. Distinguishes three states per month, because they mean
   * different things: a bar (readings recorded), an explicit "0" (readings were
   * recorded and none were in the danger band), and "no data" (nothing was
   * recorded at all, which is not the same as a zero count).
   */
  monthBars(
    months: { label: string; value: number; hasData: boolean }[],
    title: string,
    valueSuffix: string,
    opts: { emphasize?: (m: { label: string; value: number; hasData: boolean }) => boolean } = {}
  ): void {
    const H = 210;
    this.ensureSpace(H + 40);
    this.subheading(title);

    const padL = 74;
    const padR = 14;
    const padT = 16;
    const padB = 46;
    const innerW = CONTENT_W - padL - padR;
    const innerH = H - padT - padB;
    const top = this.y;

    this.page.drawRectangle({
      x: MARGIN,
      y: top - H,
      width: CONTENT_W,
      height: H,
      color: COLORS.paper,
      borderColor: COLORS.grid,
      borderWidth: 0.7,
    });
    this.y = top - H;

    const maxValue = Math.max(1, ...months.map((m) => Number(m.value) || 0));
    const bw = innerW / Math.max(1, months.length);
    const anyEmphasised = opts.emphasize ? months.some((m) => opts.emphasize!(m)) : false;

    // Y grid
    for (let i = 0; i <= 3; i++) {
      const v = (maxValue * i) / 3;
      const y = top - padT - innerH + (innerH * i) / 3;
      this.page.drawLine({
        start: { x: MARGIN + padL, y },
        end: { x: MARGIN + padL + innerW, y },
        thickness: 0.4,
        color: COLORS.grid,
      });
      this.page.drawText(num(v), {
        x: MARGIN + 2,
        y: y - 2.5,
        size: 6.8,
        font: this.regular,
        color: COLORS.faint,
      });
    }
    this.page.drawText(valueSuffix, {
      x: MARGIN + 2,
      y: top - 8,
      size: 6.8,
      font: this.regular,
      color: COLORS.faint,
    });

    months.forEach((m, i) => {
      const x = MARGIN + padL + i * bw;
      const emphasised = anyEmphasised && opts.emphasize ? opts.emphasize(m) : false;

      if (!m.hasData) {
        // Explicitly "no data", never a zero-height bar.
        this.page.drawText("no data", {
          x: x + 1,
          y: top - padT - 6,
          size: 5.2,
          font: this.italic,
          color: COLORS.faint,
        });
      } else if (Number(m.value) === 0) {
        this.page.drawText("0", {
          x: x + bw / 2 - 1.5,
          y: top - padT - 6,
          size: 6.2,
          font: this.regular,
          color: COLORS.green,
        });
      } else {
        const h = (Number(m.value) / maxValue) * innerH;
        this.page.drawRectangle({
          x: x + bw * 0.18,
          y: top - padT - innerH + innerH - h,
          width: Math.max(1, bw * 0.64),
          height: h,
          color: emphasised ? COLORS.red : COLORS.teal,
        });
        const label = num(Number(m.value));
        const lw = this.bold.widthOfTextAtSize(label, 6);
        this.page.drawText(label, {
          x: x + bw / 2 - lw / 2,
          y: top - padT - innerH + innerH - h + 3,
          size: 6,
          font: this.bold,
          color: emphasised ? COLORS.red : COLORS.muted,
        });
      }

      this.page.drawText(m.label.slice(0, 3), {
        x: x + 1,
        y: top - H + 8,
        size: 6.4,
        font: this.regular,
        color: COLORS.faint,
      });
    });

    this.space(10);
  }

  note(str: string): void {
    this.ensureSpace(16);
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - 26,
      width: 3,
      height: 30,
      color: COLORS.amber,
    });
    this.text(str, {
      size: 8.6,
      italic: true,
      color: COLORS.muted,
      indent: 11,
      maxWidth: CONTENT_W - 11,
    });
    this.space(6);
  }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

export async function uploadAndVerify(
  admin: AdminClient,
  bucket: string,
  path: string,
  body: Uint8Array,
  contentType: string,
  minBytes = 1024
): Promise<{ ok: true; size: number } | { ok: false; reason: string }> {
  const { error } = await admin.storage
    .from(bucket)
    .upload(path, body, { contentType, upsert: true });

  if (error) return { ok: false, reason: `upload failed: ${error.message}` };

  // Verify by reading the object back out of Storage rather than trusting the
  // upload response. The retention delete requires this to have passed.
  const parent = path.slice(0, path.lastIndexOf("/")) || "";
  const filename = path.slice(path.lastIndexOf("/") + 1);

  const { data, error: listError } = await admin.storage
    .from(bucket)
    .list(parent === "" ? undefined : parent, { search: filename, limit: 10 });

  if (listError) {
    return { ok: false, reason: `verification list failed: ${listError.message}` };
  }

  const match = (data ?? []).find((o) => o.name === filename);
  if (!match) {
    return { ok: false, reason: "verification failed: object not found after upload" };
  }

  // Supabase reports the byte size in metadata.size on list(). If that is
  // absent, fall back to actually downloading the object and measuring it, so
  // verification never silently passes on missing information.
  let size: number | null =
    typeof match.metadata?.size === "number" ? match.metadata.size : null;

  if (size === null) {
    const { data: blob, error: dlError } = await admin.storage
      .from(bucket)
      .download(path);
    if (dlError) {
      return { ok: false, reason: `verification download failed: ${dlError.message}` };
    }
    size = blob?.size ?? 0;
  }

  if (size < minBytes) {
    return {
      ok: false,
      reason: `verification failed: stored size ${size} is below the ${minBytes} byte floor`,
    };
  }
  if (size !== body.length) {
    return {
      ok: false,
      reason: `verification failed: stored size ${size} != uploaded size ${body.length}`,
    };
  }

  return { ok: true, size };
}