// src/shared/sensorFormat.ts
// Shared sensor formatting helpers used by BOTH the React dashboard
// (DeviceHistoryReports.tsx) and the PDF Edge Function
// (supabase/functions/run-weekly-archive/index.ts).
//
// Single source of truth so the web history graph and PDF report always
// display the same units, thresholds, and tick-label formatting.

// ---- Metric keys (must match SQL helper metric column values) ----
export type SensorMetric = "co2" | "lpg" | "temp" | "humidity";

// ---- Threshold constants — FALLBACKS ONLY ----
//
// These are NOT what your deployment is using once an admin has edited the
// safety limits. They exist only so a chart has something sensible to draw
// before the configured values have loaded.
//
// They are derived from DEFAULT_THRESHOLDS rather than written out as literals,
// so the fallback can never disagree with the seed used for first-time setup.
// Real threshold lines must come from the `thresholds` object held in
// RoomsContext (the `platform_thresholds` table). Drawing these instead meant
// the history chart's danger line could contradict the severity the same screen
// reported from the configured thresholds. Pass the live values into
// computeYAxisRange() / dangerThreshold() rather than relying on these.
import { DEFAULT_THRESHOLDS } from "../data/Data";

export const CO2_WARN = DEFAULT_THRESHOLDS.co2.warning;
export const CO2_DANGER = DEFAULT_THRESHOLDS.co2.danger;
export const LPG_WARN = DEFAULT_THRESHOLDS.lpg.warning;
export const LPG_DANGER = DEFAULT_THRESHOLDS.lpg.danger;
export const TEMP_DANGER_LOW = DEFAULT_THRESHOLDS.temp.freezeBelow;
export const TEMP_DANGER_HIGH = DEFAULT_THRESHOLDS.temp.heatAbove;
export const HUM_DANGER_LOW = DEFAULT_THRESHOLDS.humidity.dryBelow;
export const HUM_DANGER_HIGH = DEFAULT_THRESHOLDS.humidity.moldAbove;

// ---- Human-readable labels ----
export const METRIC_LABEL: Record<SensorMetric, string> = {
  co2: "CO₂",
  lpg: "LPG",
  temp: "Temperature",
  humidity: "Humidity",
};

// ---- Measurement units ----
export const METRIC_UNIT: Record<SensorMetric, string> = {
  co2: "ppm",
  lpg: "ppm",
  temp: "°C",
  humidity: "%",
};

// ---- Y-axis title for each metric ----
export const METRIC_Y_AXIS_TITLE: Record<SensorMetric, string> = {
  co2: "CO₂ Level (ppm)",
  lpg: "LPG Level (ppm)",
  temp: "Temperature (°C)",
  humidity: "Humidity (%)",
};

// ---- Threshold helpers ----------------------------------------------------
// These accept the LIVE configured thresholds. `metric`-specific lookups keep
// the two-sided temperature and humidity bands, which have a lower danger
// limit as well as an upper one.

export interface LiveThresholds {
  co2: { warning: number; high: number; danger: number };
  lpg: { warning: number; high: number; danger: number };
  temp: { freezeBelow: number; coolBelow: number; heatAbove: number };
  humidity: { dryBelow: number; lowBelow: number; moldAbove: number };
}

/** Upper danger threshold for the metric, from the live configuration. */
export function liveDangerThreshold(th: LiveThresholds, metric: SensorMetric): number {
  switch (metric) {
    case "co2":
      return th.co2.danger;
    case "lpg":
      return th.lpg.danger;
    case "temp":
      return th.temp.heatAbove;
    case "humidity":
      return th.humidity.moldAbove;
  }
}

/** Lower danger threshold, or null for metrics that are only bounded above. */
export function liveDangerLow(th: LiveThresholds, metric: SensorMetric): number | null {
  switch (metric) {
    case "co2":
    case "lpg":
      return null;
    case "temp":
      return th.temp.freezeBelow;
    case "humidity":
      return th.humidity.dryBelow;
  }
}

/** Warning threshold, or null where no warning tier is configured. */
export function liveWarnThreshold(th: LiveThresholds, metric: SensorMetric): number | null {
  switch (metric) {
    case "co2":
      return th.co2.warning;
    case "lpg":
      return th.lpg.warning;
    // Temperature and humidity are two-sided with no intermediate tier in this
    // system, so no warning line is drawn for them.
    case "temp":
    case "humidity":
      return null;
  }
}

/**
 * Y-axis domain from the real data plus the live thresholds, so threshold
 * lines always fall inside the plot frame.
 *
 * `minVal`/`maxVal` are computed from recorded values upstream; when a bucket
 * had no readings it must be excluded rather than passed as 0, otherwise a gap
 * drags the axis to zero and misrepresents the recorded range.
 */
export function computeYAxisRange(
  minVal: number | null,
  maxVal: number | null,
  metric: SensorMetric,
  thresholds?: LiveThresholds | null
): { yMin: number; yMax: number } {
  // Fall back to the built-in defaults only when no live configuration was
  // supplied, so the function is still usable before thresholds have loaded.
  const d = thresholds
    ? liveDangerThreshold(thresholds, metric)
    : (metric === "co2" ? CO2_DANGER : metric === "lpg" ? LPG_DANGER : metric === "temp" ? TEMP_DANGER_HIGH : HUM_DANGER_HIGH);
  const dLow = thresholds ? liveDangerLow(thresholds, metric) : dangerLowDefault(metric);
  const w = thresholds
    ? liveWarnThreshold(thresholds, metric)
    : metric === "co2"
    ? CO2_WARN
    : metric === "lpg"
    ? LPG_WARN
    : null;

  const rawMin = minVal ?? 0;
  const rawMax = maxVal ?? 1;

  let domainMin = Math.min(rawMin, d ?? Infinity, w ?? Infinity, dLow ?? Infinity);
  let domainMax = Math.max(rawMax, d ?? 0, w ?? 0);

  // If all values are equal or nearly equal, use a sensible default range
  if (domainMax - domainMin < 1e-6) {
    domainMin = Math.max(0, domainMin - 10);
    domainMax = domainMin + 20;
  }

  // Add 10% padding on each side so the line never touches the border
  const range = domainMax - domainMin || 1;
  const padding = range * 0.10;
  let yMin = domainMin - padding;
  let yMax = domainMax + padding;

  // Enforce threshold bounds so threshold lines always fit. Each metric gets
  // its own margin above its own configured danger value.
  const headroom = metric === "temp" ? 2 : 300;
  const lowPad = metric === "temp" ? 2 : 5;
  yMax = Math.max(yMax, d + headroom);
  if (dLow !== null) {
    yMin = Math.min(yMin, dLow - lowPad);
  }

  // Ensure yMin is never negative for ppm/% metrics
  if (metric !== "temp") {
    yMin = Math.max(0, yMin);
  }

  return { yMin, yMax };
}

function dangerLowDefault(metric: SensorMetric): number | null {
  switch (metric) {
    case "co2":
    case "lpg":
      return null;
    case "temp":
      return TEMP_DANGER_LOW;
    case "humidity":
      return HUM_DANGER_LOW;
  }
}

// ---- Format a numeric value with its unit for display ----
export function formatSensorValue(value: number | null | undefined, metric: SensorMetric, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  const unit = METRIC_UNIT[metric];
  const formatted = digits > 0 ? value.toFixed(digits) : Math.round(value).toString();
  return `${formatted} ${unit}`;
}

// ---- Format a Y-axis tick label (e.g. "1000 ppm", "35°C") ----
export function formatTickLabel(val: number, metric: SensorMetric): string {
  const unit = METRIC_UNIT[metric];
  const rounded = Math.round(val);
  const display = rounded >= 1000 ? rounded.toLocaleString() : String(rounded);
  return `${display} ${unit}`;
}


// ---- Build ~N evenly-spaced Y-axis tick labels ----
export function buildYAxisTicks(yMin: number, yMax: number, metric: SensorMetric, count = 5): { val: number; label: string }[] {
  const ticks: { val: number; label: string }[] = [];
  const yRange = yMax - yMin || 1;
  for (let i = 0; i < count; i++) {
    const val = yMin + (yRange * i) / (count - 1);
    ticks.push({ val, label: formatTickLabel(val, metric) });
  }
  return ticks;
}
