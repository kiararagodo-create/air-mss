// src/components/MonthlyReportGrid.tsx
//
// The 12 months of the selected year.
//
// A month is downloadable when it is in the past AND has at least one reading.
// Months that have not happened yet, and months with no readings, are hidden -
// there is nothing to download for them and an empty button is just noise.
//
// The PDF is generated in the browser by lib/monthlyPdf.ts.

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Search, X } from "lucide-react";
import {
  MONTH_NAMES,
  fetchCalendarMonth,
  fetchMonthStats,
  fetchMonthReadings,
  type MonthStats,
} from "../lib/reportQueries";
import { downloadMonthlyPdf } from "../lib/monthlyPdf";
import type { ReportThresholds } from "../lib/reports";

interface MonthlyReportGridProps {
  year: number;
  deviceId: string | null;
  deviceLabel: string;
  thresholds: ReportThresholds;
  currentYear: number;
  currentMonth: number;
  rooms?: { id: string; name: string }[];
}

interface MonthEntry {
  month: number;
  readingCount: number;
  dangerCount: number;
  invalidCount: number;
}

export default function MonthlyReportGrid({
  year,
  deviceId,
  deviceLabel,
  thresholds,
  currentYear,
  currentMonth,
  rooms = [],
}: MonthlyReportGridProps) {
  const [months, setMonths] = useState<MonthEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyMonth, setBusyMonth] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");


  const rpcThresholds = {
    co2_danger: thresholds.co2_danger,
    lpg_danger: thresholds.lpg_danger,
    temp_freeze_below: thresholds.temp_freeze_below,
    temp_heat_above: thresholds.temp_heat_above,
    humidity_dry_below: thresholds.humidity_dry_below,
    humidity_mold_above: thresholds.humidity_mold_above,
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);

      // Work out which months to ask for BEFORE issuing any request. The
      // previous version fetched all twelve and only afterwards discarded the
      // future ones, so every page mount fired up to 12 concurrent PostgREST
      // RPCs of which the ones past the current month were guaranteed empty.
      const monthsToFetch: number[] = [];
      for (let m = 1; m <= 12; m++) {
        if (year > currentYear || (year === currentYear && m > currentMonth)) continue;
        monthsToFetch.push(m);
      }

      try {
        const rows = await Promise.all(
          monthsToFetch.map((month) =>
            fetchCalendarMonth(
              `${year}-${String(month).padStart(2, "0")}-01`,
              deviceId,
              rpcThresholds
            )
          )
        );

        const entries: MonthEntry[] = [];
        rows.forEach((days, i) => {
          const month = monthsToFetch[i];
          const readingCount = days.reduce((sum, d) => sum + Number(d.reading_count), 0);
          if (readingCount === 0) return;

          entries.push({
            month,
            readingCount,
            dangerCount: days.reduce((sum, d) => sum + Number(d.danger_readings), 0),
            invalidCount: days.reduce((sum, d) => sum + Number(d.invalid_count ?? 0), 0),
          });
        });
        // Most recent month first (Nov before Oct before Sep), not Jan->Dec.
        entries.sort((a, b) => b.month - a.month);
        if (!cancelled) setMonths(entries);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load months.");
          setMonths([]);
        }
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, deviceId, currentYear, currentMonth, JSON.stringify(rpcThresholds)]);

  const visibleMonths = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return months;
    return months.filter((e) => {
      const name = MONTH_NAMES[e.month - 1].toLowerCase();
      const hay = `${name} ${year} ${e.month} ${e.readingCount} ${e.dangerCount} ${e.invalidCount}`.toLowerCase();
      return hay.includes(q);
    });
  }, [months, search, year]);

  async function download(month: number) {
    // One PDF at a time: without this, clicking Jan then Feb lets Jan's
    // finally clear busyMonth while Feb is still generating, which re-enables
    // the Jan button and lets a user stack downloads.
    if (busyMonth !== null) return;
    setBusyMonth(month);
    setError(null);
    try {
      const stats: MonthStats = await fetchMonthStats(year, month, deviceId, rpcThresholds);
      const readings = await fetchMonthReadings(year, month, deviceId);
      await downloadMonthlyPdf(stats, { deviceLabel, year, month }, { readings, rooms, thresholds });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build the PDF.");
    } finally {
      setBusyMonth(null);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-slate-800">Monthly reports</h2>
        <div className="relative w-full sm:w-64">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search month… (e.g. Nov)"
            aria-label="Search monthly reports"
            className="w-full pl-8 pr-8 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-2.5 text-slate-400 hover:text-slate-600"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
      {loading ? (
        <div className="flex items-center justify-center py-6 text-slate-400 text-sm gap-2">
          <Loader2 size={15} className="animate-spin" />
          Loading months...
        </div>
      ) : months.length === 0 ? (
        <p className="text-xs text-slate-400 py-2">No data in {year}.</p>
      ) : visibleMonths.length === 0 ? (
        <p className="text-xs text-slate-400 py-2">No months match “{search}” in {year}.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visibleMonths.map(({ month, readingCount, dangerCount, invalidCount }) => (
            <div
              key={month}
              className="rounded-lg border border-slate-200 p-3 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">
                  {MONTH_NAMES[month - 1]}
                </p>
                <p className="text-[11px] text-slate-400">
                  {readingCount.toLocaleString("en-US")} readings
                  {dangerCount > 0 && (
                    <span className="text-red-500"> · {dangerCount.toLocaleString("en-US")} danger</span>
                  )}
                  {invalidCount > 0 && (
                    <span className="text-amber-600"> · {invalidCount.toLocaleString("en-US")} sensor fault</span>
                  )}
                </p>
              </div>

              <button
                type="button"
                onClick={() => download(month)}
                disabled={busyMonth === month}
                className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50"
              >
                {busyMonth === month ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                PDF
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}