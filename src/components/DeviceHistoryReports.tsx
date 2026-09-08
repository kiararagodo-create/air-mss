import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { Room } from "../data/Data";
import {
  SensorMetric,
  METRIC_LABEL,
  METRIC_UNIT,
  dangerThreshold,
  warnThreshold,
  computeYAxisRange,
  buildYAxisTicks,
} from "../shared/sensorFormat";

// Lightweight inline-SVG line chart. The same primitive is used by the
// server-side PDF generator (see supabase/functions/run-weekly-archive/
// index.ts) so the dashboard chart and the PDF chart stay visually
// identical - same thresholds, same clipping behaviour, same tick logic.

interface DSRow {
  bucket_start: string;
  co2_avg: number | null;
  lpg_avg: number | null;
  temp_avg: number | null;
  humidity_avg: number | null;
}

interface ReportRow {
  id: number;
  device_id: string;
  report_start: string;
  report_end: string;
  pdf_path: string | null;
  reading_count: number;
  generation_status: "pending" | "generating" | "succeeded" | "failed";
  readings_deleted: boolean;
  dominant_status: string | null;
  data_coverage_pct: number | null;
  generated_at: string | null;
  co2_avg: number | null;
  lpg_avg: number | null;
  temp_avg: number | null;
  humidity_avg: number | null;
}

type RangeKey = "1h" | "24h" | "7d";

// Timezone used for all period labels and tick text. Single source of
// truth so dashboard + PDF agree. Adjust if your deployment moves off
// Asia/Manila.
const REPORT_TZ = "Asia/Manila";
const TZ_OPTS: Intl.DateTimeFormatOptions = { timeZone: REPORT_TZ, hour12: true };

const RANGE_TO_HOURS: Record<RangeKey, number> = { "1h": 1, "24h": 24, "7d": 24 * 7 };
const RANGE_TO_BUCKET_SECONDS: Record<RangeKey, number> = {
  "1h": 30,        // 30s buckets for the last hour (~120 points)
  "24h": 5 * 60,   // 5-min buckets for 24h (288 points)
  "7d": 15 * 60,   // 15-min buckets for 7d (672 points)
};

// ESP32 samples every ~3 seconds.
export const EXPECTED_SAMPLE_SECONDS = 3;

interface Props { room: Room }

// Compute the [start, end] window for a range, relative to `now`. Pure
// function so it can be reused for the period label below.
function rangeWindow(range: RangeKey, now: Date): { start: Date; end: Date } {
  return { start: new Date(now.getTime() - RANGE_TO_HOURS[range] * 3600 * 1000), end: now };
}

// Render a human period label, e.g. "Showing readings from 2:00 PM to
// 3:00 PM (Sep 7)".
function periodLabel(range: RangeKey, start: Date, end: Date): string {
  const fmtTime = (d: Date) => d.toLocaleTimeString("en-PH", { ...TZ_OPTS, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const fmtDate = (d: Date) => d.toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: REPORT_TZ });
  if (range === "1h")  return `Showing past readings from ${fmtTime(start)} to ${fmtTime(end)} (${fmtDate(end)})`;
  if (range === "24h") return `Showing past readings from ${fmtTime(start)} to ${fmtTime(end)} (${fmtDate(end)})`;
  return `Showing past readings from ${fmtDate(start)} to ${fmtDate(end)}`;
}

export default function DeviceHistoryReports({ room }: Props) {
  const [range, setRange] = useState<RangeKey>("24h");
  const [series, setSeries] = useState<DSRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowStart, setWindowStart] = useState<Date>(new Date());
  const [windowEnd, setWindowEnd] = useState<Date>(new Date());

  const [reports, setReports] = useState<ReportRow[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);

  // -------- History fetch --------
  const fetchHistory = useCallback(async () => {
    setLoading(true); setError(null);
    const now = new Date();
    const { start, end } = rangeWindow(range, now);
    setWindowStart(start); setWindowEnd(end);
    const { data, error: e } = await supabase.rpc("sensor_readings_downsample", {
      p_device_id: room.id,
      p_window_start: start.toISOString(),
      p_window_end: end.toISOString(),
      p_bucket_seconds: RANGE_TO_BUCKET_SECONDS[range],
    });
    if (e) { setError(e.message); setLoading(false); return; }
    setSeries((data ?? []) as DSRow[]);
    setLoading(false);
  }, [room.id, range]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // Subscribe to new readings so the chart refreshes within ~2s. Filtered
  // to this device_id on the server side via the channel filter.
  useEffect(() => {
    const channel = supabase
      .channel(`history-${room.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "readings", filter: `device_id=eq.${room.id}` },
        () => {
          if ((window as any).__hTimer) clearTimeout((window as any).__hTimer);
          (window as any).__hTimer = setTimeout(() => fetchHistory(), 2000);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [room.id, fetchHistory]);

  // -------- Archived reports list --------
  const fetchReports = useCallback(async () => {
    setReportsLoading(true);
    const { data, error: e } = await supabase
      .from("sensor_reports")
      .select("id, device_id, report_start, report_end, pdf_path, reading_count, generation_status, readings_deleted, dominant_status, data_coverage_pct, generated_at, co2_avg, lpg_avg, temp_avg, humidity_avg")
      .eq("device_id", room.id)
      .order("report_end", { ascending: false })
      .limit(20);
    if (e) { console.error("Failed to load archived reports:", e.message); }
    setReports((data ?? []) as ReportRow[]);
    setReportsLoading(false);
  }, [room.id]);

  useEffect(() => { fetchReports(); }, [fetchReports]);

  const downloadReport = useCallback(async (r: ReportRow) => {
    if (!r.pdf_path) return;
    const { data, error: e } = await supabase.storage.from("sensor-reports").download(r.pdf_path);
    if (e || !data) { alert(`Could not download: ${e?.message ?? "no data"}`); return; }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = r.pdf_path.split("/").pop() ?? "report.pdf";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }, []);

  const viewReport = useCallback(async (r: ReportRow) => {
    if (!r.pdf_path) return;
    const { data } = await supabase.storage.from("sensor-reports").createSignedUrl(r.pdf_path, 60);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    else alert("Could not generate a view link.");
  }, []);

  const label = periodLabel(range, windowStart, windowEnd);

  return (
    <div style={{ marginTop: 14 }}>
      {/* ---------- History ---------- */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>History (past recorded readings)</span>
        <div style={{ display: "flex", gap: 4 }}>
          {(["1h", "24h", "7d"] as RangeKey[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              style={{
                borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 700,
                border: range === r ? "none" : "1px solid #e2e8f0",
                background: range === r ? "#0d9488" : "#fff",
                color: range === r ? "#fff" : "#475569",
                cursor: "pointer",
              }}
            >
              {r === "1h" ? "Last hour" : r === "24h" ? "Last 24 hours" : "Last 7 days"}
            </button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
        {label}
      </div>

      {error ? (
        <div style={{ fontSize: 12, color: "#dc2626", padding: "8px 0" }}>Failed to load history: {error}</div>
      ) : loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8", padding: "8px 0" }}>Loading history...</div>
      ) : series.length === 0 ? (
        <div style={{ border: "1px dashed #e2e8f0", borderRadius: 8, padding: "20px 12px", background: "#fafbfc", textAlign: "center", color: "#64748b", fontSize: 12 }}>
          <div style={{ fontWeight: 700, color: "#475569", marginBottom: 4 }}>No history available for this period</div>
          <div>{room.name} ({room.id}) has no recorded readings in the selected range.</div>
          <div style={{ marginTop: 4, color: "#94a3b8" }}>{label}</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
          <MiniChart metric="co2" data={series.map((r) => [r.bucket_start, r.co2_avg] as const)} range={range} windowStart={windowStart} windowEnd={windowEnd} />
          <MiniChart metric="lpg" data={series.map((r) => [r.bucket_start, r.lpg_avg] as const)} range={range} windowStart={windowStart} windowEnd={windowEnd} />
          <MiniChart metric="temp" data={series.map((r) => [r.bucket_start, r.temp_avg] as const)} range={range} windowStart={windowStart} windowEnd={windowEnd} />
          <MiniChart metric="humidity" data={series.map((r) => [r.bucket_start, r.humidity_avg] as const)} range={range} windowStart={windowStart} windowEnd={windowEnd} />
        </div>
      )}

      {/* ---------- Archived Reports ---------- */}
      <div style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Archived Reports (permanent PDF copies)</span>
          <button type="button" onClick={fetchReports} style={{ fontSize: 12, color: "#0d9488", background: "transparent", border: "none", cursor: "pointer", fontWeight: 700 }}>
            Refresh
          </button>
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
          PDFs survive even after raw readings have been cleared.
        </div>

        {reportsLoading ? (
          <div style={{ fontSize: 12, color: "#94a3b8", padding: "8px 0" }}>Loading archived reports...</div>
        ) : reports.length === 0 ? (
          <div style={{ fontSize: 12, color: "#94a3b8", padding: "8px 0" }}>
            No archived reports for {room.name} yet. Weekly reports are generated automatically every Monday.
          </div>
        ) : (
          <div style={{ border: "1px solid #eef1f4", borderRadius: 8, overflow: "hidden" }}>
            {reports.map((r) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid #f1f5f9", flexWrap: "wrap", gap: 8 }}>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                    {new Date(r.report_start).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" })}
                    {" - "}
                    {new Date(new Date(r.report_end).getTime() - 1).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" })}
                  </span>
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>
                    {r.reading_count} readings - {r.dominant_status ?? "N/A"} - coverage {r.data_coverage_pct?.toFixed(1) ?? "?"}%
                    {r.readings_deleted ? " - raw data cleared" : " - raw data retained"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" onClick={() => viewReport(r)} disabled={r.generation_status !== "succeeded"} style={{ fontSize: 12, fontWeight: 700, padding: "6px 10px", borderRadius: 6, border: "1px solid #99f6e4", background: "#fff", color: "#0d9488", cursor: r.generation_status === "succeeded" ? "pointer" : "not-allowed", opacity: r.generation_status === "succeeded" ? 1 : 0.5 }}>
                    View
                  </button>
                  <button type="button" onClick={() => downloadReport(r)} disabled={r.generation_status !== "succeeded"} style={{ fontSize: 12, fontWeight: 700, padding: "6px 10px", borderRadius: 6, border: "none", background: "#0d9488", color: "#fff", cursor: r.generation_status === "succeeded" ? "pointer" : "not-allowed", opacity: r.generation_status === "succeeded" ? 1 : 0.5 }}>
                    Download
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// MiniChart - inline SVG with:
//   * clip-path so out-of-range points never escape the box
//   * x-axis tick labels (hours for short range, days for multi-day)
//   * threshold lines clipped the same way
//   * Y-axis tick labels with unit suffix (e.g. "1000 ppm", "35°C")
// ---------------------------------------------------------------------
function MiniChart({
  metric, data, range, windowStart, windowEnd,
}: {
  metric: SensorMetric;
  data: ReadonlyArray<readonly [string, number | null]>;
  range: RangeKey;
  windowStart: Date; windowEnd: Date;
}) {
  const title = METRIC_LABEL[metric];
  const unit = METRIC_UNIT[metric];
  const warn = warnThreshold(metric);
  const danger = dangerThreshold(metric);

  const W = 400, H = 180;
  const PAD_L = 85, PAD_R = 12, PAD_T = 12, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const points = useMemo(() => data.filter(([, v]) => v != null && Number.isFinite(v)) as Array<[string, number]>, [data]);

  if (points.length === 0) {
    return (
      <div style={{ border: "1px solid #eef1f4", borderRadius: 8, padding: 10, background: "#fff" }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: "#0f172a" }}>{title} ({unit})</div>
        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>No data for this period</div>
      </div>
    );
  }

  const ys = points.map(([, v]) => v);
  const xMin = windowStart.getTime();
  const xMax = windowEnd.getTime();
  const dataMax = Math.max(...ys);
  const dataMin = Math.min(...ys);
  const { yMin, yMax } = computeYAxisRange(dataMin, dataMax, metric);
  const xR = xMax - xMin || 1, yR = yMax - yMin || 1;

  const sx = (x: number) => PAD_L + ((x - xMin) / xR) * innerW;
  const sy = (y: number) => PAD_T + (1 - (y - yMin) / yR) * innerH;

  const yTicks = useMemo(() => buildYAxisTicks(yMin, yMax, metric, 5), [yMin, yMax, metric]);
  const path = points.map(([t, v], i) => `${i === 0 ? "M" : "L"}${sx(new Date(t).getTime()).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
  const clipId = `clip-${metric}`;
  const ticks = useMemo(() => buildXTicks(range, windowStart, windowEnd), [range, windowStart, windowEnd]);

  return (
    <div style={{ border: "1px solid #eef1f4", borderRadius: 8, padding: 10, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: 12, color: "#0f172a" }}>{title} ({unit})</span>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>
          last {Math.round(ys[ys.length - 1] ?? 0)} {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 170, marginTop: 6 }} preserveAspectRatio="none">
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} />
          </clipPath>
        </defs>
        <rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} fill="#fafbfc" stroke="#eef1f4" />
        <g clipPath={`url(#${clipId})`}>
          {warn != null && warn >= yMin && warn <= yMax && (
            <line x1={PAD_L} x2={PAD_L + innerW} y1={sy(warn)} y2={sy(warn)} stroke="#f59e0b" strokeDasharray="2,2" strokeWidth="0.8" />
          )}
          {danger != null && danger >= yMin && danger <= yMax && (
            <line x1={PAD_L} x2={PAD_L + innerW} y1={sy(danger)} y2={sy(danger)} stroke="#dc2626" strokeDasharray="3,2" strokeWidth="0.8" />
          )}
          <path d={path} fill="none" stroke="#0d9488" strokeWidth="1.4" />
        </g>
        {/* Y-axis tick labels — left side of the chart */}
        {yTicks.map((tk, i) => (
          <g key={i}>
            <line x1={PAD_L - 3} x2={PAD_L} y1={sy(tk.val)} y2={sy(tk.val)} stroke="#cbd5e1" strokeWidth="0.6" />
            <text x={PAD_L - 5} y={sy(tk.val) + 3} fontSize="9" fill="#94a3b8" textAnchor="end">{tk.label}</text>
          </g>
        ))}
        {/* X-axis tick labels */}
        {ticks.map((tk, i) => {
          const x = sx(tk.t);
          const label = tk.label;
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={PAD_T + innerH} y2={PAD_T + innerH + 3} stroke="#cbd5e1" strokeWidth="0.6" />
              <text x={x} y={PAD_T + innerH + 14} fontSize="9" fill="#94a3b8" textAnchor="middle">{label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Build ~5-8 evenly-spaced tick marks for the x-axis.
// Short range (1h): 8:00 AM, 10:00 AM, 12:00 PM, 2:00 PM
// Multi-day range (24h, 7d): Sep 1, Sep 2, Sep 3
function buildXTicks(range: RangeKey, start: Date, end: Date): { t: number; label: string }[] {
  const ticks: { t: number; label: string }[] = [];
  const total = end.getTime() - start.getTime();
  if (total <= 0) return ticks;
  const STEP_COUNT = range === "1h" ? 5 : 7;

  for (let i = 0; i <= STEP_COUNT; i++) {
    const t = start.getTime() + (total * i) / STEP_COUNT;
    const d = new Date(t);
    let label: string;
    if (range === "1h") {
      label = d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
    } else if (range === "24h") {
      label = d.toLocaleTimeString("en-PH", { hour: "numeric" });
    } else {
      label = d.toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: REPORT_TZ });
    }
    ticks.push({ t, label });
  }
  return ticks;
}