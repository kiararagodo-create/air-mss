import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const IPROG_URL = "https://sms.iprogtech.com/api/v1/sms_messages";

type Recipient = { name?: string; role?: string; phone?: string; phone_number?: string };
type Result = { name: string; role: string; phone_masked: string; ok: boolean; error?: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Accepts 09XXXXXXXXX, 9XXXXXXXXX, +639XXXXXXXXX, 639XXXXXXXXX -> 09XXXXXXXXX
function normalizePH(input: unknown): string | null {
  let n = String(input ?? "").replace(/[\s\-()]/g, "");
  if (n.startsWith("+63")) n = "0" + n.slice(3);
  else if (n.startsWith("63") && n.length === 12) n = "0" + n.slice(2);
  else if (n.startsWith("9") && n.length === 10) n = "0" + n;
  return /^09\d{9}$/.test(n) ? n : null;
}

const mask = (n: string) => n.slice(0, 4) + "****" + n.slice(-3);

function friendlyError(status: number, raw: string): string {
  const t = raw.toLowerCase();
  if (status === 401 || status === 403 || t.includes("token") || t.includes("unauthor"))
    return "iProg rejected the API token. Check IPROG_SMS_API_TOKEN in Supabase secrets.";
  if (t.includes("credit") || t.includes("balance"))
    return "iProg account has insufficient SMS credits.";
  if (t.includes("phone") || t.includes("number"))
    return "iProg says the phone number is invalid.";
  return `iProg error (${status}): ${raw.slice(0, 120) || "no details"}`;
}

async function sendOne(token: string, phone: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(IPROG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: token, phone_number: phone, message }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }

    const bodyFailed =
      data && (data.error || data.errors || data.status === "error" || data.success === false);

    if (!res.ok || bodyFailed) {
      const raw = data?.message ?? data?.error ?? (typeof data?.errors === "string" ? data.errors : text);
      return { ok: false, error: friendlyError(res.status, String(raw ?? "")) };
    }
    return { ok: true };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return { ok: false, error: aborted ? "iProg timed out. Try again." : "Could not reach iProg." };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const token = Deno.env.get("IPROG_SMS_API_TOKEN");

    if (!token) return json({ error: "iProg SMS is not configured (IPROG_SMS_API_TOKEN missing)." }, 500);

    // Who is calling? Verify the login and check the role on the server.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not signed in." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (profile?.role !== "admin") return json({ error: "Only admins can send SMS alerts." }, 403);

    const body = await req.json();
    const message = String(body?.message ?? "").trim().slice(0, 300);
    const recipients: Recipient[] = Array.isArray(body?.recipients) ? body.recipients : [];

    if (!message) return json({ error: "Message is empty." }, 400);
    if (recipients.length === 0) return json({ error: "No recipients." }, 400);
    if (recipients.length > 50) return json({ error: "Too many recipients (max 50)." }, 400);

    const results: Result[] = [];
    for (const r of recipients) {
      const name = r.name ?? "Unknown";
      const role = r.role ?? "";
      const phone = normalizePH(r.phone ?? r.phone_number);
      if (!phone) {
        results.push({ name, role, phone_masked: "invalid", ok: false, error: "Invalid phone number." });
        continue;
      }
      const out = await sendOne(token, phone, message);
      results.push({ name, role, phone_masked: mask(phone), ...out });
    }

    return json({ results });
  } catch {
    return json({ error: "Unexpected server error." }, 500);
  }
});