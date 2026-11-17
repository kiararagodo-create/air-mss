// src/lib/smsAutoSettings.ts
//
// Client access to the single-row automatic-SMS control settings stored in
// public.sms_alert_settings (id = 1). Reads are allowed for any signed-in
// user; writes are admin-only (enforced by RLS). This module never touches the
// manual SMS paths - it only drives the "Automatic SMS" card on the
// Notifications page.

import { supabase } from "./supabase";

export interface AutoSmsSettings {
  auto_sms_enabled: boolean;
  auto_sms_paused_until: string | null;
  always_send_danger: boolean;
  auto_sms_co2: boolean;
  auto_sms_lpg: boolean;
  auto_sms_temp: boolean;
  auto_sms_humidity: boolean;
  auto_sms_offline: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

/** Matches the DB defaults: nothing is suppressed until an admin changes it. */
export const AUTO_SMS_DEFAULTS: AutoSmsSettings = {
  auto_sms_enabled: true,
  auto_sms_paused_until: null,
  always_send_danger: true,
  auto_sms_co2: true,
  auto_sms_lpg: true,
  auto_sms_temp: true,
  auto_sms_humidity: true,
  auto_sms_offline: true,
  updated_by: null,
  updated_at: null,
};

/** Sentinel used by the "until I turn it on" pause option. */
export const INDEFINITE_PAUSE_ISO = "9999-12-31T23:59:59.000Z";

export type SensorFlagKey =
  | "auto_sms_co2"
  | "auto_sms_lpg"
  | "auto_sms_temp"
  | "auto_sms_humidity"
  | "auto_sms_offline";

export interface SensorFlagMeta {
  key: SensorFlagKey;
  sensor: "co2" | "lpg" | "temp" | "humidity" | "offline";
  label: string;
  description: string;
}

export const SENSOR_FLAGS: SensorFlagMeta[] = [
  { key: "auto_sms_co2", sensor: "co2", label: "CO2", description: "Carbon-dioxide readings (ppm)." },
  { key: "auto_sms_lpg", sensor: "lpg", label: "LPG", description: "Liquefied-petroleum gas leak readings." },
  { key: "auto_sms_temp", sensor: "temp", label: "Temperature", description: "Heat and freeze readings (°C)." },
  { key: "auto_sms_humidity", sensor: "humidity", label: "Humidity", description: "Dry and mold-risk readings (%RH)." },
  { key: "auto_sms_offline", sensor: "offline", label: "Device offline", description: "A device stopped sending readings." },
];

const SETTINGS_COLUMNS =
  "auto_sms_enabled, auto_sms_paused_until, always_send_danger, auto_sms_co2, auto_sms_lpg, auto_sms_temp, auto_sms_humidity, auto_sms_offline, updated_by, updated_at";

export async function loadAutoSmsSettings(): Promise<AutoSmsSettings | null> {
  const { data, error } = await supabase
    .from("sms_alert_settings")
    .select(SETTINGS_COLUMNS)
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.error("Failed to load automatic SMS settings:", error.message);
    return null;
  }
  if (!data) return { ...AUTO_SMS_DEFAULTS };
  const row = data as Partial<AutoSmsSettings>;
  return {
    auto_sms_enabled: row.auto_sms_enabled ?? true,
    auto_sms_paused_until: row.auto_sms_paused_until ?? null,
    always_send_danger: row.always_send_danger ?? true,
    auto_sms_co2: row.auto_sms_co2 ?? true,
    auto_sms_lpg: row.auto_sms_lpg ?? true,
    auto_sms_temp: row.auto_sms_temp ?? true,
    auto_sms_humidity: row.auto_sms_humidity ?? true,
    auto_sms_offline: row.auto_sms_offline ?? true,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

/** Admin-only write. Stamps updated_by/updated_at and relies on RLS for safety. */
export async function saveAutoSmsSettings(patch: Partial<AutoSmsSettings>): Promise<SaveResult> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id ?? null;
  const { error } = await supabase
    .from("sms_alert_settings")
    .update({ ...patch, updated_by: uid, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) {
    console.error("Failed to save automatic SMS settings:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function loadUpdaterName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.from("profiles").select("name").eq("id", id).maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

/** Live cross-tab sync: fires whenever any client writes the settings row. */
export function subscribeAutoSmsSettings(onChange: () => void): () => void {
  const channel = supabase
    .channel("sms-auto-settings-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "sms_alert_settings" }, () => onChange())
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** True when automatic SMS is currently paused (a pause time is in the future). */
export function isAutoSmsPaused(settings: AutoSmsSettings | null): boolean {
  if (!settings?.auto_sms_paused_until) return false;
  const t = new Date(settings.auto_sms_paused_until).getTime();
  return Number.isFinite(t) && t > Date.now();
}

// ---------------------------------------------------------------------------
// SMS delivery notice: grouped counts + the rows behind them (last 24h).
// ---------------------------------------------------------------------------

export interface SkippedSmsRow {
  id: number;
  notification_id: number | null;
  status: string;
  provider_response: string | null;
  sent_at: string;
  severity: string | null;
  level_label: string | null;
  room_name: string | null;
  sensor_type: string | null;
}

export interface SmsSkipSummary {
  total: number;
  lowCredits: number;
  rateLimited: number;
  autoOff: number;
  danger: number;
  rows: SkippedSmsRow[];
}

export const EMPTY_SKIP_SUMMARY: SmsSkipSummary = {
  total: 0,
  lowCredits: 0,
  rateLimited: 0,
  autoOff: 0,
  danger: 0,
  rows: [],
};

const SKIP_STATUSES = ["skipped_low_credits", "skipped_rate_limited", "skipped_auto_off"];

function embeddedAlert(value: unknown): { severity?: string; level_label?: string; room_name?: string; sensor_type?: string } | null {
  if (!value) return null;
  if (Array.isArray(value)) return (value[0] as any) ?? null;
  return value as any;
}

export async function loadSmsSkipSummary(): Promise<SmsSkipSummary> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("sms_logs")
    .select(
      "id, notification_id, status, provider_response, sent_at, air_notifications(severity, level_label, room_name, sensor_type)",
    )
    .gte("sent_at", since)
    .in("status", SKIP_STATUSES)
    .order("sent_at", { ascending: false })
    .limit(200);
  if (error) {
    console.error("Failed to load skipped SMS summary:", error.message);
    return { ...EMPTY_SKIP_SUMMARY };
  }

  const rows: SkippedSmsRow[] = [];
  let lowCredits = 0;
  let rateLimited = 0;
  let autoOff = 0;
  let danger = 0;

  for (const raw of ((data as any[]) ?? [])) {
    const alert = embeddedAlert(raw.air_notifications);
    const severity = alert?.severity ?? null;
    if (severity === "danger" || severity === "critical") danger += 1;
    if (raw.status === "skipped_low_credits") lowCredits += 1;
    else if (raw.status === "skipped_rate_limited") rateLimited += 1;
    else if (raw.status === "skipped_auto_off") autoOff += 1;
    rows.push({
      id: Number(raw.id),
      notification_id: raw.notification_id == null ? null : Number(raw.notification_id),
      status: String(raw.status),
      provider_response: raw.provider_response ?? null,
      sent_at: raw.sent_at,
      severity,
      level_label: alert?.level_label ?? null,
      room_name: alert?.room_name ?? null,
      sensor_type: alert?.sensor_type ?? null,
    });
  }

  return { total: rows.length, lowCredits, rateLimited, autoOff, danger, rows };
}

export function skipStatusLabel(status: string): string {
  switch (status) {
    case "skipped_low_credits":
      return "low credits";
    case "skipped_rate_limited":
      return "rate limit";
    case "skipped_auto_off":
      return "auto SMS off";
    default:
      return status.replace(/^skipped_/, "").replace(/_/g, " ");
  }
}

/** Count of automatic SMS actually submitted in the last 24h. */
export async function loadAutoSmsSentCount(): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await supabase
    .from("sms_logs")
    .select("id", { count: "exact", head: true })
    .eq("is_auto", true)
    .eq("status", "submitted")
    .gte("sent_at", since);
  if (error) {
    console.error("Failed to count automatic SMS sent:", error.message);
    return 0;
  }
  return count ?? 0;
}
