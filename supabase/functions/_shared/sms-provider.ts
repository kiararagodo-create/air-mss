// Provider-pluggable SMS layer (server-only; secrets never reach the browser).
// A.I.R. uses iProgSMS for automatic and manual SMS.

export type SmsProviderName = "semaphore" | "philsms" | "iprog";

export interface SmsResult {
  ok: boolean;
  provider: SmsProviderName;
  providerMessageId: string | null;
  status: string;
  raw: unknown;
  error: string | null;
}

export interface SmsConfig {
  provider: SmsProviderName;
  providerLabel: string;
  dryRun: boolean;
  /** Missing-credential names for the selected provider (empty = ready). */
  missing: string[];
  semaphore: { apiKey: string; senderName: string };
  philsms: { token: string; senderId: string };
  iprog: { token: string };
}

const LABELS: Record<SmsProviderName, string> = {
  semaphore: "Semaphore",
  philsms: "PhilSMS",
  iprog: "IPROG",
};

export function sanitizeSecret(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  for (;;) {
    const before = s;
    s = s.trim().replace(/^["'`<>]+/, "").replace(/["'`<>]+$/, "").trim();
    if (s === before) break;
  }
  return s;
}

export function maskedKey(key: string): string {
  if (!key) return "empty (len 0)";
  if (key.length <= 6) return `len ${key.length}`;
  return `${key.slice(0, 4)}***${key.slice(-2)} (len ${key.length})`;
}

export function getSmsConfig(): SmsConfig {
  // iProgSMS is the only supported provider for this project.
  const provider: SmsProviderName = "iprog";
  const iprogToken = sanitizeSecret(Deno.env.get("IPROG_SMS_API_TOKEN") ?? Deno.env.get("IPROG_API_TOKEN"));
  const cfg: SmsConfig = {
    provider,
    providerLabel: LABELS[provider],
    dryRun: (Deno.env.get("DRY_RUN") ?? "").trim().toLowerCase() === "true",
    missing: [],
    semaphore: {
      apiKey: sanitizeSecret(Deno.env.get("SEMAPHORE_API_KEY")),
      senderName: sanitizeSecret(Deno.env.get("SEMAPHORE_SENDER_NAME")),
    },
    philsms: {
      token: sanitizeSecret(Deno.env.get("PHILSMS_API_TOKEN")),
      senderId: sanitizeSecret(Deno.env.get("PHILSMS_SENDER_ID")) || "PhilSMS",
    },
    iprog: { token: iprogToken },
  };
  if (!cfg.iprog.token) cfg.missing.push("IPROG_SMS_API_TOKEN");
  return cfg;
}

export function smsProviderLabel(provider: SmsProviderName): string {
  return LABELS[provider] ?? provider;
}

/** Normalize a PH number to the format the selected provider expects. */
export function normalizeForProvider(raw: string | null | undefined, provider: SmsProviderName): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0063")) d = d.slice(4);
  let national: string | null = null;
  if (d.startsWith("63") && d.length === 12) national = d.slice(2);
  else if (d.startsWith("9") && d.length === 10) national = d;
  else if (d.startsWith("09") && d.length === 11) national = d.slice(1);
  else if (d.length >= 10) national = d.replace(/^0+/, "").replace(/^63/, "");
  if (!national || national.length !== 10 || !national.startsWith("9")) return null;
  // iProgSMS expects 639XXXXXXXXX (without +). Semaphore commonly uses 09XXXXXXXXX.
  if (provider === "iprog" || provider === "philsms") return `63${national}`;
  return `0${national}`;
}

function fail(provider: SmsProviderName, error: string, raw: unknown = null): SmsResult {
  return { ok: false, provider, providerMessageId: null, status: "failed", raw, error };
}

async function sendIprog(cfg: SmsConfig, to: string, message: string): Promise<SmsResult> {
  const phone = normalizeForProvider(to, "iprog");
  if (!phone) return fail("iprog", `Invalid PH number: ${to}`);
  console.log(`sms-provider iprog: sending to=63***${phone.slice(-4)} token=${maskedKey(cfg.iprog.token)} dry_run=${cfg.dryRun} msg_len=${message.length}`);
  let res: Response;
  try {
    res = await fetch("https://sms.iprogtech.com/api/v1/sms_messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: cfg.iprog.token, phone_number: phone, message }),
    });
  } catch (e) {
    const err = `network error: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`iProg SMS failed: ${err}`);
    return fail("iprog", err);
  }
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* keep raw text below */ }
  console.log(`sms-provider iprog: http_status=${res.status} json_status=${data?.status ?? "null"} message_id=${data?.message_id ?? "null"} message=${String(data?.message ?? "").slice(0, 200)}`);
  if (!res.ok) {
    const err = `HTTP ${res.status}: ${String(data?.message ?? data?.error ?? text).slice(0, 300)}`;
    console.error(`iProg SMS failed: ${err}`);
    return fail("iprog", err, data ?? text);
  }
  const okStatus = data?.status === 200 || data?.status === "200" || String(data?.status ?? "").toLowerCase() === "success";
  if (!okStatus || data?.error || data?.errors) {
    const msg = String(data?.message ?? data?.error ?? data?.errors ?? "Unknown iProg error").slice(0, 500);
    console.error(`iProg SMS failed: status ${data?.status ?? res.status} ${msg}`);
    return fail("iprog", msg, data ?? text);
  }
  if (data?.message_id == null) {
    const msg = `${data?.message ?? "iProg response missing message_id"}`.slice(0, 500);
    console.error(`iProg SMS failed: ${msg}`);
    return fail("iprog", msg, data ?? text);
  }
  return {
    ok: true, provider: "iprog",
    providerMessageId: String(data.message_id),
    status: "submitted", raw: data ?? text, error: null,
  };
}

export async function sendSms(opts: { to: string; message: string }, ignoreDryRun = false): Promise<SmsResult> {
  const cfg = getSmsConfig();
  if (cfg.dryRun && !ignoreDryRun) {
    return {
      ok: true, provider: cfg.provider, providerMessageId: null, status: "dry_run",
      raw: { dry_run: true, provider: cfg.provider, to: opts.to }, error: null,
    };
  }
  if (cfg.missing.length) {
    const msg = `SMS provider ${cfg.providerLabel} missing secret(s): ${cfg.missing.join(", ")}`;
    console.error(msg);
    return fail(cfg.provider, msg);
  }
  // Reuse existing iProgSMS code path.
  return sendIprog(cfg, opts.to, opts.message);
}

export const AUTH_HINT =
  "Set IPROG_SMS_API_TOKEN (full unmasked value) in Supabase Edge Function secrets, then redeploy: supabase functions deploy air-alerts send-sms";

export function mapIprogError(errName: string | null | undefined, fallback?: string): string {
  const code = String(errName ?? "").toUpperCase();
  if (!code) return fallback ?? "iProg request failed";
  if (["ERR_AUTHENTICATION_FAILED", "ERR_INVALID_APIKEY", "ERR_INVALID_APISECRET", "ERR_INVALID_API_KEY_SECRET", "ERR_OFTEN_WRONG_APIKEY"].includes(code)) {
    return "iProg rejected the API token. Check IPROG_SMS_API_TOKEN (full unmasked value) and redeploy.";
  }
  if (["ERR_INSUFFICIENT_BALANCE", "ERR_BALANCE_EXPIRED"].includes(code)) {
    return "iProg balance is insufficient or expired. Top up your iProg account.";
  }
  if (code === "ERR_SENDER" || code === "ERR_SENDER_FAILURE" || code === "ERR_SENDER_TH_FAILURE") {
    return "iProg rejected the sender configuration.";
  }
  if (["ERR_INVALID_TO", "ERR_INVALID_RECEIVER_NUMBER", "ERR_INVALID_TEXT", "ERR_INVALID_SENDMSG_FORM"].includes(code)) {
    return "iProg rejected the phone number or message. Check number format (09XXXXXXXXX / 639XXXXXXXXX) and message.";
  }
  if (code === "ERR_IP_WHITELIST_NOT_ALLOWED" || code === "ERR_IP_WHITELIST_FAILURE") {
    return "iProg request blocked by IP/network policy.";
  }
  return fallback ?? code;
}

export async function getSmsCredits(ignoreDryRun = false): Promise<{ credits: number | null; tokenValid: boolean; provider: SmsProviderName; providerLabel: string; authError: string | null }> {
  const cfg = getSmsConfig();
  const base = { credits: null as number | null, tokenValid: false, provider: cfg.provider, providerLabel: cfg.providerLabel, authError: null as string | null };
  if (cfg.dryRun && !ignoreDryRun) return base;
  if (cfg.missing.length) return { ...base, authError: `Missing secret(s): ${cfg.missing.join(", ")}` };
  try {
    const res = await fetch(`https://sms.iprogtech.com/api/v1/account/sms_credits?api_token=${encodeURIComponent(cfg.iprog.token)}`);
    const bodyText = await res.text().catch(() => "");
    let data: any = null;
    try { data = JSON.parse(bodyText); } catch { data = null; }
    console.log(`sms-provider iprog credits: http_status=${res.status} json_status=${data?.status ?? "null"} message=${String(data?.message ?? "").slice(0, 120)}`);
    if (!res.ok) return { ...base, authError: `HTTP ${res.status}` };
    const msg = String(data?.message ?? "");
    if (/invalid token/i.test(msg) || (data?.status === 500 && /invalid/i.test(msg))) {
      return { ...base, authError: msg || "Invalid Token" };
    }
    const credits = Number(data?.data?.load_balance ?? data?.credits);
    const tokenValid = data?.status === "success" || data?.status === 200 || res.ok;
    return { ...base, tokenValid, credits: Number.isFinite(credits) ? credits : null };
  } catch (e) {
    return { ...base, authError: e instanceof Error ? e.message : String(e) };
  }
}
