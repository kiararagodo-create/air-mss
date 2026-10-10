
type Tone = "success" | "warning" | "high" | "danger";

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

// Default safety thresholds. Admins can override these from the Settings page.
//
// CO2 (MH-Z19C): 1000 ppm = start paying attention (ASHRAE indoor-air-quality
// guidance re: poor ventilation/drowsiness). 'high' and 'danger' are both set
// to 3500 ppm, matching the ESP32 firmware's CO2_URGENT_PPM (the level at
// which the physical buzzer actually fires) - collapsing the old 4-tier
// severity scale (warning/high/danger) into 3 effective tiers (Safe /
// Warning / Danger) so the dashboard's CO2 Reference Guide and alarm state
// line up with what the hardware does. 5000 ppm (OSHA 8-hour occupational
// exposure ceiling) is no longer used as a tier boundary here, but is still
// referenced in the UI copy for context.
//
// LPG (MQ-6): thresholds are set relative to the Lower Explosive Limit (LEL),
// not a health exposure limit, since the real danger here is combustion.
// ~2000 ppm ≈ 10% LEL, the standard conservative early-warning margin used by
// commercial combustible-gas detectors; ~5000+ ppm escalates to full alarm.
// Note: MQ-6 is a semiconductor sensor, not a certified gas-safety detector -
// treat these as relative trigger points to calibrate against your specific
// board's potentiometer/curve, not lab-grade absolute ppm.
//
// Temp/Humidity (DHT22): normal/danger humidity band widened to 20-80% RH
// to reflect typical Philippine ambient humidity, rather than a temperate-
// climate comfort range - danger only below 20% or above 80%. Temp alarm
// points (35°C, 5°C) unchanged. DHT22's own hardware spec is -40 to 80°C /
// 0-100% RH with ±0.5°C / ±2% RH accuracy, so these thresholds sit well
// within that range.
export const DEFAULT_THRESHOLDS: Thresholds = {
  co2: { warning: 1000, high: 3500, danger: 3500 },
  lpg: { warning: 1000, high: 2000, danger: 5000 },
  temp: { freezeBelow: 5, coolBelow: 18, heatAbove: 35 },
  humidity: { dryBelow: 20, lowBelow: 30, moldAbove: 80 },
};

export const SEVERITY_META: SeverityMeta[] = [
  { severity: 0, label: "Good", tone: "success" },
  { severity: 1, label: "Warning", tone: "warning" },
  { severity: 2, label: "High Gas", tone: "high" },
  { severity: 3, label: "Gas Risk", tone: "danger" },
];

/** Shown wherever a metric has no measurement at all. Never a numeric value. */
export const NO_DATA_LABEL = "No sensor data recorded";

// Worst-case severity across CO2 and LPG readings drives the room's badge/tone.
// Boundary semantics are `>=`, matching reading_is_danger() in SQL and
// isDangerRow() in supabase/functions/_shared/reporting.ts, so the dashboard
// badge and the PDF never disagree about a reading sitting exactly on a limit.
export function getStatus(room: Room, thresholds: Thresholds): Status {
  const co2Severity = severityFor(room.co2, thresholds.co2);
  const lpgSeverity = severityFor(room.lpg, thresholds.lpg);
  const severity = Math.max(co2Severity, lpgSeverity);
  // A severity of 0 that came from actual readings is "Good". A severity of 0
  // that came from nothing at all is "No sensor data recorded" and must be
  // styled as absent, not as a passing result.
  const hasData = room.co2 !== null || room.lpg !== null;

  if (!hasData) {
    return { severity: 0, label: NO_DATA_LABEL, tone: "success", hasData: false };
  }

  const meta = SEVERITY_META[severity];
  const label = severity === 3 && lpgSeverity === 3 ? "Gas Risk" : meta.label;
  return { severity, label, tone: meta.tone, hasData: true };
}

export function actionMessage(room: Room, thresholds: Thresholds): ActionMessage {
  const status = getStatus(room, thresholds);

  if (!status.hasData) {
    return {
      title: "No sensor data received",
      body: "This device has not reported a CO2 or LPG reading, so no condition can be assessed. " +
        "This is an absence of data, not a safe reading. Check that the sensor is powered and reporting.",
    };
  }

  const status0 = status.severity;
  if (status0 === 0)
    return {
      title: "No action needed",
      body: "CO2 and LPG levels are within safe limits. Continue monitoring the area.",
    };
  if (status0 === 1)
    return {
      title: "Monitor conditions",
      body: "Gas levels are elevated; observe the area closely and reduce exposure if possible.",
    };
  if (status0 === 2)
    return {
      title: "Investigate elevated readings",
      body: "Air quality parameters are trending high. Increase ventilation and monitor closely for further escalation.",
    };
  return {
    title: "Immediate action required",
    body: "Gas or CO2 levels have reached dangerous limits. Evacuate the area, ventilate immediately, and dispatch maintenance/security personnel.",
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

function severityFor(value: number | null, tiers: ThresholdTier): number {
  // A missing value contributes no severity. It is NOT a reading of 0, and it
  // must not be allowed to imply a safe result on its own - getStatus() reports
  // `hasData: false` in that case so the UI can say so explicitly.
  if (value == null) return 0;
  if (value >= tiers.danger) return 3;
  if (value >= tiers.high) return 2;
  if (value >= tiers.warning) return 1;
  return 0;
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

