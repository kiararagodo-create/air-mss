// src/components/DailyReportPanel.tsx

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import ReportChart, { type ChartPoint } from "./ReportChart";
import {
  fetchDayReadings,
  fmtManila,
  fmtMetric,
  METRIC_LABEL_SHORT,
  METRIC_UNIT_SHORT,
} from "../lib/reportQueries";
import { fmtDayLong, REPORT_TZ, type ReportThresholds } from "../lib/reports";
import { isSensorFault, inRange, isDhtFault, metricValid, plausibleMetricValid } from "../lib/sensorRanges";
import { downloadDayPdf } from "../lib/dayPdf";
import type { MetricKey } from "../lib/sensorRanges";

interface DailyReportPanelProps {
  day: string;
  deviceId: string | null;
  deviceLabel: string;
  thresholds: ReportThresholds;
  rooms?: { id: string; name: string }[];
}

const SENSOR_OPTIONS: MetricKey[] = ["co2", "lpg", "temp", "humidity"];

function isWarningReading(r: { co2: number | null; lpg: number | null; temp: number | null; humidity: number | null }, th: ReportThresholds): boolean {
  if (isSensorFault(r)) return false;
  if (r.co2 !== null && inRange("co2", r.co2) && r.co2 >= th.co2_warning && r.co2 < th.co2_danger) return true;
  if (r.lpg !== null && inRange("lpg", r.lpg) && r.lpg >= th.lpg_warning && r.lpg < th.lpg_danger) return true;
  return false;
}

function isDangerReading(r: { co2: number | null; lpg: number | null; temp: number | null; humidity: number | null }, th: ReportThresholds): boolean {
  if (isSensorFault(r)) return false;
  return (
    (r.co2 !== null && inRange("co2", r.co2) && r.co2 >= th.co2_danger) ||
    (r.lpg !== null && inRange("lpg", r.lpg) && r.lpg >= th.lpg_danger) ||
    (r.temp !== null && inRange("temp", r.temp) && !isDhtFault(r.temp, r.humidity) && (r.temp < th.temp_freeze_below || r.temp > th.temp_heat_above)) ||
    (r.humidity !== null && inRange("humidity", r.humidity) && !isDhtFault(r.temp, r.humidity) && (r.humidity < th.humidity_dry_below || r.humidity > th.humidity_mold_above))
  );
}

function readingStatus(r: { co2: number | null; lpg: number | null; temp: number | null; humidity: number | null }, th: ReportThresholds): "normal" | "warning" | "danger" | "fault" {
  if (isSensorFault(r)) return "fault";
  if (isDangerReading(r, th)) return "danger";
  if (isWarningReading(r, th)) return "warning";
  return "normal";
}

function statusLabel(status: "normal" | "warning" | "danger" | "fault"): string {
  return status === "fault" ? "Sensor fault" : status;
}

function triggeredBy(r: { co2: number | null; lpg: number | null; temp: number | null; humidity: number | null }, th: ReportThresholds): string[] {
  if (isSensorFault(r)) return [];
  const out: string[] = [];
  if (r.co2 !== null && inRange("co2", r.co2) && r.co2 >= th.co2_danger) out.push("CO2");
  if (r.lpg !== null && inRange("lpg", r.lpg) && r.lpg >= th.lpg_danger) out.push("LPG");
  if (r.temp !== null && inRange("temp", r.temp) && !isDhtFault(r.temp, r.humidity) && (r.temp < th.temp_freeze_below || r.temp > th.temp_heat_above)) out.push("Temperature");
  if (r.humidity !== null && inRange("humidity", r.humidity) && !isDhtFault(r.temp, r.humidity) && (r.humidity < th.humidity_dry_below || r.humidity > th.humidity_mold_above)) out.push("Humidity");
  if (out.length > 0) return out;
  const warn: string[] = [];
  if (r.co2 !== null && inRange("co2", r.co2) && r.co2 >= th.co2_warning && r.co2 < th.co2_danger) warn.push("CO2");
  if (r.lpg !== null && inRange("lpg", r.lpg) && r.lpg >= th.lpg_warning && r.lpg < th.lpg_danger) warn.push("LPG");
  return warn;
}

export default function DailyReportPanel({
  day,
  deviceId,
  deviceLabel,
  thresholds,
  rooms = [],
}: DailyReportPanelProps) {
  const [rawReadings, setRawReadings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tablePage, setTablePage] = useState(0);
  const [dangerSearch, setDangerSearch] = useState("");

  // Filters
  const [selectedSensors, setSelectedSensors] = useState<MetricKey[]>(["co2", "lpg", "temp", "humidity"]);
  const [statusFilter, setStatusFilter] = useState<"all" | "normal" | "warning" | "danger" | "fault">("all");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setTablePage(0);
      try {
        const rows = await fetchDayReadings(day, deviceId);
        if (!cancelled) setRawReadings(rows);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load this day.");
          setRawReadings([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [day, deviceId]);

  const filteredReadings = useMemo(() => {
    return rawReadings.filter((r) => {
      const tstr = new Date(r.created_at).toLocaleTimeString("en-GB", {
        timeZone: REPORT_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      if (timeFrom && tstr < timeFrom) return false;
      if (timeTo && tstr > timeTo) return false;
      const fault = isSensorFault(r);
      const danger = isDangerReading(r, thresholds);
      const warning = isWarningReading(r, thresholds);
      const normal = !fault && !danger && !warning;
      if (statusFilter === "normal" && !normal) return false;
      if (statusFilter === "warning" && !warning) return false;
      if (statusFilter === "danger" && !danger) return false;
      if (statusFilter === "fault" && !fault) return false;
      return true;
    });
  }, [rawReadings, timeFrom, timeTo, statusFilter, thresholds]);

  const excludedCounts = useMemo(() => {
    const counts: Record<MetricKey, number> = { co2: 0, lpg: 0, temp: 0, humidity: 0 };
    for (const r of filteredReadings) {
      if (!plausibleMetricValid("co2", r.co2)) counts.co2++;
      if (!plausibleMetricValid("lpg", r.lpg)) counts.lpg++;
      if (!plausibleMetricValid("temp", r.temp)) counts.temp++;
      if (!plausibleMetricValid("humidity", r.humidity)) counts.humidity++;
    }
    return counts;
  }, [filteredReadings]);

  const faultCount = useMemo(() => filteredReadings.filter(isSensorFault).length, [filteredReadings]);

  const metrics = useMemo(() => {
    const result: Record<MetricKey, { min: number | null; avg: number | null; max: number | null; count: number }> = {
      co2: { min: null, avg: null, max: null, count: 0 },
      lpg: { min: null, avg: null, max: null, count: 0 },
      temp: { min: null, avg: null, max: null, count: 0 },
      humidity: { min: null, avg: null, max: null, count: 0 },
    };
    for (const m of SENSOR_OPTIONS) {
      const vals = filteredReadings
        .map((r) => r[m])
        .filter((v: any, i: number) => metricValid(m, v, filteredReadings[i]))
        .filter((v: any) => typeof v === "number" && Number.isFinite(v));
      if (vals.length > 0) {
        result[m].min = Math.min(...vals);
        result[m].max = Math.max(...vals);
        result[m].avg = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
        result[m].count = vals.length;
      }
    }
    return result;
  }, [filteredReadings]);

  const statusCounts = useMemo(() => {
    const counts = { all: rawReadings.length, normal: 0, warning: 0, danger: 0, fault: 0 };
    for (const r of rawReadings) {
      const st = readingStatus(r, thresholds);
      counts[st as keyof typeof counts]++;
    }
    return counts;
  }, [rawReadings, thresholds]);

  const searchedReadings = useMemo(() => {
    const q = dangerSearch.trim().toLowerCase();
    if (!q) return filteredReadings;
    return filteredReadings.filter((r) => {
      const hay = [fmtManila(r.created_at), r.device_id, r.co2, r.lpg, r.temp, r.humidity, statusLabel(readingStatus(r, thresholds))].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [filteredReadings, dangerSearch, thresholds]);

  const READINGS_PAGE_SIZE = 100;
  const readingsTotalPages = Math.max(1, Math.ceil(searchedReadings.length / READINGS_PAGE_SIZE));
  const pagedReadings = useMemo(() => {
    const start = tablePage * READINGS_PAGE_SIZE;
    return searchedReadings.slice(start, start + READINGS_PAGE_SIZE);
  }, [searchedReadings, tablePage]);

  useEffect(() => {
    setTablePage(0);
  }, [statusFilter, timeFrom, timeTo, dangerSearch]);

  // Charts: 5-min buckets
  const charts = useMemo(() => {
    const bucketMs = 5 * 60 * 1000;
    const buckets = new Map<number, any[]>();
    for (const r of filteredReadings) {
      const ts = new Date(r.created_at).getTime();
      const key = Math.floor(ts / bucketMs) * bucketMs;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }
    const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
    const series = sortedKeys.map((k) => {
      const rs = buckets.get(k)!;
      const point: any = { t: k };
      for (const m of SENSOR_OPTIONS) {
        const vals = rs
          .map((r: any) => r[m])
          .filter((v: any, i: number) => metricValid(m, v, rs[i]))
          .filter((v: any) => typeof v === "number" && Number.isFinite(v));
        point[m] = vals.length ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : null;
      }
      return point;
    });

    return selectedSensors.map((m) => {
      const points: ChartPoint[] = series.map((p) => ({ t: p.t, v: p[m] }));
      return { metric: m, points, hasData: points.some((pt) => pt.v !== null) };
    }).filter((c) => c.hasData);
  }, [filteredReadings, selectedSensors]);

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

  function toggleSensor(m: MetricKey) {
    setSelectedSensors((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    );
  }

  function resetFilters() {
    setSelectedSensors(["co2", "lpg", "temp", "humidity"]);
    setStatusFilter("all");
    setTimeFrom("");
    setTimeTo("");
    setDangerSearch("");
  }

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
      </div>
    );
  }

  if (rawReadings.length === 0) return null;

  const handleDownloadDayPdf = async () => {
    const pdfReadings = filteredReadings.map((r) => ({
      created_at: r.created_at,
      device_id: r.device_id,
      co2: r.co2,
      lpg: r.lpg,
      temp: r.temp,
      humidity: r.humidity,
      status: statusLabel(readingStatus(r, thresholds)),
      triggered_by: triggeredBy(r, thresholds),
    }));
    const dangerCount = pdfReadings.filter((r) => r.status === "danger").length;
    const normalCount = pdfReadings.filter((r) => r.status === "normal").length;
    await downloadDayPdf(
      {
       day,
       deviceLabel,
       rooms,
       reading_count: filteredReadings.length,
        danger_readings: dangerCount,
        normal_readings: normalCount,
        metrics: metrics as any,
        excluded: excludedCounts,
        sensor_fault_readings: faultCount,
        thresholds,
        selectedSensors,
        statusFilter,
        timeFrom,
        timeTo,
      },
      charts.flatMap((c) => c.points.map((p) => ({ t: p.t, metric: c.metric, v: p.v }))),
      pdfReadings,
      { selectedSensors, statusFilter, timeFrom, timeTo }
    );
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-500">Sensor:</span>
            {SENSOR_OPTIONS.map((m) => (
              <label key={m} className="flex items-center gap-1 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={selectedSensors.includes(m)}
                  onChange={() => toggleSensor(m)}
                />
                {METRIC_LABEL_SHORT[m]}
              </label>
            ))}
          </div>
          <div>
            <span className="text-xs font-medium text-slate-500 mr-1">Status:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="text-xs border border-slate-200 rounded px-2 py-1"
            >
              <option value="all">All ({statusCounts.all})</option>
              <option value="normal">Normal ({statusCounts.normal})</option>
              <option value="warning">Warning ({statusCounts.warning})</option>
              <option value="danger">Danger ({statusCounts.danger})</option>
              <option value="fault">Sensor fault ({statusCounts.fault})</option>
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-slate-500">Time:</span>
            <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" />
            <span className="text-xs text-slate-400">to</span>
            <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" />
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              value={dangerSearch}
              onChange={(e) => setDangerSearch(e.target.value)}
              placeholder="Search sensor / time..."
              className="pl-8 pr-8 py-1.5 rounded-lg border border-slate-200 text-xs"
            />
          </div>
          <button
            type="button"
            onClick={resetFilters}
            className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            Reset filters
          </button>
          <button
            type="button"
            onClick={handleDownloadDayPdf}
            className="text-xs px-2.5 py-1.5 rounded-lg bg-teal-600 text-white"
          >
            Download Day PDF
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-800">
            {fmtDayLong(day)} - {deviceLabel}
          </h2>
          <span className="text-xs text-slate-400">
            {filteredReadings.length.toLocaleString("en-US")} readings
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {selectedSensors.map((m) => {
            const s = metrics[m];
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

        <p className="text-xs text-slate-500 mt-3">
          Excluded from statistics: Temperature outside 10-50 C, CO2 outside 300-10000 ppm, Humidity outside 5-100%, LPG outside 0-10000 ppm readings (values outside plausible range or suspected sensor fault). Raw data is unchanged.
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Counts: Readings {filteredReadings.length} | Danger {filteredReadings.filter((r) => isDangerReading(r, thresholds)).length} | Days with data {filteredReadings.length > 0 ? 1 : 0} | Suspected sensor-fault {faultCount}
        </p>
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

      {/* Readings table */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-slate-800">
            Readings
            <span className="text-xs font-normal text-slate-400 ml-2">
              {searchedReadings.length.toLocaleString("en-US")} / {rawReadings.length.toLocaleString("en-US")}
            </span>
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {(["all", "normal", "warning", "danger", "fault"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setStatusFilter(opt)}
                className={`text-xs px-2.5 py-1 rounded-full border ${
                  statusFilter === opt
                    ? "bg-slate-700 text-white border-slate-700"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}
              >
                {opt === "all" ? "All" : opt === "normal" ? "Normal" : opt === "warning" ? "Warning" : opt === "danger" ? "Danger" : "Sensor fault"}{" "}
                {statusCounts[opt]}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[760px]">
            <thead>
              <tr className="border-b border-slate-100 text-left text-slate-400 uppercase tracking-wide">
                <th className="py-2 pr-3 font-medium">Time (Asia/Manila)</th>
                <th className="py-2 px-3 font-medium">Room/Device</th>
                <th className="py-2 px-3 font-medium text-right">CO2</th>
                <th className="py-2 px-3 font-medium text-right">LPG</th>
                <th className="py-2 px-3 font-medium text-right">Temp</th>
                <th className="py-2 px-3 font-medium text-right">Humidity</th>
                <th className="py-2 px-3 font-medium">Status</th>
                <th className="py-2 pl-3 font-medium">Triggered By</th>
              </tr>
            </thead>
            <tbody>
              {pagedReadings.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-slate-400">
                    No readings match.
                  </td>
                </tr>
              ) : (
                pagedReadings.map((r, i) => {
                  const st = readingStatus(r, thresholds);
                  const triggered = triggeredBy(r, thresholds);
                  const rowClass =
                    st === "danger"
                      ? "border-b border-slate-50 last:border-0 bg-red-50/60"
                      : st === "warning"
                      ? "border-b border-slate-50 last:border-0 bg-amber-50/40"
                      : "border-b border-slate-50 last:border-0";
                  const statusClass =
                    st === "danger"
                      ? "text-red-600 font-semibold"
                      : st === "warning"
                      ? "text-amber-600 font-semibold"
                      : st === "fault"
                      ? "text-slate-500"
                      : "text-slate-600";
                  return (
                    <tr key={`${r.created_at}-${i}`} className={rowClass}>
                      <td className="py-2 pr-3 text-slate-600 whitespace-nowrap">
                        {fmtManila(r.created_at)}
                      </td>
                      <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                        {rooms.find((rm) => String(rm.id) === String(r.device_id))?.name ?? r.device_id ?? "-"}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-700">{fmtMetric(r.co2, "co2")}</td>
                      <td className="py-2 px-3 text-right text-slate-700">{fmtMetric(r.lpg, "lpg")}</td>
                      <td className="py-2 px-3 text-right text-slate-700">{fmtMetric(r.temp, "temp")}</td>
                      <td className="py-2 px-3 text-right text-slate-700">{fmtMetric(r.humidity, "humidity")}</td>
                      <td className={`py-2 px-3 ${statusClass}`}>{statusLabel(st)}</td>
                      <td className="py-2 pl-3">
                        <span className="text-red-600">{triggered.join(", ")}</span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {readingsTotalPages > 1 && (
          <div className="flex items-center gap-1 text-xs text-slate-500 mt-3">
            <button
              type="button"
              onClick={() => setTablePage((p) => Math.max(0, p - 1))}
              disabled={tablePage === 0}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-40"
            >
              <ChevronLeft size={15} />
            </button>
            <span>
              {tablePage * READINGS_PAGE_SIZE + 1}-{Math.min((tablePage + 1) * READINGS_PAGE_SIZE, searchedReadings.length)}
            </span>
            <button
              type="button"
              onClick={() => setTablePage((p) => Math.min(readingsTotalPages - 1, p + 1))}
              disabled={tablePage >= readingsTotalPages - 1}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-40"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-400">{label}</dt>
      <dd className={bold ? "font-semibold text-slate-700" : "text-slate-600"}>{value}</dd>
    </div>
  );
}
