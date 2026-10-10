// src/pages/admin/ReportsPage.tsx
//
// Environmental Quality Reports & Logs.
//
// Layout, top to bottom:
//   1. Year selector (default: current year)
//   2. Device / Room filter
//   3. Month calendar with data dots
//   4. The selected day's data
//   5. The 12 months of the selected year, each with a PDF download
//
// Every day and month boundary is Asia/Manila.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import ReportCalendar from "../../components/ReportCalendar";
import DailyReportPanel from "../../components/DailyReportPanel";
import MonthlyReportGrid from "../../components/MonthlyReportGrid";
import {
  fetchCalendarMonth,
  type CalendarDayRow,
} from "../../lib/reportQueries";
import { manilaDayString, manilaMonthStart, type ReportThresholds } from "../../lib/reports";
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

export default function ReportsPage({ rooms, thresholds }: ReportsPageProps) {
  const now = new Date();
  const todayManila = manilaDayString(now);
  const currentYear = Number(todayManila.slice(0, 4));
  const currentMonth = Number(todayManila.slice(5, 7));

  const [year, setYear] = useState<number>(currentYear);
  const [deviceId, setDeviceId] = useState<string>("all");
  const [monthStart, setMonthStart] = useState<string>(() => manilaMonthStart(now));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const [days, setDays] = useState<CalendarDayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const reportThresholds = useMemo(() => toReportThresholds(thresholds), [thresholds]);

  // Years offered: the current year plus four back, no future years.
  const years = useMemo(
    () => Array.from({ length: 5 }, (_, i) => currentYear - i),
    [currentYear]
  );

  // The device filter. readings.device_id is rooms.id, so this single control
  // covers both "device" and "room".
  const selectedRoom = rooms.find((r) => String(r.id) === deviceId) ?? null;
  const deviceLabel = selectedRoom ? selectedRoom.name : "All rooms";
  const effectiveDeviceId = deviceId === "all" ? null : deviceId;

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

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchCalendarMonth(monthStart, effectiveDeviceId, rpcThresholds);
      setDays(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the calendar.");
      setDays([]);
    } finally {
      setLoading(false);
    }
  }, [monthStart, effectiveDeviceId, rpcThresholds, refreshKey]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  // Changing year moves the calendar to January of that year, and clears the
  // selected day so a stale day from another year cannot be shown.
  function handleYearChange(next: number) {
    setYear(next);
    setMonthStart(`${next}-01-01`);
    setSelectedDay(null);
  }

  function handleMonthChange(next: string) {
    setMonthStart(next);
    setSelectedDay(null);
  }

  function handleDeviceChange(next: string) {
    setDeviceId(next);
    setSelectedDay(null);
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      {/* ---- Header ------------------------------------------------------- */}
      <div className="flex items-start justify-between gap-3 mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Environmental Quality Reports</h1>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          aria-label="Refresh"
          className="shrink-0 p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      </div>

      {/* ---- Filters ------------------------------------------------------ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Year</label>
          <select
            value={year}
            onChange={(e) => handleYearChange(Number(e.target.value))}
            className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">
            Device / Room
          </label>
          <select
            value={deviceId}
            onChange={(e) => handleDeviceChange(e.target.value)}
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
      </div>

      {error && (
        <p className="text-xs text-red-600 mb-3">{error}</p>
      )}

      {/* ---- Calendar ----------------------------------------------------- */}
      <div className="mb-4">
        <ReportCalendar
          monthStart={monthStart}
          onMonthChange={handleMonthChange}
          days={days}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          today={todayManila}
        />
      </div>

      {/* ---- Selected day ------------------------------------------------- */}
      {selectedDay && (
        <div className="mb-6">
          <DailyReportPanel
            key={`${selectedDay}-${deviceId}-${refreshKey}`}
            day={selectedDay}
            deviceId={effectiveDeviceId}
            deviceLabel={deviceLabel}
            thresholds={reportThresholds}
          />
        </div>
      )}

      {/* ---- Monthly reports by year -------------------------------------- */}
      <MonthlyReportGrid
        year={year}
        deviceId={effectiveDeviceId}
        deviceLabel={deviceLabel}
        thresholds={reportThresholds}
        currentYear={currentYear}
        currentMonth={currentMonth}
      />
    </div>
  );
}