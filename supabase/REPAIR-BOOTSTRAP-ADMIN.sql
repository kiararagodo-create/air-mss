-- supabase/REPAIR-BOOTSTRAP-ADMIN.sql
-- One-time repair for an admin account locked behind the approval gate.
--
-- Why this was needed: the "waiting for Admin approval" message comes from
-- src/context/AuthContext.tsx, which blocks login when
-- profiles.account_status = 'pending' (added by
-- 20260911010000_account_approval.sql with `not null default 'pending'`).
-- Accounts created through the self-register edge function always land on
-- 'pending', and there was no way to flip the status from the UI, so a real
-- admin could never approve themselves.
--
-- This script is idempotent: it updates the row if it exists and inserts it
-- if it does not, using the id from auth.users.
--
-- ORDERING: apply 20260913010000_profile_bootstrap_and_rls.sql FIRST.
-- Step 3 below writes to `bootstrap_admins`, which that migration creates.

-- Step 1 (read-only): confirm the current state.
select
  u.id as auth_id,
  p.id as profile_id,
  p.role,
  p.role_label,
  p.is_active,
  p.account_status,
  p.created_at
from auth.users u
left join public.profiles p on p.id = u.id::text
where lower(u.email) = 'kiararagodo@gmail.com';

-- Step 2: promote the account to an active, approved admin.
do $$
declare
  v_uid text;
begin
  select id::text into v_uid
  from auth.users
  where lower(email) = lower('kiararagodo@gmail.com');

  if v_uid is null then
    raise exception 'No auth.users row for kiararagodo@gmail.com - create the auth user first.';
  end if;

  insert into public.profiles
    (id, email, name, role, role_label, is_active, account_status, approved_at, approved_by)
  values
    (v_uid, 'kiararagodo@gmail.com', 'Kiara Ragodo', 'admin', 'Administrator',
     true, 'approved', now(), v_uid)
  on conflict (id) do update
    set role           = 'admin',
        role_label     = 'Administrator',
        is_active      = true,
        account_status = 'approved',
        approved_at    = now(),
        approved_by    = v_uid;
end $$;

-- Step 3: also register the address as a bootstrap admin so any future auth
-- user created with this email is auto-approved (see 20260913010000_*).
-- Guarded: if the migration has not been applied yet, skip rather than error.
-- (The SQL editor runs a pasted script in one transaction, so an unguarded
-- failure here would roll back step 2 and leave you locked out again.)
do $$
begin
  if to_regclass('public.bootstrap_admins') is null then
    raise notice 'bootstrap_admins missing - apply 20260913010000 first; skipping step 3.';
    return;
  end if;

  insert into public.bootstrap_admins (email, note)
  values ('kiararagodo@gmail.com', 'founding admin')
  on conflict (email) do nothing;
end $$;

-- Step 4 (read-only): verify.
select id, email, name, role, role_label, is_active, account_status
from public.profiles
where lower(email) = 'kiararagodo@gmail.com';