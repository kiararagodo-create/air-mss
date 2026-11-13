/**
 * record-action — authenticated in-app personnel actions on alerts.
 * SMS notifications triggered by actions are automatic (system) sends and marked as auto.
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import {
  ACTION_ROLES, actionPatch, callerProfile, notifyPersonnel, resolveNotification,
} from "../_shared/ensure_notification.ts";
import { sendSms } from "../_shared/sms-provider.ts";
import { buildAcknowledgedMessage, buildResolvedMessage, manilaTime } from "../_shared/sms_templates.ts";
import { getSmsRecipients } from "../_shared/sms_recipients.ts";
import { getSmsConfig } from "../_shared/sms-provider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function insertSmsLog(admin: any, row: any) {
  const payload = { ...row, send_mode: "auto", is_auto: true };
  const { error } = await admin.from("sms_logs").insert(payload);
  if (error) {
    const fallback = { ...payload };
    delete fallback.send_mode;
    delete fallback.is_auto;
    await admin.from("sms_logs").insert(fallback);
  }
}

const ACTIONS = ["acknowledge", "on_my_way", "resolved", "false_alarm", "repaired"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase secrets" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const profile = await callerProfile(admin, req);
  if (!profile) return json({ error: "Not signed in or account not approved" }, 401);
  if (!ACTION_ROLES.includes(profile.role)) return json({ error: "Your role cannot take alert actions" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { notification_id, live, action } = body ?? {};
  const note = body?.note ? String(body.note).slice(0, 1000) : null;
  if (!ACTIONS.includes(action)) return json({ error: `action must be one of ${ACTIONS.join(", ")}` }, 400);
  if (!notification_id && !live) return json({ error: "notification_id or live alert required" }, 400);

  const resolved = await resolveNotification(admin, notification_id ?? null, live ?? null);
  if (!resolved) return json({ error: "Alert not found and could not be created" }, 404);

  const taken_at = new Date().toISOString();
  const { data: actionRow, error: actErr } = await admin.from("notification_actions").insert({
    notification_id: resolved.id,
    personnel_id: profile.id,
    personnel_name: profile.name,
    personnel_role: profile.role,
    action,
    note,
    taken_at,
  }).select("*").single();
  if (actErr) return json({ error: actErr.message }, 500);

  const patch = actionPatch(action, note, profile, taken_at);
  const { data: updated, error: updErr } = await admin.from("air_notifications")
    .update(patch).eq("id", resolved.id).select("*").single();
  if (updErr) return json({ error: updErr.message }, 500);

  const n = updated;
  const verb = { acknowledge: "acknowledged", on_my_way: "is on the way to", resolved: "resolved", false_alarm: "marked as false alarm", repaired: "marked as repaired" } as any;
  await notifyPersonnel(
    admin,
    profile.id,
    `${profile.name} ${verb[action]} ${n.room_name}`,
    `${n.room_name} - ${String(n.sensor_type).toUpperCase()} ${n.level_label}${note ? ": " + note : ""}`,
  );

  // SMS (automatic/system): dedupe rapid duplicate action submissions.
  const since = new Date(Date.parse(taken_at) - 60_000).toISOString();
  const { count: earlierDupes } = await admin.from("notification_actions")
    .select("id", { count: "exact", head: true })
    .eq("notification_id", resolved.id)
    .eq("personnel_id", profile.id)
    .eq("action", action)
    .gte("taken_at", since)
    .lt("id", actionRow.id);
  const isDuplicate = (earlierDupes ?? 0) > 0;

  if (!isDuplicate) {
    const cfg = getSmsConfig();
    const recipients = await getSmsRecipients(admin);
    const t = manilaTime();
    const roomLabel = n.room_name ?? n.device_id;
    const smsText = (action === "acknowledge" || action === "on_my_way")
      ? buildAcknowledgedMessage(profile.name, profile.role, roomLabel, t)
      : buildResolvedMessage(profile.name, profile.role, roomLabel, note, t);
    for (const r of recipients) {
      const res = await sendSms({ to: r.contact_number, message: smsText });
      const rawText = typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw ?? {});
      await insertSmsLog(admin, {
        notification_id: resolved.id,
        personnel_id: r.id,
        recipient_name: r.name,
        recipient_role: r.role,
        phone: r.contact_number,
        message: smsText,
        status: res.ok ? "submitted" : "failed",
        provider_response: res.error ?? rawText,
        provider: res.provider ?? cfg.provider,
        provider_message_id: res.providerMessageId ?? null,
        provider_status: res.status ?? (res.ok ? "submitted" : "failed"),
      });
    }
  }

  await admin.from("air_sms_incidents").update({
    status: "closed", closed_at: taken_at,
    close_reason: action, acknowledged: action === "acknowledge",
  }).eq("device_id", n.device_id).eq("status", "open");

  return json({ ok: true, notification: updated, action: actionRow });
});
