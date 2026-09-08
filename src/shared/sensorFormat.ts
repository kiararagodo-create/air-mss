// src/shared/sensorFormat.ts
// Shared sensor formatting helpers used by BOTH the React dashboard
// (DeviceHistoryReports.tsx) and the PDF Edge Function
// (supabase/functions/run-weekly-archive/index.ts).
//
// Single source of truth so the web history graph and PDF report always
// display the same units, thresholds, and tick-label formatting.

// ---- Metric keys (must match SQL helper metric column values) ----
export type SensorMetric = "co2" | "lpg" | "temp" | "humidity";

// ---- Threshold constants — keep in sync with SQL fns + ESP32 firmware ----
export const CO2_WARN = 1000;
export const CO2_DANGER = 3500;
export const LPG_WARN = 1000;
export const LPG_DANGER = 5000;
export const TEMP_DANGER_LOW = 5;
export const TEMP_DANGER_HIGH = 35;
export const HUM_DANGER_LOW = 20;
export const HUM_DANGER_HIGH = 80;

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

// ---- Danger threshold per metric (used for threshold lines) ----
export function dangerThreshold(metric: SensorMetric): number | null {
  switch (metric) {
    case "co2": return CO2_DANGER;
    case "lpg": return LPG_DANGER;
    case "temp": return TEMP_DANGER_HIGH;
    case "humidity": return HUM_DANGER_HIGH;
  }
}

// ---- Warning threshold per metric (null = no warning line) ----
export function warnThreshold(metric: SensorMetric): number | null {
  switch (metric) {
    case "co2": return CO2_WARN;
    case "lpg": return LPG_WARN;
    case "temp": return null;
    case "humidity": return null;
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

// ---- Compute a sensible Y-axis range from actual data + thresholds ----
// Ensures the plotted line NEVER touches the chart border by adding
// dynamic padding. Also includes threshold lines in the domain so they
// stay inside the frame.
export function computeYAxisRange(
  minVal: number | null,
  maxVal: number | null,
  metric: SensorMetric,
): { yMin: number; yMax: number } {
  const rawMin = minVal ?? 0;
  const rawMax = maxVal ?? 1;
  const d = dangerThreshold(metric);
  const w = warnThreshold(metric);

  // Determine domain from data + thresholds
  let domainMin = Math.min(rawMin, d ?? Infinity, w ?? Infinity);
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

  // Enforce threshold bounds so threshold lines always fit
  if (metric === "co2" || metric === "lpg") {
    yMax = Math.max(yMax, CO2_DANGER + 300);
  }
  if (metric === "temp") {
    yMin = Math.min(yMin, TEMP_DANGER_LOW - 2);
    yMax = Math.max(yMax, TEMP_DANGER_HIGH + 2);
  }
  if (metric === "humidity") {
    yMin = Math.min(yMin, HUM_DANGER_LOW - 5);
    yMax = Math.max(yMax, HUM_DANGER_HIGH + 5);
  }

  // Ensure yMin is never negative for ppm/% metrics
  if (metric !== "temp") {
    yMin = Math.max(0, yMin);
  }

  return { yMin, yMax };
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