/**
 * record-action — authenticated in-app personnel actions on alerts (A).
 *
 * verify_jwt: ON (default). The caller must send their Supabase JWT; this
 * function validates it server-side and records the action under the
 * caller's OWN profile identity — a client cannot forge another person's
 * name. Roles allowed: admin, maintenance, security.
 *
 * Body: { notification_id?: number, live?: {...}, action, note? }
 *   - live is a client-computed alert with no DB row yet. It is upserted
 *     FIRST (see _shared/ensure_notification.ts), so the action always
 *     lands on a real air_notifications row everyone can see.
 *
 * Side effects (service role): insert notification_actions, update
 * air_notifications (status / handled_by_id / handled_by_name /
 * handled_by_role / handled_at / resolved_at / resolution_note), and one
 * public.notifications row per OTHER active personnel member so the bell
 * dropdown shows "[Name] took action: Acknowledged - Kitchen CO2".
 * Realtime on both tables + 10s polling refresh every other client.
 *
 * SMS: one text per action, sent ONLY to people returned by
 * getSmsRecipients() (active, approved, SMS switch on, valid number).
 * If the same person already took the same action on the same alert in the
 * last 60 seconds (a double-fired request), the SMS is skipped so credits
 * are not spent twice.
 *
 * "Resolved"/"False alarm"/"Repaired" set status=resolved. If the sensor
 * is still in a non-safe level afterwards, the dashboard/bell keep showing
 * the (live) condition — now labelled "Resolved by [name] - condition
 * still present" — instead of hiding it.
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import {
  ACTION_ROLES, actionPatch, callerProfile, notifyPersonnel, resolveNotification,
} from "../_shared/ensure_notification.ts";
import { getSmsConfig, sendSms } from "../_shared/sms-provider.ts";
import { buildAcknowledgedMessage, buildResolvedMessage, manilaTime } from "../_shared/sms_templates.ts";
import { getSmsRecipients } from "../_shared/sms_recipients.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

  // ---- SMS ----------------------------------------------------------------
  // Duplicate guard. If a request fired twice at the same moment, both
  // requests insert an action row. Only the request whose row has the LOWEST
  // id sends the SMS; any later duplicate within 60 seconds skips it.
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
    getSmsConfig();
    // Only people who are active, approved, have the SMS switch ON and a
    // valid number. Anyone with the switch off is never texted.
    const recipients = await getSmsRecipients(admin);
    const t = manilaTime();
    const roomLabel = n.room_name ?? n.device_id;
    const smsText = (action === "acknowledge" || action === "on_my_way")
      ? buildAcknowledgedMessage(profile.name, profile.role, roomLabel, t)
      : buildResolvedMessage(profile.name, profile.role, roomLabel, note, t);
    for (const r of recipients) {
      const res = await sendSms({ to: r.contact_number, message: smsText });
      const rawText = typeof res.raw === "string" ? res.raw : JSON.stringify(res.raw ?? {});
      await admin.from("sms_logs").insert({
        notification_id: resolved.id,
        personnel_id: r.id,
        recipient_name: r.name,
        recipient_role: r.role,
        phone: r.contact_number,
        message: smsText,
        status: res.ok ? "submitted" : "failed",
        provider_response: res.error ?? rawText,
        provider: res.provider,
        provider_message_id: res.providerMessageId,
        provider_status: res.status,
      });
    }
  }

  await admin.from("air_sms_incidents").update({
    status: "closed", closed_at: taken_at,
    close_reason: action, acknowledged: action === "acknowledge",
  }).eq("device_id", n.device_id).eq("status", "open");

  return json({ ok: true, notification: updated, action: actionRow });
});
