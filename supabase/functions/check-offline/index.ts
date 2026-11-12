/**
 * check-offline — scheduled offline/online sweep.
 * Delegates to air-alerts { action: "check_offline" } so offline alerts,
 * SMS, and escalation share one implementation.
 */
import { createClient } from "https://esm.sh/v135/@supabase/supabase-js@2.45.4?target=deno&standalone";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Missing Supabase secrets" }, 500);

  const res = await fetch(`${supabaseUrl}/functions/v1/air-alerts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ action: "check_offline" }),
  });
  const data = await res.json().catch(() => ({}));
  return json(data, res.status);
});
