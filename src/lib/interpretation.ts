// src/lib/interpretation.ts
//
// Plain-language interpretation of a month of readings.
//
// Every number in the output comes from a value passed in by report_month_stats.
// Nothing is inferred, estimated or invented: if a metric has no readings the
// sentence says so rather than substituting a plausible number.
//
// This is deliberately rule-based. There is no LLM and no network call.

import {
  METRIC_LABEL_SHORT,
  METRIC_ORDER,
  METRIC_UNIT_SHORT,
  type DailyMetricField,
  type DangerByMetric,
  type DailyMonthRow,
  type MetricKey,
  type MetricStats,
  type ReportRpcThresholds,
} from "./reportQueries";

interface InterpretationInput {
  year: number;
  month: number;
  monthLabel: string;
  deviceLabel: string;
  readingCount: number;
  dangerReadings: number;
  daysWithData: number;
  daysWithDanger: number;
  metrics: Record<MetricKey, MetricStats>;
  dangerByMetric: DangerByMetric;
  daily: DailyMonthRow[];
  thresholds: ReportRpcThresholds;
  daysInMonth: number;
}

function num(n: number | null | undefined, metric: MetricKey): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return metric === "temp" ? n.toFixed(1) : Math.round(n).toLocaleString("en-US");
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export function interpretMonth(input: InterpretationInput): string[] {
  const {
    readingCount, dangerReadings, daysWithData, daysWithDanger,
    metrics, dangerByMetric, daily, thresholds, daysInMonth,
  } = input;

  const paragraphs: string[] = [];

  // -- 1. Overall situation -------------------------------------------------
  const overview: string[] = [];
  overview.push(
    `A total of ${readingCount.toLocaleString("en-US")} readings were recorded across ` +
      `${daysWithData} of the ${daysInMonth} days in ${input.monthLabel}, covering ` +
      `${pct(daysWithData, daysInMonth)} of the month.`
  );
  if (dangerReadings > 0) {
    overview.push(
      `${dangerReadings.toLocaleString("en-US")} of those readings ` +
        `(${pct(dangerReadings, readingCount)}) fell outside the safe range, ` +
        `on ${daysWithDanger} ${daysWithDanger === 1 ? "day" : "days"}.`
    );
  } else {
    overview.push("No reading in this month fell outside the safe range.");
  }
  paragraphs.push(overview.join(" "));

  // -- 2. Which sensor triggered most ---------------------------------------
  const triggerCounts = METRIC_ORDER.map((m) => [m, dangerByMetric[m] ?? 0] as const);
  const totalTriggers = triggerCounts.reduce((sum, [, c]) => sum + c, 0);
  const sensorLines: string[] = [];

  if (totalTriggers > 0) {
    const ranked = [...triggerCounts].sort((a, b) => b[1] - a[1]);
    const [topMetric, topCount] = ranked[0];
    if (topCount > 0) {
      sensorLines.push(
        `${METRIC_LABEL_SHORT[topMetric]} was the most frequent cause of a danger reading ` +
          `(${topCount.toLocaleString("en-US")} of ${totalTriggers.toLocaleString("en-US")} ` +
          `trigger events).`
      );
    }
    // Mention every other sensor that triggered at all, so nothing is hidden.
    const alsoTriggered = ranked
      .slice(1)
      .filter(([, c]) => c > 0)
      .map(([m, c]) => `${METRIC_LABEL_SHORT[m]} (${c.toLocaleString("en-US")})`);
    if (alsoTriggered.length > 0) {
      sensorLines.push(`Other sensors also triggered: ${alsoTriggered.join(", ")}.`);
    }
  } else {
    sensorLines.push("No sensor triggered a danger reading during this month.");
  }

  // -- 3. Per-metric comparison against the thresholds ----------------------
  const thDanger: Record<MetricKey, { high?: number; low?: number }> = {
    co2: { high: thresholds.co2_danger },
    lpg: { high: thresholds.lpg_danger },
    temp: { high: thresholds.temp_heat_above, low: thresholds.temp_freeze_below },
    // The RPC returns a flat jsonb whose keys are snake_case (see
// report_thresholds()). This was previously spelled `humidity_dryBelow`, which
// is undefined at runtime; the `bands.low !== undefined` guard below then
// silently disabled the dry-air check for good, so a month that dropped well
// below the safe minimum was reported as having stayed in range.
humidity: { high: thresholds.humidity_mold_above, low: thresholds.humidity_dry_below },
  };

  const metricLines: string[] = [];
  for (const m of METRIC_ORDER) {
    const s = metrics[m];
    const unit = METRIC_UNIT_SHORT[m];
    const label = METRIC_LABEL_SHORT[m];
    if (!s || s.count === 0) {
      metricLines.push(`${label} had no readings this month.`);
      continue;
    }
    const bands = thDanger[m];
    let verdict: string;
    if (m === "temp" || m === "humidity") {
      const lowHit = s.min !== null && bands.low !== undefined && s.min < bands.low;
      const highHit = s.max !== null && bands.high !== undefined && s.max > bands.high;
      if (lowHit && highHit) {
        verdict = "crossed both ends of the safe range";
      } else if (lowHit) {
        verdict = `fell below the safe minimum of ${num(bands.low, m)} ${unit}`;
      } else if (highHit) {
        verdict = `rose above the safe maximum of ${num(bands.high, m)} ${unit}`;
      } else {
        verdict = "stayed within the safe range";
      }
    } else {
      const highHit = s.max !== null && bands.high !== undefined && s.max >= bands.high;
      verdict = highHit
        ? `reached ${num(bands.high, m)} ${unit}, the danger level`
        : `stayed below the danger level of ${num(bands.high, m)} ${unit}`;
    }

    metricLines.push(
      `${label} averaged ${num(s.avg, m)} ${unit}, ranging from ${num(s.min, m)} to ` +
        `${num(s.max, m)} ${unit}, and ${verdict}.`
    );
  }
  paragraphs.push(`${sensorLines.join(" ")} ${metricLines.join(" ")}`);

  // -- 4. Worst day and trend -----------------------------------------------
  const trendLines: string[] = [];
  const worst = pickWorstDay(daily);
  if (worst && worst.danger_readings > 0) {
    trendLines.push(
      `The worst day was ${worst.day} (${worst.danger_readings.toLocaleString("en-US")} ` +
        `danger readings out of ${worst.reading_count.toLocaleString("en-US")}).`
    );
  }

  const trend = pickTrend(daily);
  if (trend) trendLines.push(trend);
  if (trendLines.length > 0) paragraphs.push(trendLines.join(" "));

  // -- 5. Data gaps ----------------------------------------------------------
  if (daysWithData < daysInMonth) {
    paragraphs.push(
      `No readings were recorded on ${daysInMonth - daysWithData} ` +
        `${daysInMonth - daysWithData === 1 ? "day" : "days"} of the month. Conditions during ` +
        `those periods are unknown and are not treated as safe.`
    );
  }

  return paragraphs;
}

/** The day with the most danger readings; ties broken by the earliest date. */
function pickWorstDay(daily: DailyMonthRow[]): DailyMonthRow | null {
  let best: DailyMonthRow | null = null;
  for (const d of daily) {
    if (d.danger_readings <= 0) continue;
    if (!best || d.danger_readings > best.danger_readings) best = d;
  }
  return best;
}

/**
 * Compares the average of the first third of the month against the last third,
 * per metric, using only daily averages that actually exist.
 */
function pickTrend(daily: DailyMonthRow[]): string | null {
  const withData = daily.filter((d) => d.reading_count > 0);
  if (withData.length < 4) return null;

  const third = Math.max(2, Math.floor(withData.length / 3));
  const head = withData.slice(0, third);
  const tail = withData.slice(-third);

  const sentences: string[] = [];
  for (const m of METRIC_ORDER) {
    const avgKey: DailyMetricField = `${m}_avg`;
    const headVals = head.map((d) => d[avgKey]).filter((v): v is number => v !== null);
    const tailVals = tail.map((d) => d[avgKey]).filter((v): v is number => v !== null);
    if (headVals.length === 0 || tailVals.length === 0) continue;

    const headAvg = headVals.reduce((a, b) => a + b, 0) / headVals.length;
    const tailAvg = tailVals.reduce((a, b) => a + b, 0) / tailVals.length;
    const delta = tailAvg - headAvg;
    // Ignore noise below a tenth of a unit; it is not a real direction.
    if (Math.abs(delta) < 0.1) continue;

    const dir = delta > 0 ? "rose" : "fell";
    const from = m === "temp" ? headAvg.toFixed(1) : Math.round(headAvg).toLocaleString("en-US");
    const to = m === "temp" ? tailAvg.toFixed(1) : Math.round(tailAvg).toLocaleString("en-US");
    sentences.push(
      `${METRIC_LABEL_SHORT[m]} ${dir} from an average of ${from} to ${to} ` +
        `${METRIC_UNIT_SHORT[m]} between the start and the end of the month`
    );
  }

  if (sentences.length === 0) {
    return "Average levels were broadly steady across the month.";
  }
  return `Across the month, ${listToSentence(sentences)}.`;
}

function listToSentence(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}