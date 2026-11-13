// Shared alert evaluation for the A.I.R. notification system.
//
// Mirrors src/lib/thresholdConfig.ts (the dashboard's severity grading) so the
// bell, the SMS, and the reference guides can never disagree.

export type SensorType = "co2" | "lpg" | "temp" | "humidity" | "device";
export type NotificationSeverity = "info" | "warning" | "high" | "danger" | "critical";
export type NotificationStatus = "open" | "acknowledged" | "resolved";

export interface Tier3 { warning: number; high: number; danger: number; }
export interface TempTier { freezeBelow: number; coolBelow: number; heatAbove: number; }
export interface HumidityTier { dryBelow: number; lowBelow: number; moldAbove: number; }

export interface Thresholds {
  co2: Tier3;
  lpg: Tier3;
  temp: TempTier;
  humidity: HumidityTier;
}

export interface EvaluatedLevel {
  level_label: string;
  severity: NotificationSeverity;
  reading_value: number | null;
  reading_unit: string;
  message: string;
}

const SENSOR_LABEL: Record<SensorType, string> = {
  co2: "CO2",
  lpg: "LPG",
  temp: "Temperature",
  humidity: "Humidity",
  device: "Device",
};

export function evaluateSensor(
  sensor: Exclude<SensorType, "device">,
  value: number | null,
  th: Thresholds
): EvaluatedLevel | null {
  if (value == null || !Number.isFinite(value)) return null;

  if (sensor === "co2") {
    if (value >= th.co2.danger) return mk("Danger", "danger", value, "ppm");
    if (value >= th.co2.high) return mk("High", "high", value, "ppm");
    if (value >= th.co2.warning) return mk("Warning", "warning", value, "ppm");
    return null;
  }
  if (sensor === "lpg") {
    if (value >= th.lpg.danger) return mk("Critical", "critical", value, "ppm");
    if (value >= th.lpg.high) return mk("Alarm", "high", value, "ppm");
    if (value >= th.lpg.warning) return mk("Low Leak", "warning", value, "ppm");
    return null;
  }
  if (sensor === "temp") {
    // strict comparisons match dashboard/report SQL behavior
    if (value < th.temp.freezeBelow) return mk("Freeze", "danger", value, "°C");
    if (value <= th.temp.coolBelow) return mk("Cool", "warning", value, "°C");
    if (value > th.temp.heatAbove) return mk("Heat", "danger", value, "°C");
    return null;
  }
  // humidity
  if (value < th.humidity.dryBelow) return mk("Dry", "danger", value, "%RH");
  if (value <= th.humidity.lowBelow) return mk("Low", "warning", value, "%RH");
  if (value > th.humidity.moldAbove) return mk("Mold Risk", "danger", value, "%RH");
  return null;

  function mk(level_label: string, severity: NotificationSeverity, v: number, unit: string): EvaluatedLevel {
    const display = unit === "°C" ? v.toFixed(1) : String(Math.round(v));
    return {
      level_label,
      severity,
      reading_value: v,
      reading_unit: unit,
      message: `A.I.R. ALERT [${level_label.toUpperCase()}] ${SENSOR_LABEL[sensor]} ${display} ${unit}.`,
    };
  }
}

/** severity -> recipients hint (kept for compatibility; auto-SMS now targets all eligible SMS personnel). */
export function rolesForSeverity(severity: NotificationSeverity, level_label: string): string[] {
  if (level_label === "Offline") return ["admin", "maintenance", "security"];
  if (level_label === "Online") return ["maintenance", "admin", "security"];
  if (severity === "warning" || severity === "high") return ["maintenance", "security", "admin"];
  if (severity === "danger" || severity === "critical") return ["maintenance", "security", "admin"];
  return ["maintenance", "security", "admin"];
}

/** 09XXXXXXXXX / +63... / 639... -> +639XXXXXXXXX for SMS sending. null when invalid per rule. */
export function normalizePhPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (/^09\d{9}$/.test(d)) return `+63${d.slice(1)}`;
  if (/^639\d{9}$/.test(d)) return `+${d}`;
  if (/^\+639\d{9}$/.test(String(raw).trim())) return String(raw).trim();
  return null;
}

export function maskPhone(raw: string | null | undefined): string {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length < 4) return "*".repeat(Math.max(0, d.length));
  return "****" + d.slice(-4);
}

export function isSensorSaturated(sensor: SensorType, value: number | null): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  if (sensor === "co2") return value >= 5000; // MH-Z19 max range
  if (sensor === "lpg") return value >= 10000;
  return false;
}

export function isQualityReading(
  sensor: SensorType | "device",
  value: number | null,
  humidity: number | null = null,
  allZero = false
): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  // An all-zero sensor snapshot is treated as a likely sensor fault/disconnect.
  if (allZero) return false;
  if (sensor === "temp") {
    if (value < -40 || value > 80) return false;
    if (value === 0 && humidity === 0) return false; // likely sensor fault
    return true;
  }
  if (sensor === "humidity") {
    if (value < 0 || value > 100) return false;
    if (value === 0 && humidity === 0) return false;
    return true;
  }
  if (sensor === "co2") return value >= 0 && value <= 10000;
  if (sensor === "lpg") return value >= 0 && value <= 10000;
  return true;
}

export function isSensorFaultReading(
  sensor: SensorType | "device",
  value: number | null,
  humidity: number | null = null,
  allZero = false
): boolean {
  // Garbage values are faults. Saturation-at-max (e.g. CO2 5000) is NOT a fault:
  // it must still create alerts/SMS, but UI/logs should flag it.
  return !isQualityReading(sensor, value, humidity, allZero);
}

export function formatReadingForDisplay(
  sensor: SensorType | "device",
  value: number | null,
  humidity: number | null = null,
  allZero = false
): string {
  if (isSensorFaultReading(sensor, value, humidity, allZero)) return "Sensor error";
  if (value == null || !Number.isFinite(value)) return "N/A";
  if (sensor === "temp") return `${value.toFixed(1)} °C`;
  if (sensor === "humidity") return `${Math.round(value)} %RH`;
  return `${Math.round(value)} ppm`;
}

export function buildSmsMessage(opts: {
  severityLabel: string; roomName: string; floor: string;
  reading: string; time?: string;
}): string {
  const loc = opts.floor ? `${opts.roomName} - ${opts.floor}` : opts.roomName;
  const timePart = opts.time ? ` at ${opts.time}` : "";
  const msg = `[${opts.severityLabel.toUpperCase()}] ${loc}: ${opts.reading}${timePart}. Please respond.`;
  return msg.slice(0, 160);
}

export function newActionToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
