/**
 * air-action — public token endpoint behind /action/<token>.
 * verify_jwt MUST be false for this function (Supabase Dashboard ->
 * Edge Functions -> air-action -> disable JWT verification). All access is
 * gated on the token itself; the service role is used server-side only.
 *
 *   GET  -> validate token, return alert + personnel + prior actions.
 *   POST -> { token, action, note } records the action, updates the
 *           notification status and handled_by_*, notifies the admin inbox
 *           (an 'approved'-style row in public.notifications for each active
 *           admin so it appears in the bell dropdown).
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const ACTIONS = ["acknowledge", "on_my_way", "resolved", "false_alarm"] as const;

async function lookup(admin: any, token: string) {
  const { data: r } = await admin.from("notification_recipients")
    .select("*, air_notifications!notification_recipients_notification_id_fkey(*)")
    .eq("action_token", token).maybeSingle();
  return r as any | null;
}

function publicView(r: any) {
  const n = r.air_notifications;
  return {
    notification: n, personnel_name: r.personnel_name, personnel_role: r.personnel_role,
    expires_at: r.expires_at, expired: new Date(r.expires_at) < new Date(),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase secrets" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const url = new URL(req.url);
  const tokenQ = url.searchParams.get("token") ?? "";

  if (req.method === "GET") {
    if (!tokenQ) return json({ error: "Missing token" }, 400);
    const r = await lookup(admin, tokenQ);
    if (!r) return json({ error: "Invalid link" }, 404);
    const { data: actions } = await admin.from("notification_actions")
      .select("*").eq("notification_id", r.notification_id).order("taken_at", { ascending: true });
    return json({ ...publicView(r), actions: actions ?? [] });
  }

  if (req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const { token, action, note } = body ?? {};
    if (!token || !ACTIONS.includes(action)) return json({ error: "Token and valid action required" }, 400);
    const r = await lookup(admin, token);
    if (!r) return json({ error: "Invalid link" }, 404);
    if (new Date(r.expires_at) < new Date()) return json({ error: "Link expired" }, 410);

    const taken_at = new Date().toISOString();
    await admin.from("notification_actions").insert({
      notification_id: r.notification_id, personnel_id: r.personnel_id,
      personnel_name: r.personnel_name, personnel_role: r.personnel_role,
      action, note: String(note ?? "").slice(0, 1000) || null, taken_at,
    });

    const nextStatus = action === "resolved" || action === "false_alarm" ? "resolved"
      : action === "acknowledge" || action === "on_my_way" ? "acknowledged" : r.air_notifications.status;
    const patch: any = { handled_by_name: r.personnel_name, handled_by_role: r.personnel_role, handled_at: taken_at };
    if (action === "resolved" || action === "false_alarm") {
      patch.status = "resolved"; patch.resolved_at = taken_at;
      patch.resolution_note = String(note ?? "").slice(0, 1000) || (action === "false_alarm" ? "Marked as false alarm" : "Resolved from SMS link");
    } else if (nextStatus === "acknowledged" && r.air_notifications.status === "open") {
      patch.status = "acknowledged";
    }
    await admin.from("air_notifications").update(patch).eq("id", r.notification_id);

    // Bell notifier: tell active admins that someone acted.
    const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin").eq("is_active", true);
    const label = { acknowledge: "acknowledged", on_my_way: "is on the way to", resolved: "resolved", false_alarm: "marked as false alarm" } as any;
    for (const a of (admins as any[]) ?? []) {
      await admin.from("notifications").insert({
        user_id: a.id, kind: "alert_action",
        title: `${r.personnel_name} ${label[action]} ${r.air_notifications.room_name}`,
        body: `${r.air_notifications.room_name} — ${r.air_notifications.sensor_type?.toUpperCase()} ${r.air_notifications.level_label}${note ? ": " + note : ""}`,
      });
    }
    return json({ ok: true, action, personnel_name: r.personnel_name });
  }
  return json({ error: "Method not allowed" }, 405);
});
