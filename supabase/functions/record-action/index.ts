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
 * "Resolved"/"False alarm"/"Repaired" set status=resolved. If the sensor
 * is still in a non-safe level afterwards, the dashboard/bell keep showing
 * the (live) condition — now labelled "Resolved by [name] - condition
 * still present" — instead of hiding it.
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import {
  ACTION_ROLES, actionPatch, callerProfile, notifyPersonnel, resolveNotification,
} from "../_shared/ensure_notification.ts";

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
    `${n.room_name} — ${String(n.sensor_type).toUpperCase()} ${n.level_label}${note ? ": " + note : ""}`,
  );

  return json({ ok: true, notification: updated, action: actionRow });
});
