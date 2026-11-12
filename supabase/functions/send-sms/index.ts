/**
 * send-sms — manual SMS sending (B). verify_jwt: ON (default).
 *
 * This is the ONLY path by which a browser-triggered SMS is sent. Provider
 * credentials live in Edge Function secrets and never reach the browser.
 * No SMS is sent automatically from page load or any other browser code.
 *
 * Sending is provider-pluggable via supabase/functions/_shared/sms-provider.ts:
 *   SMS_PROVIDER=semaphore (default) -> SEMAPHORE_API_KEY [+ SEMAPHORE_SENDER_NAME]
 *   SMS_PROVIDER=philsms             -> PHILSMS_API_TOKEN [+ PHILSMS_SENDER_ID]
 *   SMS_PROVIDER=iprog               -> IPROG_API_TOKEN (alias IPROG_SMS_API_TOKEN)
 *   DRY_RUN=true                     -> log + report success, no provider call.
 *
 * Body variants:
 *   { action: "credits" }
 *     -> { credits, provider, providerLabel } (credits null = unknown; sending
 *        is never blocked on an unknown balance, only on a known 0).
 *   { action: "send", notification_id?, live?, recipient_ids: [uuid],
 *     message, send_anyway? }
 *     -> caller must be admin or security. Recipient names/numbers are
 *        re-fetched server-side from profiles (client numbers are ignored).
 *        Cooldown: an sms_logs row for the same notification in the last
 *        30 minutes blocks the send unless send_anyway is true AND the
 *        caller is admin -> returns { cooldown: true, last_sent_at }.
 *        Credits: known 0 blocks; below the recipient count only warns
 *        (credits_warning, shown to the Administrator in-app).
 *        Per recipient: normalize PH number to the provider's format,
 *        create a 24h action_token recipient row (when tied to an alert),
 *        append "Take action: <APP_PUBLIC_URL>/action/<token>", call the
 *        provider adapter, and insert one sms_logs row with provider name,
 *        provider_message_id, provider_status and the raw provider response
 *        (submitted / failed / skipped_no_number). One failure never stops
 *        the others. A notification_actions row action='sms_sent'
 *        ("SMS sent by [sender] to N personnel") is recorded on the
 *        alert timeline.
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import { maskPhone, newActionToken } from "../_shared/air_alerts.ts";
import { callerProfile, resolveNotification } from "../_shared/ensure_notification.ts";
import { getSmsConfig, getSmsCredits, normalizeForProvider, sendSms } from "../_shared/sms-provider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const SMS_ROLES = ["admin", "security"];
const COOLDOWN_MS = 30 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase secrets" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const profile = await callerProfile(admin, req);
  if (!profile) return json({ ok: false, error: "Not signed in or account not approved", results: [] }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const cfg = getSmsConfig();
  // Manual sends always hit the real provider; DRY_RUN must not affect this function.
  cfg.dryRun = false;
  const appUrl = (Deno.env.get("APP_PUBLIC_URL") ?? "https://air.adamson.edu.ph").replace(/\/$/, "");

  if (body?.action === "credits") {
    const { credits, authError } = await getSmsCredits(true);
    return json({ credits, auth_error: authError, provider: cfg.provider, providerLabel: cfg.providerLabel, dry_run: false });
  }

  // Admin-only connection test: hits ONLY the provider balance endpoint.
  // No SMS is sent, no sms_logs row is written.
  if (body?.action === "test" || body?.action === "check") {
    if (profile.role !== "admin") {
      return json({ tokenValid: false, creditsLeft: null, error: "Only an Administrator can test the SMS connection" }, 403);
    }
    if (cfg.missing.length) {
      return json({ tokenValid: false, creditsLeft: null, error: `SMS provider ${cfg.providerLabel} missing secret(s): ${cfg.missing.join(", ")}` });
    }
    const { credits, tokenValid, authError } = await getSmsCredits(true);
    console.log(`send-sms check-connection: tokenValid=${tokenValid} creditsLeft=${credits}`);
    if (authError) {
      return json({ tokenValid: false, creditsLeft: credits, error: authError });
    }
    return json({ tokenValid, creditsLeft: credits, error: null });
  }

  if (body?.action !== "send") return json({ error: "action must be 'credits' or 'send'" }, 400);
  if (!SMS_ROLES.includes(profile.role)) {
    return json({ ok: false, error: "Only Administrator and Security can send SMS", results: [] }, 403);
  }
  if (cfg.missing.length && !cfg.dryRun) {
    return json({ ok: false, error: `SMS provider ${cfg.providerLabel} missing secret(s): ${cfg.missing.join(", ")}`, provider: cfg.provider, results: [] }, 500);
  }

  const recipientIds: string[] = Array.isArray(body.recipient_ids) ? body.recipient_ids : [];
  const message: string = String(body.message ?? "").trim();
  if (recipientIds.length === 0) return json({ ok: false, error: "Select at least one recipient", results: [] }, 400);
  if (!message) return json({ ok: false, error: "Message is empty", results: [] }, 400);
  console.log(`send-sms request: secret=IPROG_SMS_API_TOKEN dry_run=${cfg.dryRun} recipients=${recipientIds.length}`);

  // Recipients are re-fetched server-side; client-sent numbers are ignored.
  const { data: people } = await admin.from("profiles")
    .select("id, name, role, contact_number")
    .in("id", recipientIds)
    .eq("is_active", true);
  const recipients = ((people as any[]) ?? []).filter((p) => p.role === "admin" || p.account_status === "approved" || p.role === "admin");

  // Alert context (optional for custom SMS): ensure the row exists first.
  let notification: any = null;
  if (body.notification_id || body.live) {
    const resolved = await resolveNotification(admin, body.notification_id ?? null, body.live ?? null);
    notification = resolved?.notification ?? null;
  }

  // Cooldown (per alert): an SMS in the last 30 minutes blocks re-send,
  // unless an Administrator confirms "Send anyway".
  if (notification) {
    const cutoff = new Date(Date.now() - COOLDOWN_MS).toISOString();
    const { data: recent } = await admin.from("sms_logs")
      .select("sent_at").eq("notification_id", notification.id)
      .gte("sent_at", cutoff).order("sent_at", { ascending: false }).limit(1).maybeSingle();
    if (recent && !(body.send_anyway === true && profile.role === "admin")) {
      const { credits } = await getSmsCredits();
      return json({ ok: false, cooldown: true, last_sent_at: recent.sent_at, credits, provider: cfg.provider, providerLabel: cfg.providerLabel, results: [] });
    }
  }

  const { credits, authError } = await getSmsCredits(true);
  // Credentials proven wrong by the balance call: stop before burning a
  // per-recipient attempt on every recipient (and log none as "failed"
  // without the real reason).
  if (authError) {
    return json({
      ok: false,
      error: `${cfg.providerLabel} authentication failed (${authError}). Check the provider key/secret secrets (full, unmasked values), then redeploy: supabase functions deploy send-sms`,
      credits, auth_error: authError, provider: cfg.provider, providerLabel: cfg.providerLabel, results: [],
    });
  }
  if (credits !== null && credits === 0) {
    return json({ ok: false, error: `${cfg.providerLabel} credits are 0. Top up your ${cfg.providerLabel} account, then try again.`, credits, provider: cfg.provider, providerLabel: cfg.providerLabel, results: [] });
  }
  const creditsWarning = credits !== null && credits < recipients.length
    ? `${cfg.providerLabel} credits (${credits}) are below the number of messages (${recipients.length}).`
    : null;

  const results: any[] = [];
  for (const p of recipients) {
    const phone = normalizeForProvider(p.contact_number, cfg.provider);
    if (!phone) {
      await admin.from("sms_logs").insert({
        notification_id: notification?.id ?? null, personnel_id: p.id,
        recipient_name: p.name ?? "", recipient_role: p.role,
        phone: p.contact_number ?? null, message,
        status: "skipped_no_number", provider_response: "No contact number on file",
        provider: cfg.provider, provider_message_id: null, provider_status: "skipped_no_number",
      });
      results.push({ personnel_id: p.id, name: p.name, role: p.role, phone_masked: maskPhone(p.contact_number), status: "skipped_no_number", provider_response: "No contact number on file", error: null });
      continue;
    }

    let finalMessage = message;
    if (notification) {
      const includeLink = (Deno.env.get("SMS_INCLUDE_ACTION_LINK") ?? "").trim().toLowerCase() === "true";
      if (includeLink) {
        const token = newActionToken();
        await admin.from("notification_recipients").upsert({
          notification_id: notification.id, personnel_id: p.id,
          personnel_name: p.name ?? "", personnel_role: p.role, phone,
          action_token: token,
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        }, { onConflict: "notification_id,personnel_id" });
        const link = `${appUrl}/action/${token}`;
        finalMessage = message.includes("{action_link}")
          ? message.replaceAll("{action_link}", link)
          : message.includes("/action/")
          ? message
          : `${message} ${link}`;
      }
    }
    finalMessage = finalMessage.slice(0, 160);

    const res = await sendSms({ to: phone, message: finalMessage }, true);
    if (!res.ok) {
      console.error(`iProg SMS failed: ${res.status} ${res.error ?? ""}`.slice(0, 300));
    }
    console.log(`send-sms recipient: ${maskPhone(phone)} ${res.ok ? "ok" : "failed"} ${res.error ?? ""}`.slice(0, 300));
    const rawText = typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw ?? {});
    await admin.from("sms_logs").insert({
      notification_id: notification?.id ?? null, personnel_id: p.id,
      recipient_name: p.name ?? "", recipient_role: p.role, phone,
      message: finalMessage,
      status: res.ok ? "submitted" : "failed",
      provider_response: res.error ?? rawText,
      provider: res.provider, provider_message_id: res.providerMessageId, provider_status: res.status,
    });
    results.push({
      personnel_id: p.id, name: p.name, role: p.role, phone_masked: maskPhone(phone),
      status: res.ok ? "submitted" : "failed",
      provider_response: res.error ?? rawText, error: res.ok ? null : res.error,
    });
  }

  // Timeline: "SMS sent by [sender] to N personnel".
  if (notification) {
    await admin.from("notification_actions").insert({
      notification_id: notification.id, personnel_id: profile.id,
      personnel_name: profile.name, personnel_role: profile.role,
      action: "sms_sent",
      note: `SMS sent by ${profile.name} to ${recipients.length} personnel via ${cfg.providerLabel}`,
      taken_at: new Date().toISOString(),
    });
  }

  return json({ ok: true, credits, credits_warning: creditsWarning, provider: cfg.provider, providerLabel: cfg.providerLabel, results });
});
