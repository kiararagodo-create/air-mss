// supabase/functions/manage-account-approval/index.ts
// Admin-only: approve / reject / disable a registered account.
// Body: { userId: string, action: "approve" | "reject" | "disable" }
// Writes the new account_status, stamps approved_at / approved_by, and
// drops an in-app notification on the target user.

// @ts-ignore - remote ESM import typing is not available in the editor
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

declare const Deno: any;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user: caller }, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !caller) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: callerProfile } = await callerClient
      .from("profiles")
      .select("role, account_status")
      .eq("id", caller.id)
      .single();

    if (callerProfile?.role !== "admin" || callerProfile?.account_status !== "approved") {
      return new Response(JSON.stringify({ error: "Only approved admins can manage accounts" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { userId, action } = await req.json();
    if (!userId || !["approve", "reject", "disable"].includes(action)) {
      return new Response(
        JSON.stringify({ error: "userId and a valid action (approve|reject|disable) are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Prevent self-approval / self-rejection / self-disable.
    if (userId === caller.id) {
      return new Response(JSON.stringify({ error: "You cannot manage your own account here." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: target, error: targetError } = await adminClient
      .from("profiles")
      .select("id, name, email, role, account_status")
      .eq("id", userId)
      .single();

    if (targetError || !target) {
      return new Response(JSON.stringify({ error: "Target user not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const updates: Record<string, any> = {};
    let notify: { title: string; body: string; kind: string } | null = null;

    if (action === "approve") {
      updates.account_status = "approved";
      updates.approved_at = new Date().toISOString();
      updates.approved_by = caller.id;
      notify = {
        kind: "approved",
        title: "Account Approved",
        body: `Your account has been approved. You can now log in and access the dashboard.`,
      };
    } else if (action === "reject") {
      updates.account_status = "rejected";
      notify = {
        kind: "rejected",
        title: "Account Request Rejected",
        body: `Your account request has been rejected. Please contact the administrator for assistance.`,
      };
    } else if (action === "disable") {
      updates.account_status = "disabled";
      notify = {
        kind: "disabled",
        title: "Account Disabled",
        body: `Your account has been disabled by an administrator. Contact the administrator for assistance.`,
      };
    }

    const { error: updateError } = await adminClient
      .from("profiles")
      .update(updates)
      .eq("id", userId);

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (notify) {
      await adminClient.from("notifications").insert({
        user_id: userId,
        kind: notify.kind,
        title: notify.title,
        body: notify.body,
      });
    }

    return new Response(
      JSON.stringify({ success: true, status: updates.account_status }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});