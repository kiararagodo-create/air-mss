=============================================================================
 A.I.R. - combined deployment script (paste into the Supabase SQL editor)
=============================================================================

This file is the byte-for-byte concatenation of the two pending migrations:

    20260915000000_reference_thresholds.sql
    20260916000000_production_hardening.sql

concatenated mechanically, not retyped, so it cannot differ from the files in
version control. It is generated - edit the migrations, not this file.

Both halves are idempotent: running this twice is safe, and running it after a
partial failure is the intended recovery path.

Run it in ONE go (select all, paste, Run). If it stops on an error, fix that
line and re-run the whole script.
=============================================================================

-- Migration: align saved thresholds with the new reference guides, and make
-- platform_thresholds the one source of truth.
--
-- WHY THIS MIGRATION EXISTS
--
-- `src/data/Data.ts` DEFAULT_THRESHOLDS only applies on first-time setup and
-- when a fetch fails. Once a row has been saved in public.platform_thresholds,
-- that row wins and editing the code changes nothing. The saved LPG row still
-- held the pre-reference-guide values (1000 / 2000 / 5000), so every card,
-- badge, alarm and report was rendering numbers that the firmware and the
-- reference guides no longer agree with.
--
-- This migration:
--   1. Writes the reference-guide values into the canonical row (id = 1).
--   2. Constrains every tier group to ascending order (database-enforced, not
--      just a UI hint), so a bad write can never make a band unreachable.
--   3. Replaces the "any authenticated user may write" policies with
--      admin-only writes. Every authenticated user may still read.
--   4. Publishes platform_thresholds to supabase_realtime so a save in one
--      session reaches every other open session without a reload.
--   5. Re-points the SQL report helpers at the new LPG danger default and
--      provides resolve_thresholds() for the Edge Functions.
--
-- REFERENCE-GUIDE VALUES (the single source of truth)
--
--   CO2 (ppm), ASHRAE 62.1 & OSHA
--     warning 1000, high 2000, danger 3500
--     The device only has warning (1000), alarm (3500) and critical (5000)
--     tiers. "high 2000" is a dashboard-only tier: it exists so the dashboard
--     can grade a reading between the physical alarm points, and the ESP32
--     does not act on it.
--
--   LPG (ppm), NFPA 54 / NFPA 715 & BS EN 50194-1
--     warning 1000, high 2100 (10% LEL, buzzer alarm), danger 4200 (20% LEL)
--
--   Temperature (C), DHT22, ASHRAE 55
--     freeze below 5, cool below 18, heat above 35
--
--   Humidity (% RH), DHT22, EPA & ASHRAE 62.1
--     dry below 20, low below 30, mold above 80

-- ---------------------------------------------------------------------------
-- 1. Ascending-order enforcement.
-- ---------------------------------------------------------------------------
-- A tier band that cannot be entered (high <= warning, danger <= high) renders
-- as dead copy on every card and silently mis-grades every reading. The UI
-- validates this too, but the UI is only a convenience: this is the rule that
-- actually holds.

-- `add constraint` validates the rows already in the table, so an existing row
-- that violates the new rules would abort the whole migration. Normalise first,
-- then constrain.

update public.platform_thresholds
set co2_high = greatest(co2_warning + 1, least(co2_high, co2_danger - 1))
where id = 1 and not (co2_warning < co2_high and co2_high < co2_danger);

update public.platform_thresholds
set lpg_high = greatest(lpg_warning + 1, least(lpg_high, lpg_danger - 1))
where id = 1 and not (lpg_warning < lpg_high and lpg_high < lpg_danger);

update public.platform_thresholds
set temp_cool_below = greatest(temp_freeze_below + 1, least(temp_cool_below, temp_heat_above - 1))
where id = 1 and not (temp_freeze_below < temp_cool_below and temp_cool_below < temp_heat_above);

update public.platform_thresholds
set humidity_low_below = greatest(humidity_dry_below + 1, least(humidity_low_below, humidity_mold_above - 1))
where id = 1 and not (humidity_dry_below < humidity_low_below and humidity_low_below < humidity_mold_above);

alter table public.platform_thresholds
  drop constraint if exists platform_thresholds_co2_order;
alter table public.platform_thresholds
  add constraint platform_thresholds_co2_order
  check (co2_warning < co2_high and co2_high < co2_danger);

alter table public.platform_thresholds
  drop constraint if exists platform_thresholds_lpg_order;
alter table public.platform_thresholds
  add constraint platform_thresholds_lpg_order
  check (lpg_warning < lpg_high and lpg_high < lpg_danger);

alter table public.platform_thresholds
  drop constraint if exists platform_thresholds_temp_order;
alter table public.platform_thresholds
  add constraint platform_thresholds_temp_order
  check (temp_freeze_below < temp_cool_below and temp_cool_below < temp_heat_above);

alter table public.platform_thresholds
  drop constraint if exists platform_thresholds_humidity_order;
alter table public.platform_thresholds
  add constraint platform_thresholds_humidity_order
  check (humidity_dry_below < humidity_low_below and humidity_low_below < humidity_mold_above);

comment on constraint platform_thresholds_co2_order on public.platform_thresholds is
  'CO2 tiers must ascend: warning < high < danger.';
comment on constraint platform_thresholds_lpg_order on public.platform_thresholds is
  'LPG tiers must ascend: warning < high < danger.';
comment on constraint platform_thresholds_temp_order on public.platform_thresholds is
  'Temperature limits must ascend: freezeBelow < coolBelow < heatAbove.';
comment on constraint platform_thresholds_humidity_order on public.platform_thresholds is
  'Humidity limits must ascend: dryBelow < lowBelow < moldAbove.';

-- ---------------------------------------------------------------------------
-- 2. The canonical row.
-- ---------------------------------------------------------------------------
-- Seeded only when absent. An existing row is overwritten here on purpose:
-- the task is to make the SAVED values match the reference guides, and leaving
-- the stale LPG row in place would defeat the whole migration.

insert into public.platform_thresholds (
  id,
  co2_warning, co2_high, co2_danger,
  lpg_warning, lpg_high, lpg_danger,
  temp_freeze_below, temp_cool_below, temp_heat_above,
  humidity_dry_below, humidity_low_below, humidity_mold_above,
  updated_at
)
values (
  1,
  1000, 2000, 3500,
  1000, 2100, 4200,
  5, 18, 35,
  20, 30, 80,
  now()
)
on conflict (id) do update set
  co2_warning = excluded.co2_warning,
  co2_high = excluded.co2_high,
  co2_danger = excluded.co2_danger,
  lpg_warning = excluded.lpg_warning,
  lpg_high = excluded.lpg_high,
  lpg_danger = excluded.lpg_danger,
  temp_freeze_below = excluded.temp_freeze_below,
  temp_cool_below = excluded.temp_cool_below,
  temp_heat_above = excluded.temp_heat_above,
  humidity_dry_below = excluded.humidity_dry_below,
  humidity_low_below = excluded.humidity_low_below,
  humidity_mold_above = excluded.humidity_mold_above,
  updated_at = excluded.updated_at;

comment on table public.platform_thresholds is
  'Single global safety configuration, one row (id = 1). Read by every reference card, badge, alarm and report; writable only by an active, approved admin.';

-- ---------------------------------------------------------------------------
-- 3. RLS: read for everyone signed in, write for admins only.
-- ---------------------------------------------------------------------------
-- The previous policies were `to authenticated with check (true)`, i.e. any
-- signed-in account - including a pending, unapproved one - could rewrite the
-- platform's safety limits through the REST API. The Settings page hid the
-- inputs, but hiding a control is not a permission. The predicate below matches
-- the one already used for public.profiles.

alter table public.platform_thresholds enable row level security;

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
    where p.id::text = auth.uid()::text
      and p.role = 'admin'
      and p.account_status = 'approved'
      and p.is_active
  );
$$;

revoke all on function public.is_active_admin() from public, anon;
grant execute on function public.is_active_admin() to authenticated;

drop policy if exists "authenticated can read platform_thresholds" on public.platform_thresholds;
create policy "authenticated can read platform_thresholds"
  on public.platform_thresholds
  for select
  to authenticated
  using (true);

-- Drop the permissive write policies from 20260911000000. Without this the
-- admin-only policies below would simply be OR-ed alongside them.
drop policy if exists "authenticated can write platform_thresholds" on public.platform_thresholds;
drop policy if exists "authenticated can update platform_thresholds" on public.platform_thresholds;

drop policy if exists "admins can insert platform_thresholds" on public.platform_thresholds;
create policy "admins can insert platform_thresholds"
  on public.platform_thresholds
  for insert
  to authenticated
  with check (public.is_active_admin());

drop policy if exists "admins can update platform_thresholds" on public.platform_thresholds;
create policy "admins can update platform_thresholds"
  on public.platform_thresholds
  for update
  to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

drop policy if exists "admins can delete platform_thresholds" on public.platform_thresholds;
create policy "admins can delete platform_thresholds"
  on public.platform_thresholds
  for delete
  to authenticated
  using (public.is_active_admin());

-- ---------------------------------------------------------------------------
-- 4. Realtime.
-- ---------------------------------------------------------------------------
-- RoomsContext already subscribes to postgres_changes on platform_thresholds.
-- Without the publication Supabase never emits those events, so the
-- subscription silently did nothing and a save in another tab only appeared
-- after a manual reload.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'platform_thresholds'
  ) then
    alter publication supabase_realtime add table public.platform_thresholds;
  end if;
exception
  -- Deliberately broad. Adding a table to a publication can fail for reasons
  -- that have nothing to do with this migration (no publication on the project,
  -- insufficient ownership, the table already present on a variant). None of
  -- them should abort the migration, because everything else in it - the saved
  -- values, the ordering constraints, the RLS rewrite - matters more than
  -- live cross-tab sync.
  when others then
    raise notice
      'Could not add public.platform_thresholds to the supabase_realtime publication (%). Run it manually if cross-session updates do not appear: alter publication supabase_realtime add table public.platform_thresholds;',
      sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Report helpers.
-- ---------------------------------------------------------------------------
-- report_thresholds() (20260914000000_reports_simplified.sql) falls back to
-- built-in defaults when the client sends no thresholds. Its LPG default was
-- the old 5000 ppm, so any caller that omitted the value scored LPG readings
-- against a limit the device no longer uses. Every fallback now mirrors the
-- reference guides, including the dashboard-only CO2 `high` tier.

create or replace function public.report_thresholds(p_thresholds jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(p_thresholds, '{}'::jsonb) || jsonb_build_object(
    'co2_warning',        coalesce((p_thresholds->>'co2_warning')::numeric,        1000),
    'co2_high',           coalesce((p_thresholds->>'co2_high')::numeric,           2000),
    'co2_danger',         coalesce((p_thresholds->>'co2_danger')::numeric,         3500),
    'lpg_warning',        coalesce((p_thresholds->>'lpg_warning')::numeric,        1000),
    'lpg_high',           coalesce((p_thresholds->>'lpg_high')::numeric,           2100),
    'lpg_danger',         coalesce((p_thresholds->>'lpg_danger')::numeric,         4200),
    'temp_freeze_below',  coalesce((p_thresholds->>'temp_freeze_below')::numeric,  5),
    'temp_cool_below',    coalesce((p_thresholds->>'temp_cool_below')::numeric,    18),
    'temp_heat_above',    coalesce((p_thresholds->>'temp_heat_above')::numeric,    35),
    'humidity_dry_below', coalesce((p_thresholds->>'humidity_dry_below')::numeric, 20),
    'humidity_low_below', coalesce((p_thresholds->>'humidity_low_below')::numeric, 30),
    'humidity_mold_above',coalesce((p_thresholds->>'humidity_mold_above')::numeric,80)
  );
$$;

comment on function public.report_thresholds(jsonb) is
  'Merges client-supplied thresholds over the reference-guide defaults.';

-- report_is_danger() / report_triggered_by() grade against danger only, which
-- is what a report is about. The dashboard grades warning/high/danger too, and
-- that grading happens in the app, never here. Left as-is deliberately.
--
-- resolve_thresholds() is what the Edge Functions need: the thresholds that
-- were actually in effect for a given instant, read from the database rather
-- than from constants baked into the function bundle.
--
-- It prefers public.threshold_history when that table is present (it comes from
-- the monthly-reporting migrations, which are not applied to every project) and
-- otherwise falls back to the current platform_thresholds row. Reported as
-- threshold_source so a PDF can say which it used.

create or replace function public.resolve_thresholds(p_at timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_at      timestamptz := coalesce(p_at, now());
  v_hist    jsonb;
  v_current jsonb;
begin
  v_hist := null;

  -- threshold_history is optional: to_regclass() keeps this migration safe on
  -- projects where the monthly-reporting stack was never applied.
  if to_regclass('public.threshold_history') is not null then
    execute $q$
      select to_jsonb(h) - 'id' - 'change_note'
      from public.threshold_history h
      where h.effective_from <= $1
      order by h.effective_from desc
      limit 1
    $q$
    into v_hist
    using v_at;
  end if;

  if v_hist is not null then
    return v_hist || jsonb_build_object(
      'threshold_source', 'historical',
      'effective_from', (v_hist->>'effective_from')
    );
  end if;

  select to_jsonb(p) - 'id' - 'updated_at' into v_current
  from public.platform_thresholds p
  where p.id = 1;

  if v_current is null then
    raise exception 'No threshold configuration found: public.platform_thresholds has no row with id = 1.';
  end if;

  return v_current
    || jsonb_build_object(
         'threshold_source', 'current',
         'effective_from', to_char(coalesce((select updated_at from public.platform_thresholds where id = 1), now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
       );
end;
$$;

comment on function public.resolve_thresholds(timestamptz) is
  'Saved thresholds in effect at p_at, as jsonb. Used by the Edge Functions so no threshold is hardcoded in a function bundle.';

grant execute on function public.resolve_thresholds(timestamptz) to authenticated, service_role;
grant execute on function public.report_thresholds(jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 6. Historical baseline.
-- ---------------------------------------------------------------------------
-- threshold_history exists only where the monthly-reporting migrations ran.
-- Recording the reference-guide row as a baseline means a report for a period
-- before this migration is evaluated against the reference-guide values rather
-- than against whatever is configured months from now. The block is skipped
-- entirely when the table is absent.

do $$
begin
  if to_regclass('public.threshold_history') is null then
    raise notice 'public.threshold_history not present; skipping baseline history row.';
    return;
  end if;

  execute $q$
    insert into public.threshold_history (
      effective_from,
      co2_warning, co2_high, co2_danger,
      lpg_warning, lpg_high, lpg_danger,
      temp_freeze_below, temp_cool_below, temp_heat_above,
      humidity_dry_below, humidity_low_below, humidity_mold_above,
      change_note
    )
    select
      now(),
      p.co2_warning, p.co2_high, p.co2_danger,
      p.lpg_warning, p.lpg_high, p.lpg_danger,
      p.temp_freeze_below, p.temp_cool_below, p.temp_heat_above,
      p.humidity_dry_below, p.humidity_low_below, p.humidity_mold_above,
      'Baseline aligned to the reference guides (CO2 ASHRAE 62.1 & OSHA, LPG NFPA 54 / NFPA 715 & BS EN 50194-1, DHT22 ASHRAE 55 / EPA & ASHRAE 62.1)'
    from public.platform_thresholds p
    where p.id = 1
      and not exists (
        select 1 from public.threshold_history h where h.effective_from <= now()
      )
  $q$;
end;
$$;

=============================================================================
 PART 2 of 2 -- production hardening
=============================================================================

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
    where p.id::text = auth.uid()::text
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
-- auth.uid() returns uuid, and PostgreSQL has no `=` operator for a uuid = text
-- pair, so comparing the two uncast raised on every read and the notification
-- bell silently showed nothing. The policies below cast the column instead,
-- which is correct whether user_id is uuid or text.
--
-- 5a converts the column itself to uuid first. 20260911010000 declared it uuid,
-- but used `create table if not exists`, so where the table already existed the
-- declaration was a no-op and the live column stayed text - which is what
-- re-armed the uuid = text trap in the first place. Same block as
-- migrations/20260916010000_notifications_user_id_uuid.sql: idempotent, warns
-- and skips if the table is absent, and raises a named error (not a bare 22P02)
-- if any stored value is not a parseable uuid.
-- ---------------------------------------------------------------------------

do $$
declare
  v_col_type      text;
  v_fk            text;
  v_bad           bigint;
  v_profiles_type text;
begin
  if to_regclass('public.notifications') is null then
    raise warning 'public.notifications does not exist - skipped';
    return;
  end if;

  select data_type into v_col_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'notifications'
     and column_name  = 'user_id';

  if v_col_type is distinct from 'text' then
    raise notice 'notifications.user_id is already % - no conversion needed', v_col_type;
    return;
  end if;

  select count(*) into v_bad
    from public.notifications
   where user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  if v_bad > 0 then
    raise exception
      'notifications.user_id: % row(s) are not valid uuid. Repair or delete them, then re-run.',
      v_bad;
  end if;

  select conname into v_fk
    from pg_constraint
   where conrelid = 'public.notifications'::regclass
     and contype  = 'f'
     and pg_get_constraintdef(oid) ~ 'FOREIGN KEY \(user_id\)'
   limit 1;

  if v_fk is not null then
    execute format('alter table public.notifications drop constraint %I', v_fk);
  end if;

  alter table public.notifications
    alter column user_id type uuid using user_id::uuid;

  select data_type into v_profiles_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'profiles'
     and column_name  = 'id';

  if v_profiles_type = 'uuid' then
    alter table public.notifications
      add constraint notifications_user_id_fkey
      foreign key (user_id) references public.profiles (id) on delete cascade;
  else
    raise warning
      'profiles.id is %, so the notifications -> profiles FK was not re-created', v_profiles_type;
  end if;

  raise notice 'notifications.user_id converted text -> uuid';
end $$;

drop policy if exists "users can read own notifications" on public.notifications;
create policy "users can read own notifications"
  on public.notifications
  for select
  to authenticated
  using (user_id::text = auth.uid()::text);

drop policy if exists "users can update own notifications" on public.notifications;
create policy "users can update own notifications"
  on public.notifications
  for update
  to authenticated
  using (user_id::text = auth.uid()::text)
  with check (user_id::text = auth.uid()::text);

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
    where p.id::text = auth.uid()::text
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
-- ============================================================================
-- VERIFICATION - results are printed below. Read them against the expected
-- values in the trailing comment on each row.
-- ============================================================================

select count(*) as anon_can_execute_report_fn
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'report\_%'
  and has_function_privilege('anon', p.oid, 'EXECUTE');

select count(*) as authenticated_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'report\_%'
  and has_function_privilege('authenticated', p.oid, 'EXECUTE');

select relname, relrowsecurity from pg_class
where relname in ('rooms','readings','notifications') order by relname;

select count(*) as rows_for_january_2026
from report_calendar_month('2026-01-01', null, '{}');

select
  has_table_privilege('anon', 'public.readings', 'INSERT')  as anon_can_insert,
  has_table_privilege('anon', 'public.readings', 'SELECT')  as anon_can_select,
  has_table_privilege('anon', 'public.readings', 'UPDATE')  as anon_can_update,
  has_table_privilege('anon', 'public.readings', 'DELETE')  as anon_can_delete;
-- want: t, f, f, f

select
  has_table_privilege('authenticated', 'public.rooms', 'INSERT') as any_user_can_insert,
  has_table_privilege('authenticated', 'public.rooms', 'UPDATE') as any_user_can_update,
  has_table_privilege('authenticated', 'public.rooms', 'DELETE') as any_user_can_delete;
-- want: t, t, t at the TABLE level (RLS policies are what narrow these);
-- run the RLS check below to see the policy definitions.

select tablename, policyname, cmd, roles::text
from pg_policies
where schemaname = 'public'
  and tablename in ('rooms','readings','notifications')
order by tablename, policyname;

select * from public.platform_thresholds where id = 1;
-- want: co2 1000/2000/3500, lpg 1000/2100/4200, temp 5/18/35, humidity 20/30/80

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('report_day_detail_approved','report_month_stats_approved',
                    'is_approved_account','is_active_admin')
order by p.proname;
-- want: 4 rows

select
  (select count(*) from public.rooms) as total_devices,
  (select count(*) from public.rooms where co2 is not null or lpg is not null
                                          or temp is not null or humidity is not null) as with_readings;
-- informational
