// src/lib/alertActions.ts
//
// Client side of (A) personnel actions and (B) manual SMS.
//
// Writes NEVER go direct to air_notifications / notification_actions /
// sms_logs from the browser: RLS only lets admins write those tables, and
// staff must be able to act too. Both operations therefore go through
// Supabase Edge Functions (service role server-side, provider API keys never
// in the browser; provider picked by SMS_PROVIDER: semaphore|philsms|iprog):
//   record-action  (JWT required)  ensure-live-alert + insert action + update
//                                  handled_by_*, notify all other personnel
//   send-sms       (JWT required)  role-check admin/security, credits +
//                                  cooldown, provider send, sms_logs +
//                                  notification_recipients (24h token)
//
// A "live alert" (computed from readings, no DB row yet) is passed as
// `live: {device_id, sensor_type, level_label, severity, reading_value,
// reading_unit, room_name, floor, message}`; the function upserts the
// air_notifications row (one open row per device+sensor+level) first.

import { supabase } from "./supabase";
import { maskPhone, type AlertAction } from "./notifications";

export interface LiveAlertInput {
  device_id: string;
  room_name: string;
  floor: string;
  sensor_type: string;
  level_label: string;
  severity: string;
  reading_value: number | null;
  reading_unit: string;
  message: string;
}

export interface AlertRef {
  notificationId?: number | null;
  live?: LiveAlertInput | null;
}

export interface RecordActionResult {
  ok: boolean;
  notification: any;
  action: any;
  error?: string;
}

export async function recordAlertAction(
  ref: AlertRef,
  action: AlertAction,
  note?: string
): Promise<RecordActionResult> {
  const { data, error } = await supabase.functions.invoke("record-action", {
    body: {
      notification_id: ref.notificationId ?? null,
      live: ref.live ?? null,
      action,
      note: note?.trim() ? note.trim().slice(0, 1000) : null,
    },
  });
  if (error) {
    let msg = error.message;
    try {
      const ctx = await (error as any).context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* keep original */ }
    return { ok: false, notification: null, action: null, error: msg };
  }
  if ((data as any)?.error) {
    return { ok: false, notification: null, action: null, error: (data as any).error };
  }
  return { ok: true, notification: (data as any).notification, action: (data as any).action };
}

export interface PersonnelRow {
  id: string;
  name: string;
  role: string;
  contact_number: string | null;
  sms_enabled?: boolean;
}

/**
 * Valid Philippine mobile numbers: 09XXXXXXXXX, 639XXXXXXXXX (with or without
 * +) or 9XXXXXXXXX. Mirrors isValidPhMobile() in
 * supabase/functions/_shared/sms_recipients.ts.
 */
export function isValidPhMobile(raw: unknown): boolean {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return /^(09\d{9}|639\d{9}|9\d{9})$/.test(digits);
}

/**
 * Only people who may actually receive an SMS: active, approved, SMS switch
 * ON (Personnel Management) and a valid number. Anyone else is never listed,
 * so they cannot be ticked or counted in the Send SMS dialog.
 */
export async function fetchPersonnel(): Promise<PersonnelRow[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, role, contact_number, sms_enabled")
    .eq("is_active", true)
    .eq("account_status", "approved")
    .eq("sms_enabled", true)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data as PersonnelRow[]) ?? []).filter((p) => isValidPhMobile(p.contact_number));
}

/**
 * Nobody is pre-selected. The sender ticks exactly who should get the text.
 * (This used to tick people by role and severity, which texted people the
 * sender never chose.) The parameters are kept so existing callers still work.
 */
export function preselectRoleIds(
  _personnel: PersonnelRow[],
  _severity: string,
  _levelLabel: string
): Set<string> {
  return new Set<string>();
}

// ---------------------------------------------------------------------------
// Default message for the Send SMS dialog.
// Same rules as supabase/functions/_shared/sms-templates.ts: plain ASCII, one
// 160-character segment, real room name, 12-hour Asia/Manila time, no link.
// ---------------------------------------------------------------------------

const SMS_MAX = 160;

function smsAscii(input: unknown): string {
  return String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00B0/g, "")
    .replace(/[^A-Za-z0-9 .,:;!?'()\-+/%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function smsClip(input: unknown, max: number): string {
  const s = smsAscii(input);
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  if (s[max] !== " ") {
    const sp = cut.lastIndexOf(" ");
    if (sp >= Math.floor(max / 2)) cut = cut.slice(0, sp);
  }
  return cut.replace(/[\s,;:\-]+$/, "").trim();
}

/** "2:11 PM" in Asia/Manila. Built from parts so no special space appears. */
function manilaClock(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}

const SMS_SENSOR_LABEL: Record<string, string> = {
  co2: "CO2", lpg: "gas (LPG)", temp: "temperature", humidity: "humidity",
};

function smsReading(l: LiveAlertInput): string {
  if (l.reading_value == null || !Number.isFinite(l.reading_value)) return "";
  const v = l.sensor_type === "temp"
    ? l.reading_value.toFixed(1)
    : String(Math.round(l.reading_value));
  const unit = smsAscii(String(l.reading_unit ?? "").replace("%RH", "%"));
  if (!unit) return v;
  return unit === "%" ? `${v}%` : `${v} ${unit}`;
}

export function prefillAlertMessage(ref: AlertRef): string {
  const l = ref.live;
  if (!l && ref.notificationId == null) return "";
  const time = manilaClock();
  if (!l) return `A.I.R. ALERT: Please check the dashboard now. ${time}`.slice(0, SMS_MAX);

  const room = smsClip(l.room_name, 30) || "unknown room";
  const sensor = SMS_SENSOR_LABEL[String(l.sensor_type ?? "").toLowerCase()] ?? smsClip(l.sensor_type, 16) ?? "sensor";
  const reading = smsReading(l);
  const sev = String(l.severity ?? "").toLowerCase();
  const lvl = String(l.level_label ?? "").toLowerCase();

  let msg: string;
  if (String(l.sensor_type ?? "").toLowerCase() === "device" || lvl === "offline") {
    msg = `A.I.R. OFFLINE at ${room}: sensor sent no data. Please check the device. ${time}`;
  } else if (sev === "danger" || sev === "critical" || lvl === "alarm") {
    msg = `A.I.R. DANGER at ${room}: ${sensor}${reading ? " " + reading : ""}. Go check now. ${time}`;
  } else {
    const low = ["freeze", "cool", "dry", "low"].includes(lvl);
    msg = `A.I.R. WARNING at ${room}: ${sensor} is ${low ? "low" : "high"}${reading ? ` (${reading})` : ""}. Please check the room. ${time}`;
  }
  return msg.slice(0, SMS_MAX);
}

/** GSM-7 (160/153) vs Unicode (70/67) SMS segment count. */
export function smsSegments(message: string): { chars: number; segments: number; encoding: "GSM-7" | "Unicode" } {
  const gsm = /^[\x00-\x7F\u20AC\u00A3\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\u00D8\u00F8\u00D9\u00DA\u00DE\u00DF\u00C6\u00E6\u00C4\u00E4\u00D6\u00F6\u00DC\u00FC\u00A1\u00BF\u0391\u0392\u0393\u0394\u0395\u0396\u0397\u0398\u0399\u039A\u039B\u039C\u039D\u039E\u039F\u03A0\u03A1\u03A3\u03A4\u03A5\u03A6\u03A7\u03A8\u03A9\u03B1\u03B2\u03B3\u03B4\u03B5\u03B6\u03B7\u03B8\u03B9\u03BA\u03BB\u03BC\u03BD\u03BE\u03BF\u03C0\u03C1\u03C2\u03C3\u03C4\u03C5\u03C6\u03C7\u03C8\u03C9\u03B1\u03B2\u03B3\u03B4\u03B5\u03B6\u03B7\u03B8\u03B9\u03BA\u03BB\u03BC\u03BD\u03BE\u03BF\u03C0\u03C1\u03C3\u03C4\u03C5\u03C6\u03C7\u03C8\u03C9]*$/.test(message);
  const chars = message.length;
  const segments = chars === 0 ? 0 : gsm ? Math.ceil(chars / 160) : Math.ceil(chars / 70);
  return { chars, segments: Math.max(1, segments), encoding: gsm ? "GSM-7" : "Unicode" };
}

/** iProg codes documented at developer.iprogtech.com/reference/api-error-codes. */
export function readableProviderError(error: string | null | undefined, providerLabel = "SMS"): string {
  const e = String(error ?? "");
  if (/AUTHENTICATION_FAILED|INVALID_APIKEY|INVALID_APISECRET|INVALID_API_KEY_SECRET|OFTEN_WRONG_APIKEY/i.test(e)) {
    if (providerLabel === "IPROG") return "iProg rejected the API token. Check the IPROG_SMS_API_TOKEN secret.";
    return "Movider rejected the API key or secret. Generate a new key and copy it with the Copy button.";
  }
  if (/INSUFFICIENT_BALANCE|BALANCE_EXPIRED/i.test(e)) {
    if (providerLabel === "IPROG") return "iProg balance is insufficient or expired. Top up your iProg account.";
    return "Movider balance is insufficient or expired. Top up your Movider account, then try again.";
  }
  if (/ERR_SENDER/i.test(e)) {
    if (providerLabel === "IPROG") return "iProg rejected the sender configuration.";
    return "Movider rejected the sender name (MOVIDER_SENDER_NAME). Use a sender name registered with Movider (case-sensitive) or remove it to use the default sender.";
  }
  if (/ERR_INVALID_TO|ERR_INVALID_RECEIVER_NUMBER|ERR_INVALID_TEXT|ERR_INVALID_SENDMSG_FORM/i.test(e)) {
    if (providerLabel === "IPROG") return "iProg rejected the phone number or message. Check the number format (09XXXXXXXXX) and that the message is not empty.";
    return "Movider rejected the phone number or message. Check the number format (639XXXXXXXXX) and that the message is not empty.";
  }
  if (/IP_WHITELIST/i.test(e)) {
    if (providerLabel === "IPROG") return "iProg unreachable. Check your network connectivity.";
    return "Movider rejected the request IP (IP whitelist). Send from an approved IP or update the Movider IP whitelist.";
  }
  if (/MEMBER_BANNED|MEMBER_SUSPENDED/i.test(e)) {
    if (providerLabel === "IPROG") return "Your iProg account is banned or suspended. Contact iProg support.";
    return "Your Movider account is banned or suspended. Contact Movider support to reactivate it.";
  }
  if (/credits are 0/i.test(e)) return e.replace(/IPROG|Semaphore|PhilSMS|Movider/g, providerLabel);
  return e || "Failed";
}

export interface SmsSendResult {
  personnel_id: string;
  name: string;
  role: string;
  phone_masked: string;
  status: "submitted" | "failed" | "skipped" | "skipped_no_number";
  provider_response: string | null;
  error: string | null;
}

export interface SmsSendResponse {
  ok: boolean;
  credits: number | null;
  provider?: string;
  providerLabel?: string;
  credits_warning?: string | null;
  cooldown?: boolean;
  last_sent_at?: string | null;
  results: SmsSendResult[];
  error?: string;
}

export async function sendSmsManual(opts: {
  ref: AlertRef;
  recipientIds: string[];
  message: string;
  sendAnyway?: boolean;
}): Promise<SmsSendResponse> {
  const { data, error } = await supabase.functions.invoke("send-sms", {
    body: {
      action: "send",
      notification_id: opts.ref.notificationId ?? null,
      live: opts.ref.live ?? null,
      recipient_ids: opts.recipientIds,
      message: opts.message,
      send_anyway: !!opts.sendAnyway,
    },
  });
  if (error) {
    let msg = error.message;
    try {
      const ctx = await (error as any).context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* keep original */ }
    return { ok: false, credits: null, results: [], error: msg };
  }
  return data as SmsSendResponse;
}

export interface SmsCredits {
  credits: number | null;
  provider: string;
  providerLabel: string;
  authError: string | null;
}

/** Admin-only: balance-endpoint-only connection test (no SMS sent). */
export async function testSmsConnection(): Promise<{
  tokenValid: boolean; creditsLeft: number | null; error: string | null;
}> {
  const { data, error } = await supabase.functions.invoke("send-sms", { body: { action: "test" } });
  if (error || !data) {
    let msg = error?.message ?? "Test failed";
    try {
      const ctx = await (error as any)?.context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* keep original */ }
    return { tokenValid: false, creditsLeft: null, error: readableProviderError(msg) };
  }
  const credits = (data as any)?.creditsLeft ?? (data as any)?.credits;
  return {
    tokenValid: !!(data as any)?.tokenValid,
    creditsLeft: typeof credits === "number" && Number.isFinite(credits) ? credits : null,
    error: (data as any)?.error ? readableProviderError((data as any).error) : null,
  };
}

export async function fetchSmsCredits(): Promise<SmsCredits> {
  const { data, error } = await supabase.functions.invoke("send-sms", {
    body: { action: "credits" },
  });
  if (error || !data) return { credits: null, provider: "", providerLabel: "SMS", authError: null };
  const credits = (data as any)?.credits;
  return {
    credits: typeof credits === "number" && Number.isFinite(credits) ? credits : null,
    provider: (data as any)?.provider ?? "",
    providerLabel: (data as any)?.providerLabel ?? "SMS",
    authError: (data as any)?.auth_error ?? null,
  };
}

export { maskPhone };
