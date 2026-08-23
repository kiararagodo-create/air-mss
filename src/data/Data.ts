import type { IoTDevice } from "../types";

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
  occupancy: number;
  co2: number | null;
  lpg: number | null;
  temp: number;
  humidity: number;
  online: boolean;
  alertCount: number;
  installedAt: string; // ISO date string - when this device was deployed
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
// guidance re: poor ventilation/drowsiness), 2000 ppm = alarm, 5000 ppm =
// OSHA 8-hour occupational exposure ceiling (critical).
//
// LPG (MQ-6): thresholds are set relative to the Lower Explosive Limit (LEL),
// not a health exposure limit, since the real danger here is combustion.
// ~2000 ppm ≈ 10% LEL, the standard conservative early-warning margin used by
// commercial combustible-gas detectors; ~5000+ ppm escalates to full alarm.
// Note: MQ-6 is a semiconductor sensor, not a certified gas-safety detector -
// treat these as relative trigger points to calibrate against your specific
// board's potentiometer/curve, not lab-grade absolute ppm.
//
// Temp/Humidity (DHT22): derived from DHT22 research - normal comfort range
// 18-27°C / 30-60% RH, with alarm points at commonly-used heat/freeze and
// mold/dryness cutoffs (35°C, 5°C, 65% RH, 20% RH). DHT22's own hardware
// spec is -40 to 80°C / 0-100% RH with ±0.5°C / ±2% RH accuracy, so these
// thresholds sit well within that range.
export const DEFAULT_THRESHOLDS: Thresholds = {
  co2: { warning: 1000, high: 2000, danger: 5000 },
  lpg: { warning: 1000, high: 2000, danger: 5000 },
  temp: { freezeBelow: 5, coolBelow: 18, heatAbove: 35 },
  humidity: { dryBelow: 20, lowBelow: 30, moldAbove: 65 },
};

export const SEVERITY_META: SeverityMeta[] = [
  { severity: 0, label: "Good", tone: "success" },
  { severity: 1, label: "Warning", tone: "warning" },
  { severity: 2, label: "High Gas", tone: "high" },
  { severity: 3, label: "Gas Risk", tone: "danger" },
];

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
  if (value == null) return 0;
  if (value >= tiers.danger) return 3;
  if (value >= tiers.high) return 2;
  if (value >= tiers.warning) return 1;
  return 0;
}

// Worst-case severity across CO2 and LPG readings drives the room's badge/tone.
export function getStatus(room: Room, thresholds: Thresholds): Status {
  const co2Severity = severityFor(room.co2, thresholds.co2);
  const lpgSeverity = room.lpg != null ? severityFor(room.lpg, thresholds.lpg) : 0;
  const severity = Math.max(co2Severity, lpgSeverity);
  const meta = SEVERITY_META[severity];
  const label = severity === 3 && lpgSeverity === 3 ? "Gas Risk" : meta.label;
  return { severity, label, tone: meta.tone };
}

export function actionMessage(room: Room, thresholds: Thresholds): ActionMessage {
  const status = getStatus(room, thresholds);
  switch (status.severity) {
    case 3:
      return {
        title: "Immediate action required",
        body: "Gas or CO2 levels have reached dangerous limits. Evacuate the area, ventilate immediately, and dispatch maintenance/security personnel.",
      };
    case 2:
      return {
        title: "Elevated readings detected",
        body: "Air quality parameters are trending high. Increase ventilation and monitor closely for further escalation.",
      };
    case 1:
      return {
        title: "Levels rising, monitor closely",
        body: "Readings are above baseline but not yet critical. No immediate action required, but keep watch.",
      };
    default:
      return {
        title: "Air quality is good",
        body: "Air quality parameters are well within safe operating limits. No immediate action required.",
      };
  }
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
      r.co2 != null ? Math.round(r.co2) : "N/A",
      r.lpg != null ? Math.round(r.lpg) : "N/A",
      r.temp.toFixed(1),
      Math.round(r.humidity),
      r.alertCount,
      status.label,
    ];
  });
  const csv = [headers, ...rows].map((row) => row.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `air-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

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

export const INITIAL_ROOMS: Room[] = [
  {
    id: "AIR-106",
    name: "Room 106",
    floor: "Ground Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: null,
    length: 8,
    width: 6,
    height: 3,
    occupancy: 30,
    co2: 490,
    lpg: null,
    temp: 27.5,
    humidity: 55,
    online: false,
    alertCount: 0,
    installedAt: "2024-08-15",
  },
  {
    id: "AIR-K01",
    name: "Kitchen",
    floor: "3rd Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: "MQ-6",
    // Matches this room's own id, which is also the DEVICE_ID your live
    // ESP32 sends (readings.device_id has a foreign key to rooms.id).
    deviceId: "AIR-K01",
    length: 6,
    width: 5,
    height: 3,
    occupancy: 8,
    co2: 992,
    lpg: 510,
    temp: 30.2,
    humidity: 60,
    online: true,
    alertCount: 3,
    installedAt: "2025-01-10",
  },
  {
    id: "AIR-CL02",
    name: "Chem Lab Room",
    floor: "2nd Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: "MQ-6",
    length: 10,
    width: 8,
    height: 3.2,
    occupancy: 25,
    co2: 974,
    lpg: 333,
    temp: 28.8,
    humidity: 58,
    online: false,
    alertCount: 2,
    installedAt: "2023-11-02",
  },
];

// ---------------------------------------------------------------------------
// devices - required by DeviceContext.tsx (`import { devices as initialDevices }
// from "../data/Data"`). Built from the same room data above, with `online`
// mapped to `connectionStatus` to match the IoTDevice shape DeviceContext
// and setDeviceStatus() expect.
// ---------------------------------------------------------------------------
export const devices: IoTDevice[] = INITIAL_ROOMS.map((r) => ({
  id: r.id,
  name: r.name,
  floor: r.floor,
  co2Sensor: r.co2Sensor,
  gasSensor: r.gasSensor,
  length: r.length,
  width: r.width,
  height: r.height,
  occupancy: r.occupancy,
  co2: r.co2,
  lpg: r.lpg,
  temp: r.temp,
  humidity: r.humidity,
  connectionStatus: r.online ? "online" : "offline",
  alertCount: r.alertCount,
})) as unknown as IoTDevice[];