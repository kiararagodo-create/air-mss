// Single source of truth for the physical validity ranges used by the
// Reports page, the day-view PDF and the monthly PDF. Stored readings are
// never modified; values outside these ranges are simply ignored when
// computing statistics.

export const SENSOR_RANGES = {
  co2: { min: 0, max: 10000 },
  lpg: { min: 0, max: 10000 },
  temp: { min: -40, max: 80 },
  humidity: { min: 0, max: 100 },
} as const;

// Plausible-range for summary statistics: values outside this range are
// excluded from min/max/avg and labelled "Sensor fault", but remain in the
// table and are still counted in the day total. 0 is a valid LPG reading.
export const PLausIBLE_RANGES = {
  co2: { min: 300, max: 10000 },
  lpg: { min: 0, max: 10000 },
  temp: { min: 10, max: 50 },
  humidity: { min: 5, max: 100 },
} as const;

export type MetricKey = "co2" | "lpg" | "temp" | "humidity";

export function inRange(metric: MetricKey, value: number | null | undefined): boolean {
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  const r = SENSOR_RANGES[metric];
  return value >= r.min && value <= r.max;
}

// A DHT22 reporting exactly 0.0 C and 0.0 % is a suspected sensor fault,
// not a real reading. Excluded from temperature and humidity statistics only.
export function isDhtFault(temp: number | null | undefined, humidity: number | null | undefined): boolean {
  return temp === 0 && humidity === 0;
}

// A row where all four sensors read exactly zero is a failed read, so none of
// its values are usable. Mirrors report_metric_is_valid() in SQL.
export function isAllZero(row: { co2?: number | null; lpg?: number | null; temp?: number | null; humidity?: number | null }): boolean {
  return row.co2 === 0 && row.lpg === 0 && row.temp === 0 && row.humidity === 0;
}

// NULL is not a usable sensor value. Mirrors report_reading_is_invalid() in SQL.
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
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  if (row && isAllZero(row)) return false;
  if (metric === "co2") return inRange("co2", value);
  if (metric === "lpg") return inRange("lpg", value);
  if (metric === "temp") return tempValid(value, row?.humidity);
  if (metric === "humidity") return humidityValid(value, row?.temp);
  return false;
}

// A reading is a sensor fault when any value is outside the plausible range,
// all sensors are missing, or all read exactly zero. Mirrors
// report_reading_is_invalid() in SQL.
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

// Check one sensor value against the plausible range only.
export function plausibleMetricValid(metric: MetricKey, value: number | null | undefined): boolean {
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  const r = PLausIBLE_RANGES[metric];
  return value >= r.min && value <= r.max;
}

// ---------------------------------------------------------------------------
// Helper: check a row against the plausible range (any metric out of range → true)
// Used by the day-PDF and panel to flag excluded readings.
// ---------------------------------------------------------------------------
export function isReadingPlausible(row: { co2?: number | null; lpg?: number | null; temp?: number | null; humidity?: number | null }): boolean {
  if (isMissing(row)) return false;
  if (isAllZero(row)) return false;
  if (row.co2 != null && (row.co2 < PLausIBLE_RANGES.co2.min || row.co2 > PLausIBLE_RANGES.co2.max)) return false;
  if (row.lpg != null && (row.lpg < PLausIBLE_RANGES.lpg.min || row.lpg > PLausIBLE_RANGES.lpg.max)) return false;
  if (row.temp != null && (row.temp < PLausIBLE_RANGES.temp.min || row.temp > PLausIBLE_RANGES.temp.max)) return false;
  if (row.humidity != null && (row.humidity < PLausIBLE_RANGES.humidity.min || row.humidity > PLausIBLE_RANGES.humidity.max)) return false;
  return !isDhtFault(row.temp, row.humidity);
}