// src/lib/reportQueries.ts
//
// Typed access to the simplified Reports RPCs created by migration
// 20260914000000_reports_simplified.sql.
//
// Everything is a direct aggregate from public.readings. There is no
// daily_summaries / graph_buckets / monthly_reports table, and no edge
// function: the browser generates PDFs itself.
//
// All day and month boundaries are Asia/Manila.

import { supabase } from "./supabase";
import type { MetricKey, ReportThresholds } from "./reports";

export type { MetricKey, ReportThresholds };

export const REPORT_TZ = "Asia/Manila";
export const DANGER_PAGE_SIZE = 250;

export interface CalendarDayRow {
  day: string;
  reading_count: number;
  danger_readings: number;
  co2_danger: number;
  lpg_danger: number;
  temp_danger: number;
  humidity_danger: number;
}

export interface MetricStats {
  min: number | null;
  avg: number | null;
  max: number | null;
  count: number;
  unit: string;
}

export interface SeriesPoint {
  t: string;
  co2: number | null;
  lpg: number | null;
  temp: number | null;
  humidity: number | null;
}

export interface DangerByMetric {
  co2: number;
  lpg: number;
  temp: number;
  humidity: number;
}

export interface DayDetail {
  day: string;
  reading_count: number;
  danger_readings: number;
  danger_by_metric: DangerByMetric;
  metrics: Record<MetricKey, MetricStats>;
  series: SeriesPoint[];
}

export interface DangerRow {
  created_at: string;
  device_id: string;
  co2: number | null;
  lpg: number | null;
  temp: number | null;
  humidity: number | null;
  triggered_by: string[];
}

export interface DailyMonthRow {
  day: string;
  reading_count: number;
  danger_readings: number;
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
}

/** Per-metric daily fields, so callers can index by metric without `any`. */
export type DailyMetricField = `${MetricKey}_avg` | `${MetricKey}_min` | `${MetricKey}_max`;

/**
 * The flat threshold map the report RPCs both accept and return.
 *
 * `report_thresholds(p_thresholds)` resolves every key against the configured
 * defaults, so all six are always present on the way back. This type exists so
 * the six snake_case key names are checked at compile time: the RPC payload was
 * previously declared as the richer client `ReportThresholds`, which has keys
 * like `threshold_source` that the RPC never returns, so every consumer had to
 * cast to `Record<string, number>` and a misspelled key compiled clean and
 * resolved to `undefined` at runtime.
 */
export interface ReportRpcThresholds {
  co2_danger: number;
  lpg_danger: number;
  temp_freeze_below: number;
  temp_heat_above: number;
  humidity_dry_below: number;
  humidity_mold_above: number;
}

export interface MonthStats {
  year: number;
  month: number;
  device_id: string | null;
  reading_count: number;
  danger_readings: number;
  days_with_data: number;
  days_with_danger: number;
  thresholds: ReportRpcThresholds;
  danger_by_metric: DangerByMetric;
  metrics: Record<MetricKey, MetricStats>;
  daily: DailyMonthRow[];
  worst_day: { day: string; danger_readings: number; reading_count: number } | null;
}

// ---------------------------------------------------------------------------
// Thresholds: the flat client Thresholds object -> the jsonb the RPCs want.
// report_thresholds() fills any missing key with a safe default, so partial
// input is fine.
// ---------------------------------------------------------------------------

export function toRpcThresholds(th: {
  co2: { danger: number };
  lpg: { danger: number };
  temp: { freezeBelow: number; heatAbove: number };
  humidity: { dryBelow: number; moldAbove: number };
}): ReportRpcThresholds {
  return {
    co2_danger: th.co2.danger,
    lpg_danger: th.lpg.danger,
    temp_freeze_below: th.temp.freezeBelow,
    temp_heat_above: th.temp.heatAbove,
    humidity_dry_below: th.humidity.dryBelow,
    humidity_mold_above: th.humidity.moldAbove,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Calls an approval-guarded RPC, falling back to the unguarded original if the
 * wrapper has not been created yet.
 *
 * The guard lives in `20260916000000_production_hardening.sql`. Until that
 * migration is applied to a project, PostgREST rejects the call with PGRST202
 * ("Could not find the function") and the whole Reports page would go dark.
 * This keeps the deploy order-independent: the frontend can ship first.
 *
 * The fallback is safe. It is not a hole in the guard, because the underlying
 * functions are SECURITY INVOKER and read public.readings, whose RLS policy
 * independently requires is_approved_account(). The wrapper only makes that
 * requirement explicit at the entry point and returns a clear message instead
 * of an empty result.
 */
async function rpcWithApprovalGuard<T>(
  guarded: string,
  unguarded: string,
  params: Record<string, unknown>
): Promise<T> {
  const first = await supabase.rpc(guarded, params);
  if (!first.error) return first.data as T;

  // PGRST202 = the wrapper is not in the schema cache yet.
  if (first.error.code === "PGRST202") {
    const fallback = await supabase.rpc(unguarded, params);
    if (!fallback.error) return fallback.data as T;
    throw new Error(fallback.error.message);
  }
  throw new Error(first.error.message);
}

/** Per-day counts for one month - drives the calendar dots. */
export async function fetchCalendarMonth(
  monthStart: string,
  deviceId: string | null,
  thresholds: Record<string, number>
): Promise<CalendarDayRow[]> {
  const { data, error } = await supabase.rpc("report_calendar_month", {
    p_month_start: monthStart,
    p_device_id: deviceId,
    p_thresholds: thresholds,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as CalendarDayRow[];
}

/** Min/avg/max plus a bucketed series for one day. */
export async function fetchDayDetail(
  day: string,
  deviceId: string | null,
  thresholds: Record<string, number>
): Promise<DayDetail> {
  const data = await rpcWithApprovalGuard<DayDetail>(
    "report_day_detail_approved",
    "report_day_detail",
    {
      p_day: day,
      p_device_id: deviceId,
      p_thresholds: thresholds,
      p_bucket_seconds: 300,
    }
  );
  // PostgREST returns null - not an error - when an RPC yields no value or is
  // missing from the schema cache. Casting that null to DayDetail let the day
  // panel silently render nothing instead of reporting the failure.
  if (!data) throw new Error("report_day_detail returned no data.");
  return data;
}

/** One page of danger readings for a day. */
export async function fetchDangerRows(
  day: string,
  deviceId: string | null,
  thresholds: Record<string, number>,
  page: number
): Promise<DangerRow[]> {
  const { data, error } = await supabase.rpc("report_day_danger_rows", {
    p_day: day,
    p_device_id: deviceId,
    p_thresholds: thresholds,
    p_limit: DANGER_PAGE_SIZE,
    p_offset: page * DANGER_PAGE_SIZE,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as DangerRow[];
}

/** Whole-month summary and per-day series for the PDF. */
export async function fetchMonthStats(
  year: number,
  month: number,
  deviceId: string | null,
  thresholds: Record<string, number>
): Promise<MonthStats> {
  const stats = await rpcWithApprovalGuard<MonthStats>(
    "report_month_stats_approved",
    "report_month_stats",
    {
      p_year: year,
      p_month: month,
      p_device_id: deviceId,
      p_thresholds: thresholds,
    }
  );
  if (!stats) throw new Error("report_month_stats returned no data.");
  return stats;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtMetric(n: number | null | undefined, metric: MetricKey): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return metric === "temp" ? n.toFixed(1) : Math.round(n).toLocaleString("en-US");
}

/** Timestamp in Asia/Manila, e.g. "05 Jan 2026, 14:32". */
export function fmtManila(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", {
    timeZone: REPORT_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
  })}, ${d.toLocaleTimeString("en-GB", {
    timeZone: REPORT_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const METRIC_LABEL_SHORT: Record<MetricKey, string> = {
  co2: "CO2",
  lpg: "LPG",
  temp: "Temperature",
  humidity: "Humidity",
};

export const METRIC_UNIT_SHORT: Record<MetricKey, string> = {
  co2: "ppm",
  lpg: "ppm",
  temp: "°C",
  humidity: "%",
};

export const METRIC_ORDER: MetricKey[] = ["co2", "lpg", "temp", "humidity"];