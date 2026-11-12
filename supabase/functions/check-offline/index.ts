/**
 * check-offline — scheduled offline/online sweep.
 * Invoked by pg_cron (every 30s) or Supabase Dashboard schedules.
 * Delegates to air-alerts with { action: "check_offline" } so the logic lives
 * in one place. Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
 * SMS_PROVIDER + provider secrets / APP_PUBLIC_URL in the Edge secrets.
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";
import { getSmsConfig } from "../_shared/sms-provider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cfg = getSmsConfig();
  const appUrl = Deno.env.get("APP_PUBLIC_URL") ?? "https://air.adamson.edu.ph";
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase secrets" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: rooms } = await admin.from("rooms").select("id, name, floor");
  const OFFLINE_AFTER_S = Number(Deno.env.get("OFFLINE_AFTER_S") ?? "60");
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_S * 1000).toISOString();
  let created = 0;
  for (const room of ((rooms as any[]) ?? [])) {
    const { data: latest } = await admin.from("readings")
      .select("created_at").eq("device_id", room.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const lastSeen = latest?.created_at as string | undefined;
    if (lastSeen && lastSeen >= cutoff) continue;
    const { data: open } = await admin.from("air_notifications")
      .select("id").eq("device_id", room.id).eq("level_label", "Offline").eq("status", "open").maybeSingle();
    if (open) continue;
    const { data } = await admin.from("air_notifications").insert({
      device_id: room.id, room_name: room.name ?? room.id, floor: room.floor ?? "",
      sensor_type: "device", level_label: "Offline", severity: "warning",
      reading_value: null, reading_unit: "",
      message: `A.I.R. ALERT [OFFLINE] ${room.name ?? room.id}: Device ${room.id} has not reported for ${OFFLINE_AFTER_S}s.`,
      status: "open",
    }).select("id").single();
    if (data) created++;
  }
  return json({ status: "ok", offline_created: created, appUrl, sms_provider: cfg.provider, has_sms_credentials: cfg.missing.length === 0 });
});
