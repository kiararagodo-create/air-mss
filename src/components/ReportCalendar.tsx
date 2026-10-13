// src/components/ReportCalendar.tsx
//
// Month-view calendar for the Reports page.
//
// Four states per day, and nothing else:
//   - plain grey     no readings that day (nothing happened - NOT "safe")
//   - muted dot      the day has readings and none crossed a limit
//   - count badge    the day has readings and N of them crossed a limit
//   - not clickable  the day is in the future, or has no data at all
//
// The day cell is deliberately UNCOLOURED. It used to paint breach days red and
// clean days green, which read as a health judgement on the room rather than as
// a count of events, and made an ordinary month of operation look like an
// emergency. Nothing is lost: the breach count is shown on the cell, the
// tooltip names which sensors caused it, and the selected-day panel below
// still lists every individual breach with its time.
//
// Colour on this page is reserved for the live dashboard, where red means
// "evacuate now" and is paired with an audible alarm. Here it is a historical
// tally, and a tally reads fine as a number.
//
// Days in the future are not selectable. The month is always Asia/Manila.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { monthGrid, fmtDayLong, parseDay } from "../lib/reports";
import type { CalendarDayRow } from "../lib/reportQueries";

interface ReportCalendarProps {
  monthStart: string;
  onMonthChange: (monthStart: string) => void;
  days: CalendarDayRow[];
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
  today: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function ReportCalendar({
  monthStart,
  onMonthChange,
  days,
  selectedDay,
  onSelectDay,
  today,
}: ReportCalendarProps) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const grid = monthGrid(monthStart);
  const monthLabel = parseDay(monthStart).toLocaleDateString("en-PH", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });

  const shift = (n: number) => {
    const d = parseDay(monthStart);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    onMonthChange(d.toISOString().slice(0, 10));
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => shift(-1)}
          aria-label="Previous month"
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-50"
        >
          <ChevronLeft size={18} />
        </button>

        <h2 className="text-sm font-semibold text-slate-800">{monthLabel}</h2>

        <button
          type="button"
          onClick={() => shift(1)}
          aria-label="Next month"
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-50"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="text-center text-[11px] font-medium text-slate-400 uppercase tracking-wide"
          >
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {grid.map(({ day, outside }) => {
          if (outside) {
            return <div key={day} aria-hidden className="h-11 rounded-lg" />;
          }

const row = byDay.get(day);
        const hasData = !!row && row.reading_count > 0;
        const breaches = hasData ? Number(row!.danger_readings) : 0;
        const future = day > today;
        const selected = day === selectedDay;

        // Name the sensors responsible, not just the tally. A bare "12" tells a
        // reader nothing they can act on; "12 (CO2, LPG)" tells them which
        // ventilation or gas-leak investigation to open.
        const causedBy = hasData
          ? (
              [
                [row!.co2_danger, "CO2"],
                [row!.lpg_danger, "LPG"],
                [row!.temp_danger, "Temperature"],
                [row!.humidity_danger, "Humidity"],
              ] as [number, string][]
            )
              .filter(([n]) => Number(n) > 0)
              .map(([, name]) => name)
          : [];

        return (
          <button
            key={day}
            type="button"
            disabled={!hasData || future}
            onClick={() => onSelectDay(day)}
            title={
              future
                ? `${fmtDayLong(day)} - not yet`
                : hasData
                ? `${fmtDayLong(day)} - ${row!.reading_count.toLocaleString("en-US")} readings` +
                  (breaches > 0
                    ? `, ${breaches.toLocaleString("en-US")} above limit (${causedBy.join(", ")})`
                    : ", none above limit")
                : `${fmtDayLong(day)} - no readings recorded`
            }
            className={[
              "h-11 rounded-lg text-xs flex flex-col items-center justify-center gap-0.5 transition-colors",
              selected
                ? "bg-slate-700 text-white font-semibold"
                : breaches > 0
                ? "bg-slate-100 text-slate-900 hover:bg-slate-200"
                : hasData
                ? "text-slate-700 hover:bg-slate-50"
                : "text-slate-300",
              !hasData || future ? "cursor-default" : "cursor-pointer",
            ].join(" ")}
          >
            <span>{Number(day.slice(8, 10))}</span>
            {breaches > 0 ? (
              <span
                className={[
                  "text-[9px] font-bold leading-none tabular-nums px-1 rounded",
                  selected ? "bg-white/25 text-white" : "bg-slate-300 text-slate-700",
                ].join(" ")}
              >
                {breaches > 999 ? "999+" : breaches}
              </span>
            ) : (
              hasData && (
                // Muted, uncoloured: marks that data exists without implying
                // the day was safe. No data means no dot at all.
                <span
                  aria-hidden
                  className={`w-1 h-1 rounded-full ${selected ? "bg-white/60" : "bg-slate-300"}`}
                />
              )
            )}
          </button>
        );
        })}
      </div>

      <Legend />
    </div>
  );
}

/**
 * Key for the three day states.
 *
 * Needed because the calendar no longer carries colour to explain itself. Note
 * that the last entry deliberately reads "no data", not "safe": the absence of
 * a marker means nothing was recorded, and the system never presents that as a
 * pass.
 */
function Legend() {
  const item: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: "#64748b",
  };
  const key: React.CSSProperties = {
    width: 22,
    height: 22,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 9,
    fontWeight: 700,
    flexShrink: 0,
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 14,
        marginTop: 12,
        paddingTop: 10,
        borderTop: "1px solid #f1f5f9",
      }}
    >
      <span style={item}>
        <span style={{ ...key, background: "#f1f5f9", color: "#cbd5e1", fontWeight: 400 }}>·</span>
        No readings recorded
      </span>
      <span style={item}>
        <span style={{ ...key, color: "#94a3b8" }}>
          <span
            aria-hidden
            style={{ width: 4, height: 4, borderRadius: 999, background: "#cbd5e1", display: "block" }}
          />
        </span>
        Readings, none above limit
      </span>
      <span style={item}>
        <span style={{ ...key, background: "#e2e8f0", color: "#475569" }}>12</span>
        12 readings above limit (hover for the sensors)
      </span>
    </div>
  );
}