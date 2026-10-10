// supabase/functions/admin-create-personnel/index.ts
// Deploy with: npx supabase functions deploy admin-create-personnel
//
// Admin-only account creation. The caller must present a valid Supabase JWT
// AND that user must have role = 'admin'. The service-role key is used only
// here, on the server.
//
// NOTE: this file was previously empty on disk with its source accidentally
// committed to src/index.ts. It has been restored here and the stray removed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno&standalone";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization header" }, 401);
    }

    // Client scoped to the caller's own JWT — used only to verify who's calling.
    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user: caller },
      error: callerError,
    } = await callerClient.auth.getUser();

    if (callerError || !caller) {
      return json({ error: "Invalid or expired session" }, 401);
    }

    // Confirm the caller is an approved admin before allowing account creation.
    const { data: callerProfile, error: profileError } = await callerClient
      .from("profiles")
      .select("role, account_status")
      .eq("id", caller.id)
      .single();

    if (profileError || callerProfile?.role !== "admin" || callerProfile?.account_status !== "approved") {
      return json({ error: "Only approved admins can create personnel accounts" }, 403);
    }

const { email, password, name, role, role_label, department, contact_number, access_scope } =
      await req.json();

    if (!email || !password || !name || !role) {
 return json({ error: "email, password, name, and role are required" }, 400);
    }

    // Admin accounts are provisioned only via the bootstrap_admins allowlist or
    // direct SQL. Client input can never create one, not even from an
    // authenticated admin.
    const allowedRoles = ["security", "maintenance"];
    if (!allowedRoles.includes(role)) {
      return json(
        { error: "Only security and maintenance personnel can be added." },
    400
      );
    }

    if (password.length < 8) {
  return json({ error: "Password must be at least 8 characters" }, 400);
    }

    // Admin client — service_role key, only ever used server-side.
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createError || !newUser.user) {
      return json({ error: createError?.message ?? "Failed to create account" }, 400);
    }

    // The on_auth_user_created trigger (migration
    // 20260913010000_profile_bootstrap_and_rls.sql) already created the
    // profile row as pending, so this is an update, not an insert.
    const { error: updateError } = await adminClient
      .from("profiles")
.update({
        name,
        email,
        role,
        role_label: role_label ?? role,
        department: department ?? null,
        contact_number: contact_number ?? null,
        access_scope: access_scope ?? null,
        is_active: true,
        // An admin creating the account directly is the approval. Without this
        // the column default is 'pending' and the new person could never sign
        // in, because AuthContext blocks anything that is not 'approved'.
        account_status: "approved",
        approved_at: new Date().toISOString(),
        approved_by: caller.id,
      })
      .eq("id", newUser.user.id);

    if (updateError) {
      // Roll back the auth user if the profile update failed, to avoid
      // leaving an orphaned account with no profile.
      await adminClient.auth.admin.deleteUser(newUser.user.id);
      return json({ error: updateError.message }, 400);
    }

    return json({ success: true, id: newUser.user.id });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});