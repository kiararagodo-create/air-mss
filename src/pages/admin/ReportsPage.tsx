import { useEffect, useMemo, useState } from "react";
import { MessageCircle } from "lucide-react";
import ReportCalendar from "../../components/ReportCalendar";
import DailyReportPanel from "../../components/DailyReportPanel";
import MonthlyReportGrid from "../../components/MonthlyReportGrid";
import { fetchCalendarMonth, fetchMonthStats, type CalendarDayRow } from "../../lib/reportQueries";
import {
  manilaDayString,
  manilaMonthStart,
  type ReportThresholds,
} from "../../lib/reports";
import { downloadMonthlyPdf } from "../../lib/monthlyPdf";
import type { Room, Thresholds } from "../../data/Data";

interface ReportsPageProps {
  rooms: Room[];
  thresholds: Thresholds;
}

/** Flat Thresholds (from RoomsContext) -> the ReportThresholds shape the panels want. */
function toReportThresholds(th: Thresholds): ReportThresholds {
  return {
    threshold_source: "current",
    co2_warning: th.co2.warning,
    co2_high: th.co2.high,
    co2_danger: th.co2.danger,
    lpg_warning: th.lpg.warning,
    lpg_high: th.lpg.high,
    lpg_danger: th.lpg.danger,
    temp_freeze_below: th.temp.freezeBelow,
    temp_cool_below: th.temp.coolBelow,
    temp_heat_above: th.temp.heatAbove,
    humidity_dry_below: th.humidity.dryBelow,
    humidity_low_below: th.humidity.lowBelow,
    humidity_mold_above: th.humidity.moldAbove,
  };
}

interface ReportsPageState {
  year: number;
  deviceId: string;
  monthStart: string;
  selectedDay: string | null;
  days: CalendarDayRow[];
  loading: boolean;
  error: string | null;
  refreshKey: number;
  // PDF report state
  pdfLoading: boolean;
  pdfError: string | null;
  // Filter state for PDF download
  pdfDateRangeStart: string; // ISO date
  pdfDateRangeEnd: string; // ISO date
  pdfGeneratedBy: string;
  pdfIncludeRawDanger: boolean;
}

function defaultState(): ReportsPageState {
  const now = new Date();
  const todayManila = manilaDayString(now);
  const currentYear = Number(todayManila.slice(0, 4));
  return {
    year: currentYear,
    deviceId: "all",
    monthStart: manilaMonthStart(now),
    selectedDay: null,
    days: [],
    loading: true,
    error: null,
    refreshKey: 0,
    pdfLoading: false,
    pdfError: null,
    pdfDateRangeStart: "",
    pdfDateRangeEnd: "",
    pdfGeneratedBy: "Admin",
    pdfIncludeRawDanger: false,
  };
}

export default function ReportsPage({ rooms, thresholds }: ReportsPageProps) {
  const [state, setState] = useState<ReportsPageState>(defaultState());
  const userRole = (localStorage.getItem("userRole") as "admin" | "maintenance" | "security" | "all" || "all");

  const reportThresholds = useMemo(() => toReportThresholds(thresholds), [thresholds]);

  // Years offered: current year + 4 back, no future years.
  const years = useMemo(
    () => Array.from({ length: 5 }, (_, i) => state.year - i),
    [state.year]
  );

  // The device filter. readings.device_id is rooms.id, so this single control
  // covers both "device" and "room".
  const selectedRoom = rooms.find((r) => String(r.id) === state.deviceId) ?? null;
  const deviceLabel = selectedRoom ? selectedRoom.name : "All rooms";
  const effectiveDeviceId = state.deviceId === "all" ? null : state.deviceId;

  const rpcThresholds = useMemo(
    () => ({
      co2_danger: reportThresholds.co2_danger,
      lpg_danger: reportThresholds.lpg_danger,
      temp_freeze_below: reportThresholds.temp_freeze_below,
      temp_heat_above: reportThresholds.temp_heat_above,
      humidity_dry_below: reportThresholds.humidity_dry_below,
      humidity_mold_above: reportThresholds.humidity_mold_above,
    }),
    [reportThresholds]
  );

  // --- Calendar / days loading ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const rows = await fetchCalendarMonth(state.monthStart, effectiveDeviceId, rpcThresholds);
        if (!cancelled) setState((s) => ({ ...s, days: rows, loading: false }));
      } catch (e) {
        if (!cancelled) {
          setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Failed to load the calendar." }));
          setState((s) => ({ ...s, days: [] }));
        }
      } finally {
        setState((s) => ({ ...s, loading: false }));
      }
    })();
    return () => { cancelled = true; };
  }, [state.monthStart, effectiveDeviceId, rpcThresholds, state.refreshKey]);

  function handleYearChange(next: number) {
    setState((s) => ({ ...s, year: next, monthStart: `${next}-01-01`, selectedDay: null, days: [] }));
    setState((s) => ({ ...s, refreshKey: s.refreshKey + 1 }));
  }

  function handleMonthChange(next: string) {
    // next is expected "YYYY-MM-01"
    setState((s) => ({ ...s, monthStart: next, selectedDay: null }));
    setState((s) => ({ ...s, days: [] }));
  }

  function handleDeviceChange(next: string) {
    setState((s) => ({ ...s, deviceId: next, selectedDay: null }));
    setState((s) => ({ ...s, days: [] }));
  }

  // --- Handle Download Report PDF ---
  const handleDownloadReportPdf = async () => {
    setState((s) => ({ ...s, pdfLoading: true, pdfError: null }));

    try {
      const [yearStr, monthStr] = state.monthStart.split("-");
      const yearNum = Number(yearStr);
      const monthNum = Number(monthStr);

      // The monthly PDF generator (monthlyPdf.ts) takes a MonthStats
      // aggregate from the report_month_stats RPC — same path as
      // MonthlyReportGrid's per-month downloads — not raw readings/alerts.
      // Passing the raw-grid shape here made data.readings undefined,
      // which crashed the PDF with "Cannot read properties of undefined
      // (reading 'length')".
      const stats = await fetchMonthStats(yearNum, monthNum, effectiveDeviceId, rpcThresholds);
      let rawDangerRows: any[] | undefined;
      if (state.pdfIncludeRawDanger) {
        const total = stats.danger_readings ?? 0;
        const pages = Math.max(1, Math.ceil(total / 40));
        const ok = window.confirm(`Including the full raw danger readings table will add about ${pages} pages. Continue?`);
        if (!ok) {
          setState((s) => ({ ...s, pdfLoading: false }));
          return;
        }
        rawDangerRows = [];
        let page = 0;
        while (true) {
          const rows = await (await import("../../lib/reportQueries")).fetchMonthDangerRows(yearNum, monthNum, effectiveDeviceId, rpcThresholds, page);
          rawDangerRows.push(...rows);
          if (rows.length < 250) break;
          page++;
        }
      }
      await downloadMonthlyPdf(stats, { deviceLabel, year: yearNum, month: monthNum }, { rawDangerRows, includeRawDanger: state.pdfIncludeRawDanger, rooms });

      setState((s) => ({ ...s, pdfLoading: false }));
    } catch (e) {
      console.error("PDF generation failed:", e);
      setState((s) => ({ ...s, pdfError: e instanceof Error ? e.message : "Unknown error", pdfLoading: false }));
    }
  };

  // --- UI ---
  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      {/* ---- Header ------------------------------------------------------- */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Environmental Quality Reports</h1>

        <div className="flex items-center gap-2">
          {/* Device / Room filter */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              Device / Room
            </label>
            <select
              value={state.deviceId}
              onChange={(e) => e.target && handleDeviceChange(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
            >
              <option value="all">All rooms</option>
              {rooms.map((r) => (
                <option key={String(r.id)} value={String(r.id)}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          {/* Year selector */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Year</label>
            <select
              value={state.year}
              onChange={(e) => e.target && handleYearChange(Number(e.target.value))}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          {/* Calendar */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Month</label>
            <select
              value={state.monthStart.slice(5, 7)}
              onChange={(e) => e.target && handleMonthChange(`${state.year}-${Number(e.target.value).toString().padStart(2, "0")}-01`)}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => (
                <option key={m} value={m}>
                  {new Date(0, m - 1).toLocaleString("en-US", { month: "long" })} {state.year}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ---- Calendar ----------------------------------------------------- */}
      <div className="mb-4">
        <ReportCalendar
          monthStart={state.monthStart}
          onMonthChange={handleMonthChange}
          days={state.days}
          selectedDay={state.selectedDay}
          onSelectDay={(day: string) => setState((s) => ({ ...s, selectedDay: day }))}
          today={manilaDayString(new Date())}
        />
      </div>

      {state.error && (
        <p className="text-xs text-red-600 mb-3">{state.error}</p>
      )}

      {/* ---- Selected day ------------------------------------------------- */}
      {state.selectedDay && (
        <div className="mb-6">
          <DailyReportPanel
            key={`${state.selectedDay}-${state.deviceId}-${state.refreshKey}`}
            day={state.selectedDay}
            deviceId={effectiveDeviceId}
            deviceLabel={deviceLabel}
            thresholds={reportThresholds}
            rooms={rooms}
          />
        </div>
      )}

      {/* ---- Monthly reports by year -------------------------------------- */}
      <MonthlyReportGrid
        year={state.year}
        deviceId={effectiveDeviceId}
        deviceLabel={deviceLabel}
        thresholds={reportThresholds}
        currentYear={Number(state.monthStart.slice(0, 4))}
        currentMonth={Number(state.monthStart.slice(5, 7))}
        rooms={rooms}
      />

      {/* ---- Download Report PDF section -------------------------------------- */}
      <div className="mt-6 p-4 rounded-lg" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
        {userRole === "admin" || userRole === "maintenance" ? (
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={() => handleDownloadReportPdf()}
              disabled={state.pdfLoading}
              style={{
                background: "#0d9488",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "10px 16px",
                fontSize: 13,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <MessageCircle size={15} /> Download Report PDF
            </button>

            {state.pdfLoading && (
              <span style={{ color: "#64748b", fontSize: 12 }}>
                Generating PDF...
              </span>
            )}
            <label style={{ fontSize: 12, color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={state.pdfIncludeRawDanger}
                onChange={(e) => setState((s) => ({ ...s, pdfIncludeRawDanger: e.target.checked }))}
              />
              Include full raw danger readings table
            </label>

            {state.pdfError && (
              <span style={{ color: "#dc2626", fontSize: 12 }}>
                {state.pdfError}
              </span>
            )}
          </div>
        ) : (
          <p style={{ color: "#64748b", fontSize: 12, margin: "0 0 0 44" }}>
            PDF download available for Admin/Maintenance roles only.
          </p>
        )}
      </div>
    </div>
  );
}