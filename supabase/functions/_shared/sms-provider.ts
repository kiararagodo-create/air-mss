// Provider-pluggable SMS layer (server-only; secrets never reach the browser).
//
// One entry point for every function that sends SMS:
//
//   sendSms({ to, message }) -> { ok, provider, providerMessageId, status, raw, error }
//
// The provider is picked by the SMS_PROVIDER secret (default "semaphore").
// Supported adapters, each documented against the provider's official API:
//
//   semaphore  POST https://api.semaphore.co/api/v4/messages
//              form fields: apikey, number, message, sendername?
//              auth: apikey form field (SEMAPHORE_API_KEY, optional
//              SEMAPHORE_SENDER_NAME). Numbers: 09XXXXXXXXX (docs examples).
//              Balance: GET /api/v4/account?apikey=... -> credit_balance.
//              Docs: https://api.semaphore.co/docs
//   philsms    POST https://app.philsms.com/api/v3/sms/send
//              JSON: { recipient, sender_id, type: "plain"|"unicode", message }
//              auth: Authorization: Bearer PHILSMS_API_TOKEN, Accept: application/json.
//              sender_id is REQUIRED by the API; PHILSMS_SENDER_ID secret,
//              default "PhilSMS". Numbers: 639XXXXXXXXX.
//              Balance: GET /api/v3/balance (Bearer) -> remaining units.
//              Docs: https://app.philsms.com/developers/documentation
//   iprog      POST https://sms.iprogtech.com/api/v1/sms_messages
//              JSON: { api_token, phone_number, message }.
//              Secrets: IPROG_API_TOKEN (legacy alias IPROG_SMS_API_TOKEN).
//              Numbers: 639XXXXXXXXX.
//              Balance: GET /api/v1/account/sms_credits?api_token=...
//                       -> data.load_balance.
//              Docs: https://sms.iprogtech.com/api/v1/documentation
//   iprog      POST https://sms.iprogtech.com/api/v1/sms_messages
//              JSON: { api_token, phone_number, message }.
//              Secrets: IPROG_API_TOKEN (legacy alias IPROG_SMS_API_TOKEN).
//              Numbers: 639XXXXXXXXX (normalized to 09XXXXXXXXX).
//              Balance: GET /api/v1/account/sms_credits?api_token=...
//                       -> data.load_balance.
//              Docs: https://sms.iprogtech.com/api/v1/documentation
//
// DRY_RUN=true: no HTTP call is made; the attempt is logged and reported as
// a successful dry run (ok:true, status:"dry_run") so flows can be tested
// end-to-end without spending credits.

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

/**
 * Sanitize a secret pasted into the Supabase dashboard: trims whitespace and
 * strips surrounding quotes / angle brackets people often copy accidentally
 * (e.g. `"my-key"` or `<my-key>`). Interior content is left untouched.
 * Returns "" for null/empty so callers can reject it with a clear error.
 */
export function sanitizeSecret(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  for (;;) {
    const before = s;
    s = s.trim().replace(/^["'`<>]+/, "").replace(/["'`<>]+$/, "").trim();
    if (s === before) break;
  }
  return s;
}

/** Safe diagnostics fragment for logs: first 4 + last 2 chars of a key with
 *  the middle masked, plus its length. Secrets are NEVER logged in full. */
export function maskedKey(key: string): string {
  if (!key) return "empty (len 0)";
  if (key.length <= 6) return `len ${key.length}`;
  return `${key.slice(0, 4)}•••${key.slice(-2)} (len ${key.length})`;
}

export function getSmsConfig(): SmsConfig {
  const rawProvider = (Deno.env.get("SMS_PROVIDER") ?? "semaphore").trim().toLowerCase();
  const provider = (["semaphore", "philsms", "iprog", "movider"].includes(rawProvider)
    ? rawProvider
    : "semaphore") as SmsProviderName;
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
    iprog: {
      token: sanitizeSecret(Deno.env.get("IPROG_API_TOKEN") ?? Deno.env.get("IPROG_SMS_API_TOKEN")),
    },
    }
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
  // Reduce to the 10-digit national number (9XXXXXXXXX) first.
  let national: string | null = null;
  if (d.startsWith("63") && d.length === 12) national = d.slice(2);
  else if (d.startsWith("9") && d.length === 10) national = d;
  else if (d.startsWith("09") && d.length === 11) national = d.slice(1);
  else if (d.length >= 10) national = d.replace(/^0+/, "").replace(/^63/, "");
  if (!national || national.length !== 10 || !national.startsWith("9")) return null;
  // semaphore docs use 09XXXXXXXXX; iprog uses 09XXXXXXXXX too;
  // philsms use 639XXXXXXXXX (E.164 without plus sign).
  if (provider === "iprog") return `63${national}`;
  return provider === "semaphore" ? `0${national}` : `63${national}`;
}

function fail(provider: SmsProviderName, error: string, raw: unknown = null): SmsResult {
  return { ok: false, provider, providerMessageId: null, status: "failed", raw, error };
}

async function sendSemaphore(cfg: SmsConfig, to: string, message: string): Promise<SmsResult> {
  const number = normalizeForProvider(to, "semaphore");
  if (!number) return fail("semaphore", `Invalid PH number: ${to}`);
  const body = new URLSearchParams({
    apikey: cfg.semaphore.apiKey,
    number,
    message,
  });
  if (cfg.semaphore.senderName) body.set("sendername", cfg.semaphore.senderName);
  let res: Response;
  try {
    res = await fetch("https://api.semaphore.co/api/v4/messages", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    return fail("semaphore", `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* keep raw text below */ }
  const first = Array.isArray(data) ? data[0] : data;
  if (!res.ok) return fail("semaphore", `HTTP ${res.status}: ${text}`.slice(0, 500), data ?? text);
  if (first?.status && String(first.status).toLowerCase() === "failed") {
    return fail("semaphore", first?.message ?? "Semaphore reported status=Failed", data);
  }
  return {
    ok: true, provider: "semaphore",
    providerMessageId: first?.message_id != null ? String(first.message_id) : null,
    status: String(first?.status ?? "Queued"), raw: data ?? text, error: null,
  };
}

async function sendPhilsms(cfg: SmsConfig, to: string, message: string): Promise<SmsResult> {
  const recipient = normalizeForProvider(to, "philsms");
  if (!recipient) return fail("philsms", `Invalid PH number: ${to}`);
  const isUnicode = /[^\x00-\x7F]/.test(message);
  let res: Response;
  try {
    res = await fetch("https://app.philsms.com/api/v3/sms/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.philsms.token}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient,
        sender_id: cfg.philsms.senderId.slice(0, 11),
        type: isUnicode ? "unicode" : "plain",
        message,
      }),
    });
  } catch (e) {
    return fail("philsms", `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* keep raw text below */ }
  if (!res.ok || data?.status === "error") {
    return fail("philsms", data?.message ?? `HTTP ${res.status}: ${text}`.slice(0, 500), data ?? text);
  }
  const id = data?.data?.uid ?? data?.data?.id ?? data?.data?.message_id ?? null;
  return {
    ok: true, provider: "philsms",
    providerMessageId: id != null ? String(id) : null,
    status: "submitted", raw: data ?? text, error: null,
  };
}

async function sendIprog(cfg: SmsConfig, to: string, message: string): Promise<SmsResult> {
  const phone = normalizeForProvider(to, "iprog");
  if (!phone) return fail("iprog", `Invalid PH number: ${to}`);
  let res: Response;
  try {
    res = await fetch("https://sms.iprogtech.com/api/v1/sms_messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: cfg.iprog.token, phone_number: phone, message }),
    });
  } catch (e) {
    return fail("iprog", `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* keep raw text below */ }
  if (!res.ok) return fail("iprog", `HTTP ${res.status}: ${text}`.slice(0, 500), data ?? text);
  if (data?.status !== "submitted") return fail("iprog", `${data?.error ?? data?.message ?? "Unknown iProg error"}`.slice(0, 500));
  return {
    ok: true, provider: "iprog",
    providerMessageId: data?.message_id != null ? String(data.message_id) : null,
    status: "submitted", raw: data ?? text, error: null,
  };
}

/** Numbers contained in a Movider sent/failed list item (string or object). */
function moviderListNumbers(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((item: any) =>
    normalizeForProvider(
      typeof item === "string" ? item : item?.number ?? item?.to ?? item?.phone ?? item?.recipient ?? "",
      "movider"
    ) ?? String(item?.number ?? item?.to ?? item ?? "")
  ).filter(Boolean);
}

function moviderErrorText(data: any): string | null {
  const err = data?.error;
  if (!err) return null;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    return err.name ?? err.message ?? err.code ?? JSON.stringify(err).slice(0, 300);
  }
  return String(err);
}

async function sendMovider(cfg: SmsConfig, to: string, message: string): Promise<SmsResult> {
  const number = normalizeForProvider(to, "movider");
  if (!number) return fail("movider", `Invalid PH number: ${to}`);
  const body = new URLSearchParams({
    api_key: cfg.movider.apiKey,
    api_secret: cfg.movider.apiSecret,
    to: number,
    text: message,
    from: cfg.movider.senderName,
  });
  let res: Response;
  try {
    res = await fetch("https://api.movider.co/v1/sms", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (e) {
    return fail("movider", `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* keep raw text below */ }
  const errText = moviderErrorText(data);
  if (!res.ok || errText) {
    const readable = mapMoviderError(errText, errText ?? `HTTP ${res.status}: ${text}`.slice(0, 500));
    const hint = /auth/i.test(readable) || res.status === 401 ? ` — ${AUTH_HINT}` : "";
    // Keep the original Movider code visible for diagnosis: "CODE: readable".
    const shown = errText && !readable.includes(errText) ? `${errText}: ${readable}` : readable;
    return fail("movider", `${shown}${hint}`, data ?? text);
  }
  // Success = the number appears in the sent list; failed = in the failed list.
  const payload = data?.data && typeof data.data === "object" ? data.data : data;
  const sentNumbers = moviderListNumbers(
    payload?.phone_number_list ?? payload?.sended_number_list ?? payload?.sent_list ?? payload?.sent ?? payload?.data?.phone_number_list
  );
  const failedNumbers = moviderListNumbers(
    payload?.bad_phone_number_list ?? payload?.failed_number_list ?? payload?.failed_list ?? payload?.failed ?? payload?.data?.bad_phone_number_list
  );
  const id = payload?.message_id ?? payload?.id ?? null;
  if (failedNumbers.includes(number) || (failedNumbers.length > 0 && !sentNumbers.includes(number))) {
    return fail("movider", `Number appears in the failed list`, data ?? text);
  }
  if (sentNumbers.length > 0 && !sentNumbers.includes(number)) {
    return fail("movider", `Number not in the sent list`, data ?? text);
  }
  // No lists returned at all but no error either: treat empty-sent + empty-failed
  // on a 2xx as accepted only when a total/message id is present.
  if (sentNumbers.length === 0 && failedNumbers.length === 0 && payload?.total_sms == null && id == null) {
    return fail("movider", `Unexpected Movider response`, data ?? text);
  }
  return {
    ok: true, provider: "movider",
    providerMessageId: id != null ? String(id) : null,
    status: "submitted", raw: data ?? text, error: null,
  };
}

/** The single send entry point. `to` may be in any PH format; it is
 *  normalized to the selected provider's required format internally. */
export async function sendSms(opts: { to: string; message: string }): Promise<SmsResult> {
  const cfg = getSmsConfig();
  if (cfg.dryRun) {
    return {
      ok: true, provider: cfg.provider, providerMessageId: null, status: "dry_run",
      raw: { dry_run: true, provider: cfg.provider, to: opts.to }, error: null,
    };
  }
  if (cfg.missing.length) {
    const msg = `SMS_PROVIDER=${cfg.provider} missing secret(s): ${cfg.missing.join(", ")}`;
    return fail(cfg.provider, msg);
  }
  switch (cfg.provider) {
    case "philsms": return sendPhilsms(cfg, opts.to, opts.message);
    case "iprog": return sendIprog(cfg, opts.to, opts.message);
    default: return sendSemaphore(cfg, opts.to, opts.message);
  }
}

export const AUTH_HINT =
  "Check the provider API key/secret secrets (full, unmasked values), then redeploy: supabase functions deploy send-sms";

/** Map iProg error codes/names to operator-readable messages. Unknown codes pass through unchanged. */
export function mapIprogError(errName: string | null | undefined, fallback?: string): string {
  const code = String(errName ?? "").toUpperCase();
  if (!code) return fallback ?? "iProg request failed";
  if (["ERR_AUTHENTICATION_FAILED", "ERR_INVALID_APIKEY", "ERR_INVALID_APISECRET", "ERR_INVALID_API_KEY_SECRET", "ERR_OFTEN_WRONG_APIKEY"].includes(code)) {
    return "iProg rejected the API key or secret. Generate a new key and copy it with the Copy button.";
  }
  if (["ERR_INSUFFICIENT_BALANCE", "ERR_BALANCE_EXPIRED"].includes(code)) {
    return "iProg balance is insufficient or expired. Top up your iProg account.";
  }
  if (code === "ERR_SENDER" || code === "ERR_SENDER_FAILURE" || code === "ERR_SENDER_TH_FAILURE") {
    return "iProg rejected the sender configuration.";
  }
  if (["ERR_INVALID_TO", "ERR_INVALID_RECEIVER_NUMBER", "ERR_INVALID_TEXT", "ERR_INVALID_SENDMSG_FORM"].includes(code)) {
    return "iProg rejected the phone number or message. Check the number format (09XXXXXXXXX) and that the message is not empty.";
  }
  if (code === "ERR_IP_WHITELIST_NOT_ALLOWED" || code === "ERR_IP_WHITELIST_FAILURE") {
    return "iProg unreachable. Check your network connectivity.";
  }
  return fallback ?? code;
}

/** Credit balance for the selected provider, or null when the provider does
 *  not expose one / the call fails (callers treat null as "unknown", never
 *  as 0, so an unsupported balance endpoint cannot block sending).
 * `authError` is set when the balance call itself proves the credentials are
 * wrong (HTTP 401 / ERR_AUTHENTICATION_FAILED), so the UI can tell the
 * Administrator to fix the secrets instead of showing a raw error code. */
export async function getSmsCredits(): Promise<{ credits: number | null; provider: SmsProviderName; providerLabel: string; authError: string | null }> {
  const cfg = getSmsConfig();
  const base = { credits: null, provider: cfg.provider, providerLabel: cfg.providerLabel, authError: null as string | null };
  if (cfg.dryRun) return base;
  if (cfg.missing.length) return base;
  try {
    // helper: a 401 (or an ERR_AUTHENTICATION_FAILED body) proves bad credentials.
    const authCheck = async (res: Response): Promise<string | null> => {
      if (res.status === 401) return `HTTP 401 authentication failed`;
      if (res.ok) return null;
      const bodyText = await res.text().catch(() => "");
      const parsed: any = (() => { try { return JSON.parse(bodyText); } catch { return null; } })();
      const err = mapIprogError(parsed?.error ?? parsed?.message ?? null) ?? parsed?.message ?? bodyText;
      return /auth/i.test(String(err ?? "")) ? String(err).slice(0, 200) : null;
    };

    if (cfg.provider === "semaphore") {
      const res = await fetch(`https://api.semaphore.co/api/v4/account?apikey=${encodeURIComponent(cfg.semaphore.apiKey)}`);
      const authError = await authCheck(res);
      if (!res.ok) return { ...base, authError };
      const data: any = await res.json();
      const credits = Number(data?.credit_balance);
      return { ...base, credits: Number.isFinite(credits) ? credits : null };
    }
    if (cfg.provider === "philsms") {
      const res = await fetch("https://app.philsms.com/api/v3/balance", {
        headers: { "Authorization": `Bearer ${cfg.philsms.token}`, "Accept": "application/json" },
      });
      const authError = await authCheck(res);
      if (!res.ok) return { ...base, authError };
      const data: any = await res.json();
      return { ...base, credits: findCredits(data) };
    }
    const res = await fetch(`https://sms.iprogtech.com/api/v1/account/sms_credits?api_token=${encodeURIComponent(cfg.iprog.token)}`);
    const authError = await authCheck(res);
    if (!res.ok) return { ...base, authError };
    const data: any = await res.json();
    const credits = Number(data?.data?.load_balance ?? data?.credits);
    return { ...base, credits: Number.isFinite(credits) ? credits : null };
  } catch {
    return base;
  }
}

/** PhilSMS /balance returns "sms unit with all details" without a documented
 *  field name; search typical balance-like numeric keys recursively. */
function findCredits(value: unknown, depth = 0): number | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === "number" || typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["credit_balance", "balance", "remaining", "remaining_credits", "credits", "sms_unit", "units", "total_remaining", "load_balance"]) {
      if (key in obj) {
        const found = findCredits(obj[key], depth + 1);
        if (found !== null) return found;
      }
    }
    for (const v of Object.values(obj)) {
      const found = findCredits(v, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}
