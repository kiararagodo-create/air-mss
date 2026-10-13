// src/components/DailyReportPanel.tsx
//
// The selected day's data.
//
// Renders nothing at all when the day has no readings - no "no data" banner,
// no empty state, no placeholder card. Only when there is something to show
// does it appear.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import ReportChart, { type ChartPoint } from "./ReportChart";
import {
  DANGER_PAGE_SIZE,
  fetchDangerRows,
  fetchDayDetail,
  fmtManila,
  fmtMetric,
  METRIC_LABEL_SHORT,
  METRIC_ORDER,
  METRIC_UNIT_SHORT,
  type DangerRow,
  type DayDetail,
} from "../lib/reportQueries";
import { fmtDayLong, REPORT_TZ, type ReportThresholds } from "../lib/reports";

interface DailyReportPanelProps {
  day: string;
  deviceId: string | null;
  deviceLabel: string;
  thresholds: ReportThresholds;
}



export default function DailyReportPanel({
  day,
  deviceId,
  deviceLabel,
  thresholds,
}: DailyReportPanelProps) {
  const [detail, setDetail] = useState<DayDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dangerRows, setDangerRows] = useState<DangerRow[]>([]);
  const [dangerPage, setDangerPage] = useState(0);
  const [dangerLoading, setDangerLoading] = useState(false);

  const rpcThresholds = useMemo(
    () => ({
      co2_danger: thresholds.co2_danger,
      lpg_danger: thresholds.lpg_danger,
      temp_freeze_below: thresholds.temp_freeze_below,
      temp_heat_above: thresholds.temp_heat_above,
      humidity_dry_below: thresholds.humidity_dry_below,
      humidity_mold_above: thresholds.humidity_mold_above,
    }),
    [thresholds]
  );

  // ---- day detail ----------------------------------------------------------
  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDangerPage(0);
    try {
      const d = await fetchDayDetail(day, deviceId, rpcThresholds);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load this day.");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [day, deviceId, rpcThresholds]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setDangerPage(0);
      try {
        const d = await fetchDayDetail(day, deviceId, rpcThresholds);
        // Clicking through the calendar faster than the network responds used
        // to let a slower earlier request land last, showing one day's data
        // under another day's heading.
        if (!cancelled) setDetail(d);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load this day.");
          setDetail(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [day, deviceId, rpcThresholds]);

  // ---- danger rows (paged at 250) -----------------------------------------
  const dangerTotal = detail?.danger_readings ?? 0;
  const dangerPages = Math.max(1, Math.ceil(dangerTotal / DANGER_PAGE_SIZE));

  useEffect(() => {
    if (dangerTotal === 0) {
      setDangerRows([]);
      return;
    }
    let cancelled = false;
    setDangerLoading(true);
    fetchDangerRows(day, deviceId, rpcThresholds, dangerPage)
      .then((rows) => {
        if (!cancelled) setDangerRows(rows);
      })
      .catch(() => {
        if (!cancelled) setDangerRows([]);
      })
      .finally(() => {
        if (!cancelled) setDangerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [day, deviceId, rpcThresholds, dangerPage, dangerTotal]);

  // ---- early exits --------------------------------------------------------
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 flex items-center justify-center text-slate-400 text-sm gap-2">
        <Loader2 size={16} className="animate-spin" />
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <p className="text-sm text-red-600">{error}</p>
        <button
          type="button"
          onClick={loadDetail}
          className="mt-2 text-sm text-teal-600 hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  // Nothing recorded: render nothing at all.
  if (!detail || detail.reading_count === 0) return null;

  // ---- charts -------------------------------------------------------------
  // One chart per metric the day actually recorded. Metrics with no readings
  // are skipped entirely rather than drawn as a flat line at zero.
  //
  // Memoised on `detail` alone: ReportChart's useMemo keys on the identity of
  // the points array, so rebuilding these arrays on every render would
  // recompute the scale/segment/tick model for all four charts on every
  // keystroke or pagination of the danger table.
  const charts = useMemo(
    () =>
      METRIC_ORDER.map((m) => {
        const points: ChartPoint[] = detail.series.map((p) => ({
          t: new Date(p.t).getTime(),
          v: p[m],
        }));
        return { metric: m, points, hasData: points.some((pt) => pt.v !== null) };
      }).filter((c) => c.hasData),
    [detail]
  );

  const formatX = useCallback(
    (t: number) =>
      new Date(t).toLocaleTimeString("en-GB", {
        timeZone: REPORT_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    []
  );

  const first = dangerPage * DANGER_PAGE_SIZE;
  const last = Math.min(first + DANGER_PAGE_SIZE, dangerTotal);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-800">
            {fmtDayLong(day)} · {deviceLabel}
          </h2>
          <span className="text-xs text-slate-400">
            {detail.reading_count.toLocaleString("en-US")} readings
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {METRIC_ORDER.map((m) => {
            const s = detail.metrics[m];
            const has = s && s.count > 0;
            return (
              <div key={m} className="rounded-lg bg-slate-50 p-3">
                <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                  {METRIC_LABEL_SHORT[m]}
                  <span className="ml-1 text-slate-400 normal-case">
                    {METRIC_UNIT_SHORT[m]}
                  </span>
                </p>
                <dl className="mt-1.5 space-y-0.5 text-xs">
                  <Row label="Min" value={has ? fmtMetric(s.min, m) : "-"} />
                  <Row label="Avg" value={has ? fmtMetric(s.avg, m) : "-"} bold />
                  <Row label="Max" value={has ? fmtMetric(s.max, m) : "-"} />
                </dl>
              </div>
            );
          })}
        </div>
      </div>

      {/* Charts */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="divide-y divide-slate-100">
          {charts.map(({ metric, points }) => (
            <ReportChart
              key={metric}
              title={`${METRIC_LABEL_SHORT[metric]} through the day`}
              metric={metric}
              thresholds={thresholds}
              points={points}
              dataLabel="5-minute averages"
              height={260}
              formatX={formatX}
            />
          ))}
        </div>
      </div>

      {/* Danger readings */}
      {dangerTotal > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
              <AlertTriangle size={15} className="text-red-500" />
              Danger readings
              <span className="text-xs font-normal text-slate-400">
                {dangerTotal.toLocaleString("en-US")}
              </span>
            </h2>
            {dangerPages > 1 && (
              <div className="flex items-center gap-1 text-xs text-slate-500">
                <button
                  type="button"
                  onClick={() => setDangerPage((p) => Math.max(0, p - 1))}
                  disabled={dangerPage === 0 || dangerLoading}
                  className="p-1 rounded hover:bg-slate-100 disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={15} />
                </button>
                <span>
                  {first + 1}-{last}
                </span>
                <button
                  type="button"
                  onClick={() => setDangerPage((p) => Math.min(dangerPages - 1, p + 1))}
                  disabled={dangerPage >= dangerPages - 1 || dangerLoading}
                  className="p-1 rounded hover:bg-slate-100 disabled:opacity-40"
                  aria-label="Next page"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-slate-400 uppercase tracking-wide">
                  <th className="py-2 pr-3 font-medium">Time (Asia/Manila)</th>
                  <th className="py-2 px-3 font-medium text-right">CO2</th>
                  <th className="py-2 px-3 font-medium text-right">LPG</th>
                  <th className="py-2 px-3 font-medium text-right">Temp</th>
                  <th className="py-2 px-3 font-medium text-right">Humidity</th>
                  <th className="py-2 pl-3 font-medium">Triggered by</th>
                </tr>
              </thead>
              <tbody>
                {dangerLoading && dangerRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-400">
                      <Loader2 size={15} className="animate-spin inline mr-1.5" />
                      Loading...
                    </td>
                  </tr>
                ) : (
                  dangerRows.map((r, i) => (
                    // report_day_danger_rows exposes no surrogate id and nothing guarantees
                    // created_at is unique, so two readings landing in the same
                    // batch share a key. Index-suffixed keys stay stable per row
                    // position and avoid React dropping/reusing rows.
                    <tr key={`${r.created_at}-${i}`} className="border-b border-slate-50 last:border-0">
                      <td className="py-2 pr-3 text-slate-600 whitespace-nowrap">
                        {fmtManila(r.created_at)}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-700">
                        {fmtMetric(r.co2, "co2")}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-700">
                        {fmtMetric(r.lpg, "lpg")}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-700">
                        {fmtMetric(r.temp, "temp")}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-700">
                        {fmtMetric(r.humidity, "humidity")}
                      </td>
                      <td className="py-2 pl-3">
                        <span className="text-red-600">{r.triggered_by.join(", ")}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-400">{label}</dt>
      <dd className={bold ? "font-semibold text-slate-700" : "text-slate-600"}>{value}</dd>
    </div>
  );
}