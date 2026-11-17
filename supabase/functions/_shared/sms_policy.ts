// supabase/functions/_shared/sms_policy.ts
//
// Central SMS policy for the A.I.R. notification system.
//
//   * Channel priority:
//       danger (CO2/LPG danger tier, critical, siren, heat) -> SMS + email
//       offline                                             -> one SMS per outage per
//                                                              device (after
//                                                              SMS_OFFLINE_MIN_SILENCE_MS),
//                                                              then email-only reminders
//       warning/high (incl. COOL and HUMIDITY warnings)     -> email + dashboard only,
//                                                              unless SMS_FOR_WARNINGS
//                                                              or SMS_FOR_COOL_HUMIDITY
//   * Cooldown: one SMS when an alert opens, then at most one reminder every
//     SMS_REMINDER_INTERVAL_MS (45 minutes default). Never repeat SMS for an
//     open, already-notified alert. Escalation always sends immediately.
//   * Low credits: drop lower-priority first, never drop danger before others;
//     at zero credits drop everything but never retry-spam.
//   * Brownout: >= BROWNOUT_MIN_DEVICES active devices offline within
//     BROWNOUT_WINDOW_MS (60s) -> one SMS instead of N.
//   * Credit monitoring: balance snapshot + once-only admin emails below the
//     threshold and at empty. Don't email repeatedly.

export const SMS_REMINDER_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes

/** Flip to true to also SMS warning-level alerts (default: email/dashboard only). */
export const SMS_FOR_WARNINGS_DEFAULT = false;

/** Flip to true to also SMS COOL and HUMIDITY (Low) warnings (default: email/dashboard only). */
export const SMS_FOR_COOL_HUMIDITY_DEFAULT = false;

/** Default low-credit threshold (messages). */
export const LOW_CREDIT_THRESHOLD_DEFAULT = 50;

/** Minimum silence (ms) before an offline SMS is sent. Device is marked offline
 *  at DEFAULT_OFFLINE_AFTER_S but SMS waits this long to avoid alerting on
 *  transient blips. */
export const SMS_OFFLINE_MIN_SILENCE_MS = 10 * 60 * 1000; // 10 minutes

export const BROWNOUT_MIN_DEVICES = 3;
export const BROWNOUT_WINDOW_MS = 60 * 1000; // 60 seconds

/** How long before a credit check is considered stale (24 hours). */
export const CREDIT_STALE_MS = 24 * 60 * 60 * 1000;

export type AlertChannel = "danger" | "offline" | "warning" | "info";

/** Classify an alert into a channel band. */
export function alertChannel(severity: string, levelLabel: string): AlertChannel {
  const sev = String(severity ?? "").toLowerCase();
  const lbl = String(levelLabel ?? "").toLowerCase();
  if (lbl === "offline") return "offline";
  if (sev === "danger" || sev === "critical" || /danger|critical|siren/i.test(lbl)) return "danger";
  if (sev === "warning" || sev === "high") return "warning";
  return "info";
}

export interface ChannelDecision {
  sms: boolean;
  email: boolean;
  reason: string;
}

export function channelFor(channel: AlertChannel, smsForWarnings: boolean, levelLabel?: string): ChannelDecision {
  switch (channel) {
    case "danger":
      return { sms: true, email: true, reason: "danger" };
    case "offline":
      return { sms: true, email: true, reason: "offline_open" };
    case "warning": {
      // COOL (temp) and LOW (humidity) warnings are email/dashboard only by
      // default, controlled by SMS_FOR_COOL_HUMIDITY_DEFAULT. Other warnings
      // (e.g. CO2 Warning, High) follow SMS_FOR_WARNINGS.
      const coolHumidity = levelLabel ? /^(Cool|Low)$/i.test(levelLabel) : false;
      const smsEnabled = coolHumidity ? SMS_FOR_COOL_HUMIDITY_DEFAULT : smsForWarnings;
      return {
        sms: smsEnabled,
        email: true,
        reason: smsEnabled ? "warning_sms_enabled" : "warning_email_only",
      };
    }
    default:
      return { sms: false, email: true, reason: "info_email_only" };
  }
}

export interface CreditVerdict {
  allowed: boolean;
  credits: number | null;
  threshold: number;
  reason: string;
  drop: "none" | "non_danger" | "all";
}

/** Decide whether an SMS may be sent given the observed balance and channel. */
export function creditVerdict(
  credits: number | null,
  channel: AlertChannel,
  threshold: number,
): CreditVerdict {
  const thr = threshold > 0 ? threshold : LOW_CREDIT_THRESHOLD_DEFAULT;
  if (credits === 0) {
    return { allowed: false, credits: 0, threshold: thr, reason: "credits_zero", drop: "all" };
  }
  if (credits !== null && credits < thr) {
    // Danger alerts are never the first to be dropped; they still go while
    // credits remain. Lower-priority channels are dropped first.
    if (channel === "danger") {
      return { allowed: true, credits, threshold: thr, reason: "low_credits_danger_allowed", drop: "none" };
    }
    return { allowed: false, credits, threshold: thr, reason: "low_credits", drop: "non_danger" };
  }
  return { allowed: true, credits: credits ?? null, threshold: thr, reason: "credits_ok", drop: "none" };
}

/** iProg error names/codes that mean insufficient or expired credits. */
export const CREDIT_ERROR_CODES = [
  "ERR_INSUFFICIENT_BALANCE",
  "ERR_BALANCE_EXPIRED",
];

export function isCreditError(error: string | null | undefined): boolean {
  const code = String(error ?? "").toUpperCase();
  return CREDIT_ERROR_CODES.some((c) => code.includes(c)) ||
    /insufficient|balance|expired/i.test(code);
}

/** Strip any occurrence of the iProg API token from a provider response string
 *  before it is persisted to sms_logs.provider_response. Never store the real
 *  token (or any message_status_link that may embed it). */
export function sanitizeProviderResponse(
  raw: string | null | undefined,
  apiToken: string | null | undefined,
): string | null {
  if (!raw) return null;
  if (!apiToken) return String(raw);
  let s = String(raw);
  // Remove the full token if it appears anywhere in the response.
  s = s.split(apiToken).join("[REDACTED]");
  // Also redact a masked variant (first4 + *** + last4) if long enough.
  if (apiToken.length > 8) {
    const masked = apiToken.slice(0, 4) + "***" + apiToken.slice(-4);
    s = s.split(masked).join("[REDACTED]");
  }
  return s;
}

export interface SmsSendResult {
  ok: boolean;
  error: string | null;
  providerMessageId: string | null;
  status: string;
  raw: unknown;
}

/** Send one email via Resend (server-only; RESEND_API_KEY never reaches the browser). */
export async function sendResendEmail(
  to: string[],
  subject: string,
  html: string,
): Promise<{ ok: boolean; error: string | null }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_EMAIL_FROM") ?? "A.I.R. <onboarding@resend.dev>";
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not configured" };
  if (to.length === 0) return { ok: false, error: "No recipients" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Build a concise HTML body for a credit alert to admins. */
export function creditEmailHtml(kind: "warning" | "empty", balance: number | null, threshold: number): string {
  const when = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
  const balancePart = balance === null ? "unreadable" : String(balance);
  if (kind === "empty") {
    return `
    <h2>A.I.R. - SMS credits empty</h2>
    <p>iProgSMS reports <b>zero SMS credits</b> as of ${when}. Automatic SMS alerts are
    suspended until the account is topped up. Alerts are still created and shown on the
    dashboard; email remains active.</p>
    <p>Top up your iProgSMS account to restore SMS delivery.</p>`;
  }
  return `
    <h2>A.I.R. - Low SMS credits</h2>
    <p>iProgSMS balance is <b>${balancePart} message(s)</b>, below the ${threshold}-message
    threshold, as of ${when}. Lower-priority SMS alerts are being dropped; danger alerts
    still attempt SMS while credits remain.</p>
    <p>Consider topping up your iProgSMS account.</p>`;
}

/** Email addresses of active, approved admins (for credit alerts). */
export async function adminEmails(admin: any): Promise<string[]> {
  const { data } = await admin
    .from("profiles")
    .select("email")
    .eq("role", "admin")
    .eq("is_active", true)
    .eq("account_status", "approved");
  const emails = ((data as any[]) ?? [])
    .map((r) => String(r.email ?? "").trim())
    .filter(Boolean);
  return [...new Set(emails)];
}
