// Shared alert evaluation for the A.I.R. notification system.
//
// Mirrors src/lib/thresholdConfig.ts (the dashboard's severity grading) so the
// bell, the SMS, and the reference guides can never disagree. Boundaries are
// inclusive (>=) for gases, strict (< / >) for temp/humidity, matching
// report_is_danger() in SQL.
//
// The mapping from a graded level to a notification severity/label follows the
// brief's thresholds section:
//   CO2 warning/high/danger        -> Warning / High / Danger
//   LPG warning/high/danger        -> Low Leak / Alarm / Critical
//   Temp Freeze/Cool/Heat          -> danger / warning / danger
//   Humidity Dry/Low/Mold Risk     -> danger / warning / danger
// LPG danger is severity 'critical' (not 'danger') so the UI can emphasize it
// separately; CO2 danger stays 'danger'. Both are "visually emphasized (red)".

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

/** severity -> recipients (brief §4). Warning/High/Low Leak: Maintenance.
 *  Danger/Alarm/Critical: Maintenance + Security + Administrator.
 *  Offline: Administrator only. Online (all-clear): Maintenance + Administrator. */
export function rolesForSeverity(severity: NotificationSeverity, level_label: string): string[] {
  if (level_label === "Offline") return ["admin"];
  if (level_label === "Online") return ["maintenance", "admin"];
  if (severity === "warning" || severity === "high") return ["maintenance"];
  if (severity === "danger" || severity === "critical") return ["maintenance", "security", "admin"];
  return []; // info (e.g. back-online): no SMS
}

/** 09XXXXXXXXX / +63... / 639... -> 09XXXXXXXXX (iProG format). null when invalid. */
export function normalizePhPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0063")) d = d.slice(4);
  if (d.startsWith("63") && d.length === 12) return "0" + d.slice(2);  // 639XXXXXXXXX -> 09XXXXXXXXX
  if (d.startsWith("9") && d.length === 10) return "0" + d;            // 9XXXXXXXXX -> 09XXXXXXXXX
  if (d.length === 10 && d.startsWith("0")) return "0" + d;            // 0XXXXXXXXX -> 09XXXXXXXXX (keep leading 0)
  if (d.length === 11 && d.startsWith("09")) return d;                 // 09XXXXXXXXX -> 09XXXXXXXXX (keep as-is)
  if (d.length === 12 && d.startsWith("639")) return "0" + d.slice(2); // 639XXXXXXXXX -> 09XXXXXXXXX
  return d.length >= 10 ? d : null;
}

export function maskPhone(raw: string | null | undefined): string {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length < 4) return "•".repeat(d.length);
  return "••••" + d.slice(-3);
}

/**
 * @deprecated Use sendSms() from sms-provider.ts (provider-pluggable).
 * Kept only so older deployed bundles still compile; new code must not call it.
 * IPROG SMS send. Server-only: the token lives in IPROG_API_TOKEN.
 */
export async function sendIprogSms(
  apiToken: string,
  phone: string,
  message: string
): Promise<{ ok: boolean; response: string }> {
  try {
    const res = await fetch("https://sms.iprogtech.com/api/v1/sms_messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: apiToken, phone_number: phone, message }),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw */ }
    if (!res.ok || data?.status !== 200 || !data?.message_id) {
      return { ok: false, response: `HTTP ${res.status}: ${text}`.slice(0, 500) };
    }
    return { ok: true, response: text ? text.slice(0, 500) : "submitted" };
  } catch (e) {
    return { ok: false, response: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function isQualityReading(sensor: SensorType | "device", value: number | null, humidity: number | null = null, allZero = false): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  // A record whose every sensor is exactly 0 is a faulty transmitter, not an
  // alarm (e.g. AIR-D01 reporting temp 0.0 / humidity 0 / CO2 0).
  if (allZero) return false;
  if (sensor === "temp") {
    if (value < -40 || value > 80) return false;
    if (value === 0 && humidity === 0) return false;
    return true;
  }
  if (sensor === "humidity") return value >= 0 && value <= 100;
  if (sensor === "co2" || sensor === "lpg") return value >= 0 && value <= 10000;
  return true;
}

export function buildSmsMessage(opts: {
  severityLabel: string; roomName: string; floor: string;
  reading: string; time?: string;
}): string {
  const loc = opts.floor ? `${opts.roomName} ${opts.floor}` : opts.roomName;
  const timePart = opts.time ? ` ${opts.time}` : "";
  const msg = `A.I.R. ${opts.severityLabel.toUpperCase()} ${loc}: ${opts.reading}.${timePart}`;
  return msg.slice(0, 160);
}

export function newActionToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
