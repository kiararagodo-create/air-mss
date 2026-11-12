-- Migration: fix infinite recursion in public.profiles RLS policies.
--
-- Root cause: several policies on public.profiles queried public.profiles
-- directly inside their USING/WITH CHECK clauses. With RLS enabled that
-- re-entered the same policy and raised "infinite recursion detected in
-- policy for relation profiles" (42P17). The fix is to evaluate the
-- admin/approved predicate through SECURITY DEFINER helpers, which read
-- profiles with RLS bypassed.
--
-- This migration also removes the duplicate own-row SELECT policies and
-- replaces the direct profile lookups in the monthly reporting policies
-- with the same helper.

-- ---------------------------------------------------------------------------
-- 1. SECURITY DEFINER helpers (read profiles without triggering RLS).
-- ---------------------------------------------------------------------------

create or replace function public.is_approved_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id::text = auth.uid()::text
      and p.role = 'admin'
      and p.account_status = 'approved'
      and p.is_active
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_approved_admin();
$$;

create or replace function public.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_approved_admin();
$$;

create or replace function public.is_approved_account()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id::text = auth.uid()::text
      and p.account_status = 'approved'
      and p.is_active
  );
$$;

revoke all on function public.is_approved_admin() from public, anon;
grant execute on function public.is_approved_admin() to authenticated;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.is_active_admin() from public, anon;
grant execute on function public.is_active_admin() to authenticated;

revoke all on function public.is_approved_account() from public, anon;
grant execute on function public.is_approved_account() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Drop EVERY existing policy on public.profiles (including duplicates and
--    any production-only names), then recreate a minimal, non-recursive set.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
  loop
    execute format('drop policy if exists %I on public.profiles', r.policyname);
  end loop;
end $$;

-- Own row: read.
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (id::text = auth.uid()::text);

-- Own row: update (column protection is enforced by the
-- profiles_protect_privileged_columns trigger; RLS only scopes the row).
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id::text = auth.uid()::text)
  with check (id::text = auth.uid()::text);

-- Admin: read all.
create policy "profiles_select_admin"
  on public.profiles for select
  to authenticated
  using (public.is_approved_admin());

-- Admin: update all.
create policy "profiles_update_admin"
  on public.profiles for update
  to authenticated
  using (public.is_approved_admin())
  with check (public.is_approved_admin());

-- Admin: delete.
create policy "profiles_delete_admin"
  on public.profiles for delete
  to authenticated
  using (public.is_approved_admin());

-- INSERT is intentionally left to the handle_new_user trigger (SECURITY
-- DEFINER) and the service role; no client INSERT policy is added, matching
-- the previous behaviour.

-- ---------------------------------------------------------------------------
-- 3. Replace direct public.profiles lookups in the monthly reporting policies
--    with the helper, so they never re-enter profiles RLS. Guarded so the
--    migration still applies on projects where those tables do not exist.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.threshold_history') is not null then
    drop policy if exists threshold_history_admin_read on public.threshold_history;
    create policy threshold_history_admin_read
      on public.threshold_history for select
      to authenticated
      using (public.is_approved_admin());

    drop policy if exists threshold_history_admin_write on public.threshold_history;
    create policy threshold_history_admin_write
      on public.threshold_history for all
      to authenticated
      using (public.is_approved_admin())
      with check (public.is_approved_admin());
  end if;

  if to_regclass('public.daily_summaries') is not null then
    drop policy if exists daily_summaries_admin_read on public.daily_summaries;
    create policy daily_summaries_admin_read
      on public.daily_summaries for select
      to authenticated
      using (public.is_approved_admin());
  end if;

  if to_regclass('public.graph_buckets') is not null then
    drop policy if exists graph_buckets_admin_read on public.graph_buckets;
    create policy graph_buckets_admin_read
      on public.graph_buckets for select
      to authenticated
      using (public.is_approved_admin());
  end if;

  if to_regclass('public.monthly_reports') is not null then
    drop policy if exists monthly_reports_admin_read on public.monthly_reports;
    create policy monthly_reports_admin_read
      on public.monthly_reports for select
      to authenticated
      using (public.is_approved_admin());
  end if;

  if to_regclass('public.reporting_config') is not null then
    drop policy if exists reporting_config_admin_read on public.reporting_config;
    create policy reporting_config_admin_read
      on public.reporting_config for select
      to authenticated
      using (public.is_approved_admin());
  end if;

  if to_regclass('storage.objects') is not null then
    drop policy if exists monthly_reports_objects_admin_read on storage.objects;
    create policy monthly_reports_objects_admin_read
      on storage.objects for select
      to authenticated
      using (
        bucket_id = 'monthly-reports'
        and public.is_approved_admin()
      );
  end if;
end $$;

notify pgrst, 'reload schema';
