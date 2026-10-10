// src/lib/reports.ts
//
// Calendar helpers for the Reports page.
//
// EVERY date here is an Asia/Manila CALENDAR value. A "day" is a plain
// "YYYY-MM-DD" string that always means Manila midnight-to-midnight, never
// UTC. The Philippines has no daylight saving, so the offset is a constant
// +08:00 and the arithmetic below is exact rather than an approximation.
//
// This is the browser-side counterpart of the SQL helpers manila_day_start(),
// manila_day_end(), manila_month_start() and manila_month_end(). The two must
// agree: if you change one, change the other.

export const REPORT_TZ = "Asia/Manila";
const MANILA_OFFSET_MINUTES = 480; // UTC+8, no DST

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricKey = "co2" | "lpg" | "temp" | "humidity";

export interface CalendarDay {
  /** Manila calendar date, "YYYY-MM-DD". */
  day: string;
  device_count: number;
  reading_count: number;
  danger_readings: number;
  /** Raw reading rows still exist for this date. */
  has_raw: boolean;
  /** A durable aggregate exists for this date (survives raw deletion). */
  has_archived: boolean;
  /** True for days after today - not selectable. */
  future?: boolean;
}

export interface DailySummary {
  day: string;
  device_id: string;
  reading_count: number;
  first_reading_at: string | null;
  last_reading_at: string | null;
  expected_count: number;
  coverage_pct: number;
  longest_gap_seconds: number;
  gap_count: number;

  co2_min: number | null;
  co2_max: number | null;
  co2_avg: number | null;
  co2_count: number;
  co2_warning_count: number;
  co2_danger_count: number;
  co2_min_at: string | null;
  co2_max_at: string | null;

  lpg_min: number | null;
  lpg_max: number | null;
  lpg_avg: number | null;
  lpg_count: number;
  lpg_warning_count: number;
  lpg_danger_count: number;
  lpg_min_at: string | null;
  lpg_max_at: string | null;

  temp_min: number | null;
  temp_max: number | null;
  temp_avg: number | null;
  temp_count: number;
  temp_danger_count: number;
  temp_min_at: string | null;
  temp_max_at: string | null;

  humidity_min: number | null;
  humidity_max: number | null;
  humidity_avg: number | null;
  humidity_count: number;
  humidity_danger_count: number;
  humidity_min_at: string | null;
  humidity_max_at: string | null;

  danger_readings: number;
  danger_by_metric: Record<string, number>;
  max_recorded_severity: number | null;
  thresholds_used: ReportThresholds | null;
  threshold_source: string | null;
  source: "live" | "archived";
  updated_at: string;
}

export interface ReportThresholds {
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

export interface GraphBucket {
  bucket_start: string;
  reading_count: number;
  co2_avg: number | null;
  co2_min: number | null;
  co2_max: number | null;
  lpg_avg: number | null;
  lpg_min: number | null;
  lpg_max: number | null;
  temp_avg: number | null;
  temp_min: number | null;
  temp_max: number | null;
  humidity_avg: number | null;
  humidity_min: number | null;
  humidity_max: number | null;
  danger_readings: number;
}

export interface DailyBundle {
  device_id: string;
  device_name: string;
  device_floor: string;
  day: string;
  day_start: string;
  day_end: string;
  has_raw: boolean;
  raw_reading_count: number;
  has_archive: boolean;
  source: "raw" | "archived" | "none";
  summary: DailySummary | null;
  graph_buckets: GraphBucket[];
}

export interface MonthlyReport {
  id: number;
  device_id: string;
  month_start: string;
  month_end: string;
  month_label: string;
  generation_status: "pending" | "generating" | "succeeded" | "failed";
  verified: boolean;
  part_count: number;
  pdf_paths: string[];
  csv_path: string | null;
  csv_row_count: number | null;
  reading_count: number;
  danger_reading_count: number;
  stats: Record<string, unknown>;
  daily_rows: unknown[];
  analysis: { paragraphs?: string[]; attention_days?: unknown[] } | null;
  thresholds_used: ReportThresholds | null;
  threshold_source: string | null;
  readings_deleted: boolean;
  readings_deleted_at: string | null;
  deleted_reading_count: number | null;
  device_name: string | null;
  device_floor: string | null;
  error_reason: string | null;
  attempts: number;
  generated_at: string | null;
  created_at: string;
}

/** Legacy weekly rows from the retired 7-day job, preserved and still readable. */
export interface LegacyWeeklyReport {
  id: number;
  device_id: string;
  report_start: string;
  report_end: string;
  pdf_path: string | null;
  pdf_bucket: string | null;
  reading_count: number | null;
  generation_status: string;
  readings_deleted: boolean;
  dominant_status: string | null;
  data_coverage_pct: number | null;
  generated_at: string | null;
}

// ---------------------------------------------------------------------------
// Calendar arithmetic
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD" -> Date at UTC midnight, for pure calendar maths. */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Today in Manila, as "YYYY-MM-DD". */
export function todayManila(): string {
  return manilaDayString(new Date());
}

/** Manila calendar date for an instant. */
export function manilaDayString(instant: string | Date): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Date(d.getTime() + MANILA_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);
}

/** First day of the Manila calendar month containing an instant, "YYYY-MM-01". */
export function manilaMonthStart(instant: string | Date = new Date()): string {
  const day = manilaDayString(instant);
  return `${day.slice(0, 7)}-01`;
}

/** Last day of the Manila calendar month containing an instant, "YYYY-MM-DD". */
export function manilaMonthEnd(instant: string | Date = new Date()): string {
  const start = parseDay(manilaMonthStart(instant));
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

/** Shift a "YYYY-MM-DD" by n days. */
export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Shift a "YYYY-MM-01" by n months. */
export function addMonths(monthStart: string, n: number): string {
  const d = parseDay(monthStart);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  // Clamp: adding a month to e.g. 31 Jan would otherwise overflow.
  const lastDay = new Date(d);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  d.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/** Number of days in the month starting on "YYYY-MM-01". */
export function daysInMonth(monthStart: string): number {
  const d = parseDay(monthStart);
  const end = new Date(d);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.getUTCDate();
}

/** Every day in the month, inclusive of the first and last. */
export function daysOfMonth(monthStart: string): string[] {
  const n = daysInMonth(monthStart);
  return Array.from({ length: n }, (_, i) => addDays(monthStart, i));
}

/**
 * 6x7 grid of "YYYY-MM-DD" strings covering the month, padded with the
 * neighbouring days so the calendar always renders as a full rectangle.
 * `outside` marks the padded cells so they can be dimmed.
 */
export function monthGrid(monthStart: string): { day: string; outside: boolean }[] {
  const first = parseDay(monthStart);
  // getUTCDay() is 0=Sunday. The week starts Monday, matching a PH calendar.
  const leading = (first.getUTCDay() + 6) % 7;

  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - leading);

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    return { day, outside: !day.startsWith(monthStart.slice(0, 7)) };
  });
}

// ---------------------------------------------------------------------------
// Formatting (always Asia/Manila)
// ---------------------------------------------------------------------------

export function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtDayLabel(day: string): string {
  return parseDay(day).toLocaleDateString("en-PH", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function fmtDayLong(day: string): string {
  return parseDay(day).toLocaleDateString("en-PH", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function fmtMonthLabel(monthStart: string): string {
  return parseDay(monthStart).toLocaleDateString("en-PH", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString("en-PH", {
    timeZone: REPORT_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return digits > 0 ? n.toFixed(digits) : Math.round(n).toLocaleString("en-US");
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

export const METRIC_LABEL: Record<MetricKey, string> = {
  co2: "CO2",
  lpg: "LPG",
  temp: "Temperature",
  humidity: "Humidity",
};

export const METRIC_UNIT: Record<MetricKey, string> = {
  co2: "ppm",
  lpg: "ppm",
  temp: "°C",
  humidity: "%",
};

export function metricDigits(m: MetricKey): number {
  return m === "temp" ? 1 : 0;
}

export function dangerHigh(th: ReportThresholds, m: MetricKey): number {
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

export function dangerLow(th: ReportThresholds, m: MetricKey): number | null {
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

export function warnLine(th: ReportThresholds, m: MetricKey): number | null {
  // Temperature and humidity are two-sided here and have no intermediate
  // warning tier configured, so no warning line is drawn for them.
  if (m === "co2") return th.co2_warning;
  if (m === "lpg") return th.lpg_warning;
  return null;
}

/** Was a raw reading row in the danger band? Mirrors reading_is_danger() in SQL. */
export function isDanger(
  r: { co2: number | null; lpg: number | null; temp: number | null; humidity: number | null },
  th: ReportThresholds
): boolean {
  return (
    (r.co2 !== null && r.co2 >= th.co2_danger) ||
    (r.lpg !== null && r.lpg >= th.lpg_danger) ||
    (r.temp !== null && (r.temp < th.temp_freeze_below || r.temp > th.temp_heat_above)) ||
    (r.humidity !== null &&
      (r.humidity < th.humidity_dry_below || r.humidity > th.humidity_mold_above))
  );
}

/**
 * Plain-language statement of which thresholds were applied.
 * Always shown, because it is never safe to assume which ones apply.
 */
export function thresholdNote(th: ReportThresholds | null | undefined): string {
  if (!th) {
    return "No threshold record is available for this date.";
  }
  const base =
    `CO2 danger ${fmtNumber(th.co2_danger)} ppm, LPG danger ${fmtNumber(th.lpg_danger)} ppm, ` +
    `temperature danger below ${fmtNumber(th.temp_freeze_below, 1)} °C or above ${fmtNumber(
      th.temp_heat_above,
      1
    )} °C, humidity danger below ${fmtNumber(th.humidity_dry_below)}% or above ${fmtNumber(
      th.humidity_mold_above
    )}%.`;

  switch (th.threshold_source) {
    case "historical":
      return (
        `Readings were evaluated against the thresholds recorded as in effect at the time ` +
        `(effective ${fmtTimestamp(th.effective_from)}): ${base}`
      );
    case "default":
      return (
        `No threshold history or current configuration was found, so readings were evaluated ` +
        `against the built-in defaults: ${base}`
      );
    default:
      return (
        `No historical threshold record exists for this date, so readings were evaluated against the ` +
        `CURRENTLY configured thresholds (effective ${fmtTimestamp(th.effective_from)}): ${base} ` +
        `The values in effect when these readings were originally taken are not recoverable and ` +
        `may have been different.`
      );
  }
}

/**
 * Coverage sentence. Makes the gap explicit rather than letting an absence of
 * readings read as an absence of problems.
 */
export function coverageNote(
  readingCount: number,
  coveragePct: number,
  longestGapSeconds: number,
  gapCount: number
): string {
  if (readingCount === 0) {
    return "No readings were recorded on this date. Nothing can be concluded about conditions during it.";
  }
  if (coveragePct >= 99.5 && gapCount === 0) {
    return "The full day is covered by recorded readings.";
  }
  const missing = Math.max(0, 100 - coveragePct);
  const gapText =
    gapCount > 0
      ? ` ${gapCount} gap${gapCount === 1 ? "" : "s"} of at least two minutes were recorded within the day, the longest ${fmtDuration(longestGapSeconds)}.`
      : "";
  return (
    `Readings cover ${coveragePct.toFixed(1)}% of the day; roughly ${missing.toFixed(1)}% of the day ` +
    `has no recorded readings.${gapText} What happened during those periods is unknown from this data - ` +
    `they are not counted as safe.`
  );
}