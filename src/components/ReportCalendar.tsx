// src/components/ReportCalendar.tsx
//
// Month-view calendar for the Reports page.
//
// Three states per day, and nothing else:
//   - dot        the day has readings
//   - red dot    the day has at least one danger reading
//   - plain      no readings
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
          const hasDanger = !!row && row.danger_readings > 0;
          const future = day > today;
          const selected = day === selectedDay;

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
                  ? `${fmtDayLong(day)} - ${row!.reading_count.toLocaleString("en-US")} readings`
                  : fmtDayLong(day)
              }
              className={[
                "h-11 rounded-lg text-xs flex flex-col items-center justify-center gap-1 transition-colors",
                selected
                  ? "bg-teal-600 text-white font-semibold"
                  : hasDanger
                  ? "bg-red-50 text-red-700 hover:bg-red-100"
                  : hasData
                  ? "bg-teal-50 text-teal-800 hover:bg-teal-100"
                  : "text-slate-300",
                !hasData || future ? "cursor-default" : "cursor-pointer",
              ].join(" ")}
            >
              <span>{Number(day.slice(8, 10))}</span>
              {hasData && (
                <span
                  aria-hidden
                  className={[
                    "w-1.5 h-1.5 rounded-full",
                    selected ? "bg-white" : hasDanger ? "bg-red-500" : "bg-teal-500",
                  ].join(" ")}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}