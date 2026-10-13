-- Migration: profile bootstrap + RLS on public.profiles.
--
-- Problem being fixed: an admin account was blocked at login with
-- "Your account is still waiting for Admin approval." because login checks
-- profiles.account_status (see src/context/AuthContext.tsx), which defaults
-- to 'pending', and there was no way to approve an account from the UI.
-- Profiles rows were only ever created by two edge functions, and no trigger
-- on auth.users existed, so any account created another way had no row at all.
--
-- This migration:
--   * adds a configurable `bootstrap_admins` email allowlist,
--   * adds an on_auth_user_created trigger that ALWAYS creates the profile row
--     (auto-approved admin if the email is allowlisted, otherwise pending),
--   * adds RLS policies to public.profiles, which previously had none,
--   * adds a trigger that strips privileged column changes made by non-admins.
--
-- Regular signups are unaffected: they still get role = 'security',
-- is_active = true, account_status = 'pending', and remain blocked until an
-- admin approves them. No existing account is modified by this migration.

-- ---------------------------------------------------------------------------
-- 1. Bootstrap admin allowlist.
-- ---------------------------------------------------------------------------
create table if not exists public.bootstrap_admins (
  email      text primary key check (email = lower(email)),
  note       text,
  created_at timestamptz not null default now()
);

comment on table public.bootstrap_admins is
  'Emails that are auto-approved as admin when their auth account is created. Service-role only.';

-- ENABLE (not FORCE) is deliberate: anon/authenticated get nothing because
-- there are no policies, while postgres and service_role still bypass it so
-- the SQL editor, the handle_new_user trigger and the repair script work.
-- FORCE would also apply to the table owner and break all three.
alter table public.bootstrap_admins enable row level security;

-- No policies on purpose: the table is reachable only by the service role.

insert into public.bootstrap_admins (email, note)
values ('kiararagodo@gmail.com', 'founding admin')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Create the profile row for every auth signup.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text;
  v_bootstrap boolean := false;
begin
  if new.email is null then
    return new;
  end if;

  v_email := lower(new.email);

  select exists (
    select 1 from public.bootstrap_admins b where b.email = v_email
  ) into v_bootstrap;

  insert into public.profiles
    (id, email, name, role, role_label, is_active, account_status)
  values
    -- new.id, not new.id::text: profiles.id is uuid on this project and
    -- PostgreSQL has no text -> uuid assignment cast (42883), while uuid -> text
    -- is allowed. Passing the uuid works whether the column is uuid or text.
    (new.id,
     v_email,
     coalesce(
       new.raw_user_meta_data ->> 'full_name',
       new.raw_user_meta_data ->> 'name',
       split_part(v_email, '@', 1)
     ),
     case when v_bootstrap then 'admin'       else 'security' end,
     case when v_bootstrap then 'Administrator' else 'Security Personnel' end,
     true,
     case when v_bootstrap then 'approved'    else 'pending'  end)
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. Defence in depth: non-admins cannot change privileged columns, and the
--    admin role cannot be granted from a client at all.
--
-- RLS already scopes UPDATE to one's own row (or all rows, for admins), but
-- scoping alone would still let a normal user set their own role to 'admin'.
-- This trigger reverts those columns unless the caller is an active, approved
-- admin. Service role and the SQL editor have auth.uid() = null and bypass it.
--
-- The second rule is unconditional: 'admin' may only be set by the service
-- role or the SQL editor. Admin accounts are provisioned through the
-- bootstrap_admins allowlist (handled by handle_new_user, which runs as the
-- table owner and so has a null auth.uid()) or by direct SQL. Hiding the
-- option in the UI is cosmetic -- an admin JWT sent straight to the REST API
-- would otherwise still be able to promote somebody.
-- ---------------------------------------------------------------------------
create or replace function public.protect_profile_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- service role / SQL editor / auth-user trigger: allow.
  if auth.uid() is null then
    return new;
  end if;

  -- Nobody provisions an admin through the client, whoever the caller is.
  if new.role is distinct from old.role and new.role = 'admin' then
    raise exception
      'The admin role cannot be granted from the client. Add the email to public.bootstrap_admins or update the row in SQL.';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id::text = auth.uid()::text
      and p.role = 'admin'
      and p.account_status = 'approved'
      and p.is_active
  ) then
    new.role           := old.role;
    new.role_label     := old.role_label;
    new.access_scope   := old.access_scope;
    new.is_active      := old.is_active;
    new.account_status := old.account_status;
    new.approved_at    := old.approved_at;
    new.approved_by    := old.approved_by;
  end if;

  return new;
end;
$$;

revoke all on function public.protect_profile_privileged_columns() from public, anon, authenticated;

drop trigger if exists profiles_protect_privileged on public.profiles;
create trigger profiles_protect_privileged
  before update on public.profiles
  for each row execute function public.protect_profile_privileged_columns();

-- ---------------------------------------------------------------------------
-- 4. RLS on public.profiles (it previously had none).
--
-- The browser app uses the anon key and reads/writes this table directly:
--   src/pages/admin/PersonnelManagementPage.tsx:67  select("*")
--   src/pages/admin/PersonnelManagementPage.tsx:157 update({is_active})
--   src/pages/admin/PersonnelManagementPage.tsx:214 update({role, ...})
--   src/pages/admin/PersonnelManagementPage.tsx:247 delete()
-- Those previously ran with no policy at all. Admin-gated policies below keep
-- that page working while blocking everyone else.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
  on public.profiles
  for select
  to authenticated
  using (id::text = auth.uid()::text);

drop policy if exists "approved admins read all profiles" on public.profiles;
create policy "approved admins read all profiles"
  on public.profiles
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id::text = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles
  for update
  to authenticated
  using (id::text = auth.uid()::text)
  with check (id::text = auth.uid()::text);

drop policy if exists "approved admins update all profiles" on public.profiles;
create policy "approved admins update all profiles"
  on public.profiles
  for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id::text = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  )
  with check (true);

drop policy if exists "approved admins delete profiles" on public.profiles;
create policy "approved admins delete profiles"
  on public.profiles
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id::text = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Backfill any auth user that still has no profile row, so the "no profile"
--    branch in AuthContext is only reachable for genuinely broken accounts.
--    Existing rows are left exactly as they are.
-- ---------------------------------------------------------------------------
insert into public.profiles (id, email, name, role, role_label, is_active, account_status)
select
  -- see the handle_new_user insert above: uuid in, works for a uuid or text id
  u.id,
  lower(u.email),
  coalesce(u.raw_user_meta_data ->> 'full_name',
           u.raw_user_meta_data ->> 'name',
           split_part(lower(u.email), '@', 1)),
  case when exists (
         select 1 from public.bootstrap_admins b where b.email = lower(u.email)
       ) then 'admin' else 'security' end,
  case when exists (
         select 1 from public.bootstrap_admins b where b.email = lower(u.email)
       ) then 'Administrator' else 'Security Personnel' end,
  true,
  case when exists (
         select 1 from public.bootstrap_admins b where b.email = lower(u.email)
       ) then 'approved' else 'pending' end
from auth.users u
where u.email is not null
  and not exists (select 1 from public.profiles p where p.id::text = u.id::text)
on conflict (id) do nothing;
