// src/lib/notifications.ts
//
// Types + helpers for sensor-driven air_notifications. The existing
// public.notifications mailbox keeps its own `Notification` type in
// NotificationContext; this module is for the NEW sensor alerts so the two
// lifecycles never get mixed in one type.

import type { Tone } from "../ui";

export type AirSeverity = "info" | "warning" | "high" | "danger" | "critical";
export type AirStatus = "open" | "acknowledged" | "resolved";
export type SensorType = "co2" | "lpg" | "temp" | "humidity" | "device";

export interface AirNotification {
  id: number;
  device_id: string;
  room_name: string;
  floor: string;
  sensor_type: SensorType;
  level_label: string;
  severity: AirSeverity;
  reading_value: number | null;
  reading_unit: string;
  message: string;
  status: AirStatus;
  handled_by_id: string | null;
  handled_by_name: string | null;
  handled_by_role: string | null;
  handled_at: string | null;
  /** Latest personnel action verb, e.g. "on_my_way" (not a DB column; joined client-side). */
  handled_action?: string | null;
  escalation_of: number | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface SmsLog {
  id: number;
  notification_id: number | null;
  personnel_id: string | null;
  recipient_name: string;
  recipient_role: string;
  phone: string | null;
  message: string;
  status: "submitted" | "in_progress" | "failed" | "skipped_no_number";
  provider_response: string | null;
  provider: string | null;
  provider_message_id: string | null;
  provider_status: string | null;
  sent_at: string;
}

export type AlertAction = "acknowledge" | "on_my_way" | "resolved" | "false_alarm" | "repaired" | "sms_sent";

export interface NotificationAction {
  id: number;
  notification_id: number;
  personnel_id: string | null;
  personnel_name: string;
  personnel_role: string;
  action: AlertAction;
  note: string | null;
  taken_at: string;
}

export const ACTION_LABEL: Record<AlertAction, string> = {
  acknowledge: "Acknowledged",
  on_my_way: "On my way",
  resolved: "Resolved",
  false_alarm: "False alarm",
  repaired: "Repaired",
  sms_sent: "SMS sent",
};

/** "On my way - Hirro Suniga (Maintenance), 2:41 PM" / "No action yet". */
export function handledByLine(n: {
  handled_by_name: string | null; handled_by_role: string | null;
  handled_at: string | null; handled_action?: string | null; status: string;
  severity: string; created_at: string;
}): { text: string; unhandled: boolean } {
  if (!n.handled_by_name) {
    const unhandled = (n.severity === "danger" || n.severity === "critical") && unhandledMinutes(
      // unhandledMinutes expects an AirNotification-shaped object.
      { status: n.status, severity: n.severity, created_at: n.created_at } as AirNotification, 10);
    return { text: "No action yet", unhandled };
  }
  const verb = n.handled_action ? ACTION_LABEL[n.handled_action as AlertAction] ?? n.handled_action.replace("_", " ")
    : n.status === "resolved" ? "Resolved" : "Acknowledged";
  const when = n.handled_at ? new Date(n.handled_at).toLocaleTimeString("en-PH", {
    timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" }) : "";
  return { text: `${verb} - ${n.handled_by_name} (${n.handled_by_role ?? ""})${when ? `, ${when}` : ""}`, unhandled: false };
}

export const SEVERITY_TONE: Record<AirSeverity, Tone> = {
  info: "neutral",
  warning: "warning",
  high: "high",
  danger: "danger",
  critical: "danger",
};

export const SENSOR_LABEL: Record<SensorType, string> = {
  co2: "CO2",
  lpg: "LPG",
  temp: "Temperature",
  humidity: "Humidity",
  device: "Device",
};

export function formatReading(n: AirNotification): string {
  if (n.reading_value == null && !n.reading_unit) return "—";
  const v = n.sensor_type === "temp" && n.reading_value != null ? n.reading_value.toFixed(1) : n.reading_value != null ? String(Math.round(n.reading_value)) : "—";
  return n.reading_unit ? `${v} ${n.reading_unit}` : v;
}

/** "2m ago", "3h ago" — Asia/Manila date. */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function manilaTime(iso: string): string {
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

export function maskPhone(raw: string | null | undefined): string {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length < 4) return "•".repeat(d.length);
  return "••••" + d.slice(-3);
}

/**
 * Recommended action plan — reuses the dashboard's actionMessage() text
 * (src/data/Data.ts) so the Notifications page and the SMS link page always
 * show the same guidance as the Dashboard.
 */
import { actionMessage, type Room } from "../data/Data";
import type { Thresholds } from "../data/Data";

export function actionPlanFor(n: AirNotification, thresholds: Thresholds): { title: string; body: string } {
  const room = {
    id: n.device_id, name: n.room_name, floor: n.floor,
    co2Sensor: "", gasSensor: null, tempHumiditySensor: null, deviceId: n.device_id,
    length: 0, width: 0, height: 0,
    co2: n.sensor_type === "co2" ? n.reading_value : null,
    lpg: n.sensor_type === "lpg" ? n.reading_value : null,
    temp: n.sensor_type === "temp" ? n.reading_value : null,
    humidity: n.sensor_type === "humidity" ? n.reading_value : null,
    online: n.level_label !== "Offline", lastReadingAt: n.created_at,
    alertCount: 0, installedAt: n.created_at.slice(0, 10), sirenMuted: false,
  } as Room;
  return actionMessage(room, thresholds);
}

/** Danger/Critical unhandled for > N minutes (default 15) -> warning style. */
export function unhandledMinutes(n: AirNotification, thresholdMin = 15): boolean {
  if (n.status !== "open") return false;
  if (n.severity !== "danger" && n.severity !== "critical") return false;
  const ms = Date.now() - new Date(n.created_at).getTime();
  return ms > thresholdMin * 60 * 1000;
}
