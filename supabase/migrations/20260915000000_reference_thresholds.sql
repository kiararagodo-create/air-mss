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
    where p.id = auth.uid()::text
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