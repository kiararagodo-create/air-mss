
type Tone = "success" | "warning" | "high" | "danger";

// Severity grading, badge labels and tones all come from the shared threshold
// module. See src/lib/thresholdConfig.ts for why the device's own `severity`
// column is not consulted.
import {
  SEVERITY_LABEL,
  SEVERITY_RANK,
  SEVERITY_TONE,
  hasAnyReading,
  overallSeverity,
  type SeverityLevel,
} from "../lib/thresholdConfig";

// ---------------------------------------------------------------------------
// Canonical data-layer types. Other files (AdminDashboard.tsx, page
// components) import Room / Thresholds / ThresholdTier from here - or via
// AdminDashboard.tsx, which re-exports them for convenience.
// ---------------------------------------------------------------------------
export interface ThresholdTier {
  warning: number;
  high: number;
  danger: number;
}

export interface TempTier {
  freezeBelow: number; // below this = danger (freeze / pipe risk)
  coolBelow: number;   // freezeBelow–coolBelow = warning (cool)
  heatAbove: number;   // above this = danger (heat stress / fire risk); coolBelow–heatAbove = comfortable
}

export interface HumidityTier {
  dryBelow: number;   // below this = danger (too dry)
  lowBelow: number;   // dryBelow–lowBelow = warning (low)
  moldAbove: number;  // above this = danger (mold / condensation risk); lowBelow–moldAbove = comfortable
}

export interface Thresholds {
  co2: ThresholdTier;
  lpg: ThresholdTier;
  temp: TempTier;
  humidity: HumidityTier;
}

export interface Room {
  id: string;
  name: string;
  floor: string;
  co2Sensor: string;
  gasSensor: string | null;
  tempHumiditySensor?: string | null;
  // Maps this room to a physical ESP32's DEVICE_ID for live Supabase data.
  // Undefined for rooms with no live sensor yet (still using simulated data).
  deviceId?: string;
  length: number;
  width: number;
  height: number;
  // -------------------------------------------------------------------------
  // LIVE READING VALUES.
  //
  // These come ONLY from the `readings` table. `null` means "the sensor has
  // not sent a value for this metric" and MUST be rendered as a missing value,
  // never as 0. A null here is not the same as a measured zero and must never
  // be treated as a safe or in-range reading.
  //
  // They are deliberately NOT seeded from the `rooms.co2` / `rooms.lpg` columns.
  // Those columns hold whatever was last written by the device-registration
  // form and are not measurements; displaying them would present invented
  // numbers as sensor readings.
  // -------------------------------------------------------------------------
  co2: number | null;
  lpg: number | null;
  temp: number | null;
  humidity: number | null;
  online: boolean;
  /** Timestamp of the newest reading that produced the values above, or null
   *  when no reading has ever been received. Used to show the age of a number
   *  so a stale value is never mistaken for a current one. */
  lastReadingAt: string | null;
  alertCount: number;
  installedAt: string; // ISO date string - when this device was deployed
  // Per-device siren mute flag, polled by the ESP32 firmware (siren_muted
  // column in Supabase's "rooms" table). Muting silences the physical
  // buzzer only - readings/severity/dashboard alerts keep working normally.
  sirenMuted: boolean;
}

export interface SeverityMeta {
  severity: number;
  label: string;
  tone: Tone;
}

export interface Status {
  severity: number;
  label: string;
  tone: Tone;
  /**
   * False when every measured metric is null, i.e. no actual sensor reading has
   * been received. `severity` is 0 in that case, but that must NOT be read as
   * "measured and safe" - callers must render an explicit no-data state.
   */
  hasData: boolean;
}

export interface ActionMessage {
  title: string;
  body: string;
}

export interface SensorInfo {
  id: string;
  title: string;
  body: string;
  gases: string;
  range: string;
  accuracy: string;
  specs: string[];
}

// Default safety thresholds — the SEED, not the truth.
//
// These values are used for exactly two situations:
//   * first-time setup, before any row exists in public.platform_thresholds
//   * the fallback when the fetch of the saved row fails
//
// Once a row has been saved it OVERRIDES everything here, which is why
// supabase/migrations/20260915000000_reference_thresholds.sql updates the
// saved row rather than relying on this object. Editing this object alone does
// nothing to a deployment that has already saved a configuration.
//
// The authoritative copy for every rendered number is the saved row; see
// src/lib/thresholdConfig.ts, which turns it into every range, label, badge,
// alarm trigger and footnote the UI shows.
//
// CO2 (MH-Z19C), ASHRAE 62.1 & OSHA
//   warning 1000 / high 2000 / danger 3500 ppm.
//   The ESP32 implements only warning (1000), alarm (3500) and critical
//   (5000). "high" is a dashboard-only tier that exists so a reading can be
//   graded between the physical alarm points; the hardware does not act on it.
//
// LPG (MQ-6), NFPA 54 / NFPA 715 & BS EN 50194-1
//   warning 1000 / high 2100 / danger 4200 ppm.
//   Set as a fraction of the Lower Explosive Limit rather than as a health
//   exposure limit, because the hazard here is combustion: 2100 ppm is 10% LEL
//   (buzzer alarm) and 4200 ppm is 20% LEL (critical hazard).
//
// Temperature (DHT22), ASHRAE 55: freeze below 5, cool below 18, heat above 35.
// Humidity (DHT22), EPA & ASHRAE 62.1: dry below 20, low below 30, mold above 80.
// Both are two-sided bands, well inside the DHT22's own -40..80 °C /
// 0-100 % RH measurement range.
export const DEFAULT_THRESHOLDS: Thresholds = {
  co2: { warning: 1000, high: 2000, danger: 3500 },
  lpg: { warning: 1000, high: 2100, danger: 4200 },
  temp: { freezeBelow: 5, coolBelow: 18, heatAbove: 35 },
  humidity: { dryBelow: 20, lowBelow: 30, moldAbove: 80 },
};

// Severity metadata is derived from the shared grading module rather than
// restated here, so the numeric 0-3 scale this file keeps for compatibility
// cannot drift from the ok/warning/high/danger levels everything else uses.
const SEVERITY_LEVELS: SeverityLevel[] = ["ok", "warning", "high", "danger"];

export const SEVERITY_META: SeverityMeta[] = SEVERITY_LEVELS.map((level, severity) => ({
  severity,
  label: SEVERITY_LABEL[level],
  tone: SEVERITY_TONE[level] as Tone,
}));

/** Shown wherever a metric has no measurement at all. Never a numeric value. */
export const NO_DATA_LABEL = "No sensor data recorded";

/**
 * Grade a room from its RAW readings against the saved thresholds.
 *
 * All four metrics contribute, not just the two gases: a room at a lethal
 * temperature is in trouble whatever the CO2 sensor says. The ESP32's own
 * `severity` column is deliberately not consulted - the firmware grades
 * against tiers it compiled in, which do not change when an admin re-tunes the
 * dashboard configuration, so trusting it would let the badge contradict the
 * reference guide shown directly beneath it.
 *
 * The reported severity is the worst of the four. Boundary semantics are
 * `>=`, matching report_is_danger() in SQL and isDangerRow() in
 * supabase/functions/_shared/reporting.ts, so the badge and the PDF never
 * disagree about a reading sitting exactly on a limit.
 */
export function getStatus(room: Room, thresholds: Thresholds): Status {
  const level = overallSeverity(
    { co2: room.co2, lpg: room.lpg, temp: room.temp, humidity: room.humidity },
    thresholds
  );
  const severity = SEVERITY_RANK[level];

  // A severity of 0 that came from actual readings is "OK". A severity of 0
  // that came from nothing at all is "No sensor data recorded" and must be
  // styled as absent, not as a passing result.
  const hasData = hasAnyReading({
    co2: room.co2,
    lpg: room.lpg,
    temp: room.temp,
    humidity: room.humidity,
  });

  if (!hasData) {
    return { severity: 0, label: NO_DATA_LABEL, tone: "success", hasData: false };
  }

  const meta = SEVERITY_META[severity];
  return { severity, label: meta.label, tone: meta.tone, hasData: true };
}

export function actionMessage(room: Room, thresholds: Thresholds): ActionMessage {
  const status = getStatus(room, thresholds);

  if (!status.hasData) {
    return {
      title: "No sensor data received",
      body: "This device has not reported any reading, so no condition can be assessed. " +
        "This is an absence of data, not a safe reading. Check that the sensor is powered and reporting.",
    };
  }

  const status0 = status.severity;
  if (status0 === 0)
    return {
      title: "No action needed",
      body: "CO2, LPG, temperature and humidity are all within their configured safe limits. Continue monitoring the area.",
    };
  if (status0 === 1)
    return {
      title: "Monitor conditions",
      body: "A reading has crossed its warning threshold. Observe the area closely and reduce exposure if possible.",
    };
  if (status0 === 2)
    return {
      title: "Investigate elevated readings",
      body: "A reading has crossed its high threshold. Increase ventilation and monitor closely for further escalation.",
    };
  return {
    title: "Immediate action required",
    body: "A reading has reached its danger threshold. Evacuate the area, ventilate immediately, and dispatch maintenance/security personnel.",
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function volumeOf(room: Room): number {
  return Math.round(room.length * room.width * room.height * 10) / 10;
}

// Human-readable device age, e.g. "3 months", "1 year 2 months", "14 days".
export function deviceAgeLabel(installedAt: string): string {
  const installed = new Date(installedAt).getTime();
  const now = Date.now();
  const days = Math.max(0, Math.floor((now - installed) / (1000 * 60 * 60 * 24)));

  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;

  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (remMonths === 0) return `${years} year${years === 1 ? "" : "s"}`;
  return `${years} year${years === 1 ? "" : "s"} ${remMonths} month${remMonths === 1 ? "" : "s"}`;
}

export function exportCSV(rooms: Room[], thresholds: Thresholds): void {
  const headers = [
    "Room",
    "Floor",
    "Device ID",
    "CO2 (ppm)",
    "LPG (ppm)",
    "Temp (C)",
    "Humidity (%)",
    "Alerts",
    "Status",
  ];
  const rows = rooms.map((r) => {
    const status = getStatus(r, thresholds);
    return [
      r.name,
      r.floor,
      r.id,
      // A metric with no reading is written as an empty cell, which is how a
      // CSV consumer distinguishes "not measured" from a measured zero.
      r.co2 != null ? String(Math.round(r.co2)) : "",
      r.lpg != null ? String(Math.round(r.lpg)) : "",
      r.temp != null ? r.temp.toFixed(1) : "",
      r.humidity != null ? String(Math.round(r.humidity)) : "",
      String(r.alertCount),
      status.hasData ? status.label : NO_DATA_LABEL,
    ];
  });
  // Quote every cell: room and floor names legitimately contain commas.
  const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `air-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// NOTE: this module deliberately contains NO sample or demo sensor data.
//
// An earlier version exported INITIAL_ROOMS and devices with invented values
// (e.g. co2: 990, temp: 27.5) as UI fixtures. Nothing imported them, but
// fabricated readings living in a data module is a hazard: they can be wired
// into a view as a fallback and then rendered as if a sensor had sent them.
// They have been deleted.
//
// Live values come only from the Supabase `readings` table via RoomsContext.
// A metric with no reading is `null` and is displayed as NO_DATA_LABEL, never
// as 0.
// ---------------------------------------------------------------------------

export const SENSOR_INFO: SensorInfo[] = [
  {
    id: "MH-Z19C",
    title: "MH-Z19C NDIR CO2 Sensor",
    body: "Non-dispersive infrared (NDIR) sensor used to measure ambient carbon dioxide concentration in enclosed spaces.",
    gases: "CO2",
    range: "0 - 5000 ppm",
    accuracy: "+/- 50 ppm + 5% of reading",
    specs: [
      "UART / PWM output",
      "Self-calibrating baseline",
      "Low power draw",
      "3-5 year lifespan",
    ],
  },
  {
    id: "MQ-6",
    title: "MQ-6 LPG / Gas Sensor",
    body: "Semiconductor gas sensor tuned for detecting LPG, propane, and butane leaks in kitchens, labs, and storage rooms.",
    gases: "LPG, Propane, Butane, Isobutane",
    range: "200 - 10000 ppm",
    accuracy: "Relative (requires calibration)",
    specs: [
      "Analog output",
      "Fast response time",
      "Preheat required (~20s)",
      "Widely available, low cost",
    ],
  },
  {
    id: "DHT22",
    title: "DHT22 Temperature & Humidity Sensor",
    body: "Digital sensor used to measure ambient temperature and relative humidity, helping monitor comfort and environmental conditions in enclosed spaces.",
    gases: "N/A (Temp & Humidity only)",
    range: "-40 to 80°C / 0-100% RH",
    accuracy: "+/- 0.5°C / +/- 2-5% RH",
    specs: [
      "Digital single-bus output",
      "2s sampling interval",
      "Low power draw",
      "3-5 year lifespan",
    ],
  },
];

