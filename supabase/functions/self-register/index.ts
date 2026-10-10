// supabase/functions/self-register/index.ts
// Public account registration. Anyone can call this (no auth required).
// The account is created with account_status = 'pending' and a profile row
// is inserted. The user still needs an admin to approve before they can log in.

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
    const { email, password, name, role, department, contact_number } = await req.json();

    if (!email || !password || !name) {
      return new Response(
        JSON.stringify({ error: "Email, password, and full name are required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (password.length < 8) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 8 characters." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Public registration can never pick a role: the on_auth_user_created
    // trigger assigns role and account_status, and this function writes
    // neither. The list below only records the roles a visitor might
    // legitimately belong to.
    const allowedRoles = ["security", "maintenance"];
    if (role && !allowedRoles.includes(role)) {
      console.warn(`Requested role "${role}" ignored; registration assigns the role.`);
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Bootstrap admins must never be creatable through this public endpoint.
    // createUser below uses email_confirm: true, which proves no email
    // ownership, so without this check anyone could register a bootstrap
    // admin's address and the trigger would hand them an approved admin
    // account. Bootstrap admins are created via SQL only.
    const { data: bootstrapHit } = await adminClient
      .from("bootstrap_admins")
      .select("email")
      .eq("email", String(email).toLowerCase())
      .maybeSingle();

    if (bootstrapHit) {
      return new Response(
        JSON.stringify({ error: "This email cannot be used for self-registration." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createError || !newUser.user) {
      return new Response(
        JSON.stringify({ error: createError?.message ?? "Failed to create account" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // The on_auth_user_created trigger (see migration
    // 20260913010000_profile_bootstrap_and_rls.sql) already created the
    // profile row when createUser ran, with role/account_status decided by
    // the bootstrap_admins allowlist. All we do here is fill in the fields a
    // visitor typed. We deliberately do NOT set role, is_active or
    // account_status: those stay under the trigger's control so a
    // self-registration can never self-approve or self-promote.
    const { error: updateError } = await adminClient
      .from("profiles")
      .update({
        name,
        department: department ?? null,
        contact_number: contact_number ?? null,
      })
      .eq("id", newUser.user.id);

    if (updateError) {
      await adminClient.auth.admin.deleteUser(newUser.user.id);
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: created } = await adminClient
      .from("profiles")
      .select("role, role_label")
      .eq("id", newUser.user.id)
      .single();

    // Belt and braces: nothing above should ever have produced an admin row
    // (the bootstrap check above rejects those emails, and the trigger only
    // grants admin to the allowlist), but if it somehow did, downgrade it
    // rather than hand back a self-approved admin.
    if (created?.role === "admin") {
      await adminClient
        .from("profiles")
        .update({ role: "security", role_label: "Security Personnel" })
        .eq("id", newUser.user.id);
      console.error(`Downgraded self-registration of ${email} from admin to security.`);
    }

    const finalRoleLabel = "Security Personnel";

    // Notify every admin that a new registration is awaiting approval.
    const { data: admins } = await adminClient
      .from("profiles")
      .select("id")
      .eq("role", "admin")
      .eq("account_status", "approved");

    const adminRows = (admins ?? []).map((a: any) => ({
      user_id: a.id,
      kind: "info",
      title: "New Account Pending Approval",
      body: `${name} (${email}) registered as ${finalRoleLabel}. Review in Personnel Management.`,
    }));

    if (adminRows.length > 0) {
      await adminClient.from("notifications").insert(adminRows);
    }

    return new Response(
      JSON.stringify({ success: true, id: newUser.user.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});