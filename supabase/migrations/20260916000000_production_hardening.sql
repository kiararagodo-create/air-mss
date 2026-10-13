-- src/../supabase/migrations/20260916000000_production_hardening.sql
--
-- Production hardening: repairs the defects that shipped in
-- 20260914000000_reports_simplified.sql and 20260911010000_account_approval.sql,
-- and closes the access-control gaps that made the React UI the only gate on
-- several operations.
--
-- The upstream migration files are ALSO corrected in place so a fresh install
-- is right from the first push. This file exists because a database that has
-- already been migrated keeps the old function bodies: `supabase db push` skips
-- applied migrations, so editing them in place alone changes nothing on a live
-- project. Everything here is idempotent and safe to re-run.
--
-- Four defects are corrected:
--
--   1. report_calendar_month / report_month_stats bounded a "month" with
--      `date + 1`. In PostgreSQL `date + integer` adds DAYS, so both functions
--      returned a single day (the 1st) instead of the month.
--   2. report_day_detail referenced `hum_danger`, but the CTE aliases the
--      column `humidity_danger`.
--   3. `revoke execute ... from anon` does not remove the implicit PUBLIC
--      grant that CREATE FUNCTION makes, so every report RPC stayed callable
--      by an unauthenticated caller with only the public anon key.
--   4. notifications RLS compared auth.uid() (uuid) to a text column, which
--      raises rather than returning false.

-- ---------------------------------------------------------------------------
-- 1 + 2: repair the report function bodies in place.
--
-- The functions are patched textually from pg_get_functiondef rather than
-- re-declared in full, so there is exactly one copy of each body and it cannot
-- drift from the migration that owns it. Every replacement asserts that the
-- expected text was actually found: if a deployed body differs from the one
-- this migration was written against, the migration raises instead of silently
-- reporting success.
-- ---------------------------------------------------------------------------

do $$
declare
  v_def text;
  v_new text;
begin

  -- ---- report_calendar_month ----------------------------------------------
  --
  -- regexp_replace rather than replace(): pg_get_functiondef re-formats the
  -- body it prints, so any exact-string match against the original source is
  -- fragile across whitespace. The pattern tolerates arbitrary spacing.
  select pg_get_functiondef(oid) into v_def
  from pg_proc
  where oid = to_regprocedure('public.report_calendar_month(date,text,jsonb)');

  if v_def is not null and v_def ~ '\(\s*p_month_start\s*\+\s*1\s*\)\s*::timestamp' then
    v_new := regexp_replace(
      v_def,
      '\(\(p_month_start\s*\+\s*1\)::timestamp at time zone ''Asia/Manila''\)',
      '(((p_month_start + interval ''1 month'')::date)::timestamp at time zone ''Asia/Manila'')',
      ''
    );
    if v_new = v_def then
      raise warning 'report_calendar_month: pattern matched but produced no change - repair manually';
    else
      execute v_new;
      raise notice 'report_calendar_month: month bounds repaired';
    end if;
  elsif v_def is null then
    raise warning 'report_calendar_month: not present, skipped';
  else
    raise notice 'report_calendar_month: already correct, skipped';
  end if;

  -- ---- report_month_stats -------------------------------------------------
  select pg_get_functiondef(oid) into v_def
  from pg_proc
  where oid = to_regprocedure('public.report_month_stats(integer,integer,text,jsonb)');

  if v_def is not null and v_def ~ '\(\s*make_date\(p_year, p_month, 1\)\s*\+\s*1\s*\)\s*::timestamp' then
    v_new := regexp_replace(
      v_def,
      '\(\(make_date\(p_year, p_month, 1\)\s*\+\s*1\)::timestamp at time zone ''Asia/Manila''\)',
      '(((make_date(p_year, p_month, 1) + interval ''1 month'')::date)::timestamp at time zone ''Asia/Manila'')',
      ''
    );
    if v_new = v_def then
      raise warning 'report_month_stats: pattern matched but produced no change - repair manually';
    else
      execute v_new;
      raise notice 'report_month_stats: month bounds repaired';
    end if;
  elsif v_def is null then
    raise warning 'report_month_stats: not present, skipped';
  else
    raise notice 'report_month_stats: already correct, skipped';
  end if;

  -- ---- report_day_detail --------------------------------------------------
  select pg_get_functiondef(oid) into v_def
  from pg_proc
  where oid = to_regprocedure('public.report_day_detail(date,text,jsonb,integer)');

  if v_def is not null and v_def like '%select hum_danger from stats%' then
    v_new := replace(v_def, 'select hum_danger from stats', 'select humidity_danger from stats');
    if v_new = v_def then
      raise warning 'report_day_detail: hum_danger not replaced - repair manually';
    else
      execute v_new;
      raise notice 'report_day_detail: humidity danger count column repaired';
    end if;
  elsif v_def is null then
    raise warning 'report_day_detail: not present, skipped';
  else
    raise notice 'report_day_detail: already correct, skipped';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3: report RPCs were reachable by `anon`.
--
-- `create function` grants EXECUTE to PUBLIC, and anon is an implicit member of
-- PUBLIC. `revoke ... from anon` therefore removed nothing. These RPCs are the
-- whole reporting surface: report_day_danger_rows returns raw per-reading rows
-- including exact timestamps, which the UI restricts to admins.
--
-- The functions are `security invoker`, so the grant is genuinely the only
-- barrier once the readings table itself has RLS (section 4 below).
-- ---------------------------------------------------------------------------

-- The live project also carries four report_* functions that no migration in
-- this repository creates - report_latest_reading, report_year_months,
-- report_refresh_daily and report_refresh_recent. They were found by querying
-- pg_proc directly, which means the database has drifted from the repo and
-- those definitions are not under version control.
--
-- They are revoked here dynamically rather than by name-and-signature, because
-- an explicit revoke needs the exact argument types and those are unknown for
-- functions we do not have the source for. Over-revoking from PUBLIC is
-- harmless; under-revoking is the vulnerability. They stay executable for
-- `authenticated`, so if the app needs them nothing breaks.
--
-- Re-run this migration after the drift is resolved: any new report_* function
-- added straight in the SQL editor will re-open the PUBLIC grant, because
-- CREATE FUNCTION always grants it.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'report\_%'
  loop
    execute format('revoke execute on function %s from public', r.sig);
  end loop;
end
$$;

-- Named revokes for the functions this repository does own, so the grant
-- surface stays readable in review even though the loop above is the
-- belt-and-braces pass.
revoke execute on function public.report_thresholds(jsonb) from public;
revoke execute on function public.report_is_danger(numeric, numeric, numeric, numeric, jsonb) from public;
revoke execute on function public.report_triggered_by(numeric, numeric, numeric, numeric, jsonb) from public;
revoke execute on function public.report_metric_obj(numeric, numeric, numeric, bigint, text) from public;
revoke execute on function public.report_calendar_month(date, text, jsonb) from public;
revoke execute on function public.report_day_detail(date, text, jsonb, integer) from public;
revoke execute on function public.report_day_danger_rows(date, text, jsonb, integer, integer) from public;
revoke execute on function public.report_month_stats(integer, integer, text, jsonb) from public;

revoke execute on function public.report_thresholds(jsonb) from anon;
revoke execute on function public.report_is_danger(numeric, numeric, numeric, numeric, jsonb) from anon;
revoke execute on function public.report_triggered_by(numeric, numeric, numeric, numeric, jsonb) from anon;
revoke execute on function public.report_metric_obj(numeric, numeric, numeric, bigint, text) from anon;
revoke execute on function public.report_calendar_month(date, text, jsonb) from anon;
revoke execute on function public.report_day_detail(date, text, jsonb, integer) from anon;
revoke execute on function public.report_day_danger_rows(date, text, jsonb, integer, integer) from anon;
revoke execute on function public.report_month_stats(integer, integer, text, jsonb) from anon;

grant execute on function public.report_thresholds(jsonb) to authenticated;
grant execute on function public.report_is_danger(numeric, numeric, numeric, numeric, jsonb) to authenticated;
grant execute on function public.report_triggered_by(numeric, numeric, numeric, numeric, jsonb) to authenticated;
grant execute on function public.report_metric_obj(numeric, numeric, numeric, bigint, text) to authenticated;
grant execute on function public.report_calendar_month(date, text, jsonb) to authenticated;
grant execute on function public.report_day_detail(date, text, jsonb, integer) to authenticated;
grant execute on function public.report_day_danger_rows(date, text, jsonb, integer, integer) to authenticated;
grant execute on function public.report_month_stats(integer, integer, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4: public.rooms and public.readings had no RLS at all.
--
-- Both tables were created outside this repository, so no migration ever
-- enabled row level security on them. That left `user.role === "admin"` in a
-- React component as the only thing standing between any signed-in account and
-- `update rooms set siren_muted = true` - which silences a physical gas alarm.
-- The policies below are what the UI already implied.
--
-- rooms: every signed-in user may read the registry (the dashboard needs it);
-- only an approved, active admin may register, reconfigure or remove a device
-- or mute a siren.
--
-- readings: the ESP32 firmware posts with the anon key and needs INSERT only.
-- Signed-in users may read. Nobody may update or delete a reading - a safety
-- record is append-only, and the archive job is the only thing that removes
-- rows, and it runs as the service role, which bypasses RLS.
-- ---------------------------------------------------------------------------

alter table public.rooms    enable row level security;
alter table public.readings enable row level security;

-- is_active_admin() is defined in 20260915000000_reference_thresholds.sql, which
-- may not have been applied to a given project yet. Re-declaring it here (the
-- same body, idempotently) means this migration can be applied on its own
-- without depending on migration order.
create or replace function public.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()::text
      and p.role = 'admin'
      and p.account_status = 'approved'
      and p.is_active
  );
$$;

revoke all on function public.is_active_admin() from public, anon;
grant execute on function public.is_active_admin() to authenticated;

drop policy if exists "authenticated can read rooms" on public.rooms;
create policy "authenticated can read rooms"
  on public.rooms
  for select
  to authenticated
  using (true);

drop policy if exists "admins can insert rooms" on public.rooms;
create policy "admins can insert rooms"
  on public.rooms
  for insert
  to authenticated
  with check (public.is_active_admin());

drop policy if exists "admins can update rooms" on public.rooms;
create policy "admins can update rooms"
  on public.rooms
  for update
  to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

drop policy if exists "admins can delete rooms" on public.rooms;
create policy "admins can delete rooms"
  on public.rooms
  for delete
  to authenticated
  using (public.is_active_admin());

-- Device ingest: the firmware holds only the publishable anon key.
drop policy if exists "devices can insert readings" on public.readings;
create policy "devices can insert readings"
  on public.readings
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "authenticated can read readings" on public.readings;
create policy "authenticated can read readings"
  on public.readings
  for select
  to authenticated
  using (true);

-- No UPDATE/DELETE policies on purpose. Without one, RLS denies the operation
-- to every non-service role, which is the append-only guarantee.

-- ---------------------------------------------------------------------------
-- 5: notifications RLS compared uuid to text.
--
-- notifications.user_id is text (FK to profiles.id). auth.uid() returns uuid,
-- and PostgreSQL has neither an implicit cast nor an `=` operator for that
-- pair, so every read raised and the bell silently showed nothing.
-- ---------------------------------------------------------------------------

drop policy if exists "users can read own notifications" on public.notifications;
create policy "users can read own notifications"
  on public.notifications
  for select
  to authenticated
  using (auth.uid()::text = user_id);

drop policy if exists "users can update own notifications" on public.notifications;
create policy "users can update own notifications"
  on public.notifications
  for update
  to authenticated
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

-- ---------------------------------------------------------------------------
-- 6: realtime publication.
--
-- The client subscribes to postgres_changes on rooms, readings and
-- notifications, but only platform_thresholds was ever added to the
-- publication, so those three subscriptions succeeded and then delivered
-- nothing. rooms has no polling fallback, so a device added in another tab
-- never appeared. Publishing is only safe now that section 4 gives both tables
-- real RLS - postgres_changes applies the subscriber's RLS policies.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
    ) then
      alter publication supabase_realtime add table public.rooms;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
    ) then
      alter publication supabase_realtime add table public.notifications;
    end if;
    -- readings is intentionally NOT published: at a ~3s cadence it would push
    -- every row of every device to every subscriber. The client already polls
    -- the latest row per device every 2s, which is cheaper and sufficient.
  else
    raise warning 'supabase_realtime publication not found; skipping realtime wiring';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Account approval was enforced only in the browser.
--
-- GoTrue has no knowledge of profiles.account_status, so `signInWithPassword`
-- succeeds for a `pending` self-registered account and hands it a valid JWT.
-- The check that rejected it lived in AuthContext.login() - i.e. in the same
-- tab as the code the user could open devtools on. Every `to authenticated`
-- policy in the project then applied to that account in full.
--
-- is_approved_account() is the single server-side predicate for "this caller is
-- actually a live, approved person". It is now required by the policies above
-- (via is_active_admin for writes, and directly for reads) and by the two
-- report RPCs the UI depends on.
--
-- Nothing here breaks an existing approved admin: they already satisfy all
-- three conditions.
-- ---------------------------------------------------------------------------

create or replace function public.is_approved_account()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()::text
      and p.account_status = 'approved'
      and p.is_active
  );
$$;

revoke all on function public.is_approved_account() from public, anon;
grant execute on function public.is_approved_account() to authenticated;

-- Reads require an approved, active account. is_active_admin() already
-- implies approved + active, but the read policies should not depend on role.
drop policy if exists "authenticated can read rooms" on public.rooms;
create policy "authenticated can read rooms"
  on public.rooms
  for select
  to authenticated
  using (public.is_approved_account());

drop policy if exists "authenticated can read readings" on public.readings;
create policy "authenticated can read readings"
  on public.readings
  for select
  to authenticated
  using (public.is_approved_account());

-- Tighten the two other tables whose read policies were `using (true)`.
drop policy if exists "authenticated can read platform_thresholds" on public.platform_thresholds;
create policy "authenticated can read platform_thresholds"
  on public.platform_thresholds
  for select
  to authenticated
  using (public.is_approved_account());

-- The report RPCs are SECURITY INVOKER, so their reach is bounded by the
-- readings policy above. Wrapping the two the UI actually calls makes the
-- requirement explicit at the entry point rather than implied one layer down,
-- and returns a clear message instead of an empty result set.
create or replace function public.report_day_detail_approved(
  p_day date,
  p_device_id text default null,
  p_thresholds jsonb default '{}'::jsonb,
  p_bucket_seconds integer default 300
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not public.is_approved_account() then
    raise exception 'account is not approved';
  end if;
  return public.report_day_detail(p_day, p_device_id, p_thresholds, p_bucket_seconds);
end;
$$;

create or replace function public.report_month_stats_approved(
  p_year integer,
  p_month integer,
  p_device_id text default null,
  p_thresholds jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not public.is_approved_account() then
    raise exception 'account is not approved';
  end if;
  return public.report_month_stats(p_year, p_month, p_device_id, p_thresholds);
end;
$$;

revoke all on function public.report_day_detail_approved(date, text, jsonb, integer) from public, anon;
revoke all on function public.report_month_stats_approved(integer, integer, text, jsonb) from public, anon;
grant execute on function public.report_day_detail_approved(date, text, jsonb, integer) to authenticated;
grant execute on function public.report_month_stats_approved(integer, integer, text, jsonb) to authenticated;

notify pgrst, 'reload schema';