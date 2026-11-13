// Single source of truth for sensor validity/fault rules used in UI and reports.
// Task 2: reject/flag NaN, negative, or beyond physical range.
// Physical ranges: LPG > 10000 ppm invalid, CO2 > 10000 ppm invalid, DHT22 temp outside -40..80 C,
// humidity outside 0-100%. If temp and humidity are both exactly 0, treat as likely sensor fault/disconnect.

export const SENSOR_RANGES = {
  co2: { min: 0, max: 10000 },
  lpg: { min: 0, max: 10000 },
  temp: { min: -40, max: 80 },
  humidity: { min: 0, max: 100 },
} as const;

// Plausible ranges kept for reporting/statistics compatibility with existing codebase.
export const PLausIBLE_RANGES = {
  co2: { min: 300, max: 10000 },
  lpg: { min: 0, max: 10000 },
  temp: { min: 10, max: 50 },
  humidity: { min: 5, max: 100 },
} as const;

export type MetricKey = "co2" | "lpg" | "temp" | "humidity";

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isAllZero(row: { co2?: number | null; lpg?: number | null; temp?: number | null; humidity?: number | null }): boolean {
  return row.co2 === 0 && row.lpg === 0 && row.temp === 0 && row.humidity === 0;
}

export function isDhtFault(temp: number | null | undefined, humidity: number | null | undefined): boolean {
  return temp === 0 && humidity === 0;
}

export function isSensorFaultValue(
  metric: MetricKey,
  value: number | null | undefined,
  ctx?: { temp?: number | null; humidity?: number | null; co2?: number | null; lpg?: number | null }
): boolean {
  if (value === null || value === undefined) return false; // missing, not a garbage numeric fault
  if (!isFiniteNumber(value)) return true;
  if (ctx && isAllZero({ co2: ctx.co2 ?? null, lpg: ctx.lpg ?? null, temp: ctx.temp ?? null, humidity: ctx.humidity ?? null })) return true;

  const r = SENSOR_RANGES[metric];
  if (value < r.min || value > r.max) return true;

  if (metric === "temp" || metric === "humidity") {
    const t = metric === "temp" ? value : (ctx?.temp ?? null);
    const h = metric === "humidity" ? value : (ctx?.humidity ?? null);
    if (isDhtFault(t, h)) return true;
  }
  return false;
}

export function inRange(metric: MetricKey, value: number | null | undefined): boolean {
  if (!isFiniteNumber(value)) return false;
  const r = SENSOR_RANGES[metric];
  return value >= r.min && value <= r.max;
}

export function isMissing(row: { co2?: number | null; lpg?: number | null; temp?: number | null; humidity?: number | null }): boolean {
  return row.co2 == null || row.lpg == null || row.temp == null || row.humidity == null;
}

export function tempValid(value: number | null | undefined, humidity: number | null | undefined): boolean {
  if (!inRange("temp", value)) return false;
  if (isDhtFault(value, humidity)) return false;
  return true;
}

export function humidityValid(value: number | null | undefined, temp: number | null | undefined): boolean {
  if (!inRange("humidity", value)) return false;
  if (isDhtFault(temp, value)) return false;
  return true;
}

export function metricValid(
  metric: MetricKey,
  value: number | null | undefined,
  row?: { co2?: number | null; lpg?: number | null; temp?: number | null; humidity?: number | null }
): boolean {
  if (!isFiniteNumber(value)) return false;
  if (row && isAllZero(row)) return false;
  if (isSensorFaultValue(metric, value, row ?? undefined)) return false;
  if (metric === "co2") return inRange("co2", value);
  if (metric === "lpg") return inRange("lpg", value);
  if (metric === "temp") return tempValid(value, row?.humidity);
  if (metric === "humidity") return humidityValid(value, row?.temp);
  return false;
}

export function isSensorFault(row: { co2?: number | null; lpg?: number | null; temp?: number | null; humidity?: number | null }): boolean {
  if (isMissing(row)) return true;
  if (isAllZero(row)) return true;
  if (row.co2 != null && (row.co2 < PLausIBLE_RANGES.co2.min || row.co2 > PLausIBLE_RANGES.co2.max)) return true;
  if (row.lpg != null && (row.lpg < PLausIBLE_RANGES.lpg.min || row.lpg > PLausIBLE_RANGES.lpg.max)) return true;
  if (row.temp != null && (row.temp < PLausIBLE_RANGES.temp.min || row.temp > PLausIBLE_RANGES.temp.max)) return true;
  if (row.humidity != null && (row.humidity < PLausIBLE_RANGES.humidity.min || row.humidity > PLausIBLE_RANGES.humidity.max)) return true;
  if (isDhtFault(row.temp, row.humidity)) return true;
  return false;
}

export function plausibleMetricValid(metric: MetricKey, value: number | null | undefined): boolean {
  if (!isFiniteNumber(value)) return false;
  const r = PLausIBLE_RANGES[metric];
  return value >= r.min && value <= r.max;
}

export function isReadingPlausible(row: { co2?: number | null; lpg?: number | null; temp?: number | null; humidity?: number | null }): boolean {
  if (isMissing(row)) return false;
  if (isAllZero(row)) return false;
  if (row.co2 != null && (row.co2 < PLausIBLE_RANGES.co2.min || row.co2 > PLausIBLE_RANGES.co2.max)) return false;
  if (row.lpg != null && (row.lpg < PLausIBLE_RANGES.lpg.min || row.lpg > PLausIBLE_RANGES.lpg.max)) return false;
  if (row.temp != null && (row.temp < PLausIBLE_RANGES.temp.min || row.temp > PLausIBLE_RANGES.temp.max)) return false;
  if (row.humidity != null && (row.humidity < PLausIBLE_RANGES.humidity.min || row.humidity > PLausIBLE_RANGES.humidity.max)) return false;
  return !isDhtFault(row.temp, row.humidity);
}

export function formatMetricDisplay(
  metric: MetricKey,
  value: number | null | undefined,
  ctx?: { temp?: number | null; humidity?: number | null; co2?: number | null; lpg?: number | null }
): string {
  if (value === null || value === undefined) return "—";
  if (isSensorFaultValue(metric, value, ctx)) return "Sensor error";
  if (!isFiniteNumber(value)) return "Sensor error";
  if (metric === "temp") return `${value.toFixed(1)} °C`;
  if (metric === "humidity") return `${Math.round(value)} %RH`;
  return `${Math.round(value)} ppm`;
}
