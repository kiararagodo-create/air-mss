-- ============================================================================
-- A.I.R. - remaining production hardening. Paste into Supabase SQL editor, Run.
-- Idempotent: safe to run twice, and safe to re-run after a partial failure.
-- ============================================================================


-- ============================================================================
-- PART 1 - saved thresholds: ordering constraints + canonical values
-- ============================================================================

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

alter table public.platform_thresholds drop constraint if exists platform_thresholds_co2_order;
alter table public.platform_thresholds add constraint platform_thresholds_co2_order
  check (co2_warning < co2_high and co2_high < co2_danger);

alter table public.platform_thresholds drop constraint if exists platform_thresholds_lpg_order;
alter table public.platform_thresholds add constraint platform_thresholds_lpg_order
  check (lpg_warning < lpg_high and lpg_high < lpg_danger);

alter table public.platform_thresholds drop constraint if exists platform_thresholds_temp_order;
alter table public.platform_thresholds add constraint platform_thresholds_temp_order
  check (temp_freeze_below < temp_cool_below and temp_cool_below < temp_heat_above);

alter table public.platform_thresholds drop constraint if exists platform_thresholds_humidity_order;
alter table public.platform_thresholds add constraint platform_thresholds_humidity_order
  check (humidity_dry_below < humidity_low_below and humidity_low_below < humidity_mold_above);

insert into public.platform_thresholds (
  id,
  co2_warning, co2_high, co2_danger,
  lpg_warning, lpg_high, lpg_danger,
  temp_freeze_below, temp_cool_below, temp_heat_above,
  humidity_dry_below, humidity_low_below, humidity_mold_above,
  updated_at
)
values (1, 1000, 2000, 3500, 1000, 2100, 4200, 5, 18, 35, 20, 30, 80, now())
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


-- ============================================================================
-- PART 2 - report_thresholds() / resolve_thresholds()
-- The old LPG fallback was 5000 ppm, so any caller that omitted thresholds
-- scored LPG readings against a limit the device no longer uses.
-- ============================================================================

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
  from public.platform_thresholds p where p.id = 1;

  if v_current is null then
    raise exception 'No threshold configuration found: public.platform_thresholds has no row with id = 1.';
  end if;

  return v_current || jsonb_build_object(
    'threshold_source', 'current',
    'effective_from', to_char(coalesce((select updated_at from public.platform_thresholds where id = 1), now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;


-- ============================================================================
-- PART 3 - repair the three broken report function bodies
--
-- `date + integer` adds DAYS in PostgreSQL, so report_calendar_month and
-- report_month_stats bounded a "month" with a single day and returned one row.
-- report_day_detail also referenced `hum_danger` where the CTE says
-- `humidity_danger`.
--
-- regexp_replace (not replace) because pg_get_functiondef re-formats the body
-- it prints. A miss is a WARNING, never an exception, so a cosmetic fix can
-- never abort the security fixes further down.
-- ============================================================================

do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc
   where oid = to_regprocedure('public.report_calendar_month(date,text,jsonb)');

  if v_def is not null and v_def ~ '\(\s*p_month_start\s*\+\s*1\s*\)\s*::timestamp' then
    v_new := regexp_replace(v_def,
      '\(\(p_month_start\s*\+\s*1\)::timestamp at time zone ''Asia/Manila''\)',
      '(((p_month_start + interval ''1 month'')::date)::timestamp at time zone ''Asia/Manila'')', '');
    if v_new = v_def then
      raise warning 'report_calendar_month: matched but unchanged - repair manually';
    else
      execute v_new;
      raise notice 'report_calendar_month: month bounds repaired';
    end if;
  elsif v_def is null then
    raise warning 'report_calendar_month: not present, skipped';
  else
    raise notice 'report_calendar_month: already correct, skipped';
  end if;

  select pg_get_functiondef(oid) into v_def from pg_proc
   where oid = to_regprocedure('public.report_month_stats(integer,integer,text,jsonb)');

  if v_def is not null and v_def ~ '\(\s*make_date\(p_year, p_month, 1\)\s*\+\s*1\s*\)\s*::timestamp' then
    v_new := regexp_replace(v_def,
      '\(\(make_date\(p_year, p_month, 1\)\s*\+\s*1\)::timestamp at time zone ''Asia/Manila''\)',
      '(((make_date(p_year, p_month, 1) + interval ''1 month'')::date)::timestamp at time zone ''Asia/Manila'')', '');
    if v_new = v_def then
      raise warning 'report_month_stats: matched but unchanged - repair manually';
    else
      execute v_new;
      raise notice 'report_month_stats: month bounds repaired';
    end if;
  elsif v_def is null then
    raise warning 'report_month_stats: not present, skipped';
  else
    raise notice 'report_month_stats: already correct, skipped';
  end if;

  select pg_get_functiondef(oid) into v_def from pg_proc
   where oid = to_regprocedure('public.report_day_detail(date,text,jsonb,integer)');

  if v_def is not null and v_def like '%select hum_danger from stats%' then
    v_new := replace(v_def, 'select hum_danger from stats', 'select humidity_danger from stats');
    if v_new = v_def then
      raise warning 'report_day_detail: hum_danger not replaced - repair manually';
    else
      execute v_new;
      raise notice 'report_day_detail: humidity danger column repaired';
    end if;
  elsif v_def is null then
    raise warning 'report_day_detail: not present, skipped';
  else
    raise notice 'report_day_detail: already correct, skipped';
  end if;
end
$$;


-- ============================================================================
-- PART 4 - revoke PUBLIC from every report_* function
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default and `anon` is an implicit
-- member of it, so `REVOKE ... FROM anon` removed nothing. Your live project
-- also carries report_latest_reading / report_year_months /
-- report_refresh_daily / report_refresh_recent, which no migration creates, so
-- this is done by proname rather than by explicit signature.
-- ============================================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'report\_%'
  loop
    execute format('revoke execute on function %s from public', r.sig);
  end loop;
end
$$;


-- ============================================================================
-- PART 5 - the two access predicates
-- is_active_admin(): role + approved + active.
-- is_approved_account(): approved + active, role-independent.
-- GoTrue knows nothing about profiles.account_status, so sign-in succeeds for a
-- pending self-registered account. Previously only the React login() rejected
-- it - in the same tab as the devtools.
-- ============================================================================

create or replace function public.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()::text
      and p.role = 'admin'
      and p.account_status = 'approved'
      and p.is_active
  );
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
    where p.id = auth.uid()::text
      and p.account_status = 'approved'
      and p.is_active
  );
$$;

revoke all on function public.is_active_admin() from public, anon;
revoke all on function public.is_approved_account() from public, anon;
grant execute on function public.is_active_admin() to authenticated;
grant execute on function public.is_approved_account() to authenticated;


-- ============================================================================
-- PART 6 - RLS on public.rooms and public.readings
--
-- Neither table had RLS at all (both were created outside this repository).
-- The only thing stopping any signed-in account from
--   supabase.from("rooms").update({ siren_muted: true })
-- - silencing a physical gas alarm - was user.role === "admin" in a component.
--
-- readings: anon may INSERT only (the firmware). No UPDATE/DELETE policy exists,
-- so RLS denies both to every non-service role. A safety record is append-only.
-- ============================================================================

alter table public.rooms    enable row level security;
alter table public.readings enable row level security;

drop policy if exists "authenticated can read rooms" on public.rooms;
create policy "authenticated can read rooms"
  on public.rooms for select to authenticated
  using (public.is_approved_account());

drop policy if exists "admins can insert rooms" on public.rooms;
create policy "admins can insert rooms"
  on public.rooms for insert to authenticated
  with check (public.is_active_admin());

drop policy if exists "admins can update rooms" on public.rooms;
create policy "admins can update rooms"
  on public.rooms for update to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

drop policy if exists "admins can delete rooms" on public.rooms;
create policy "admins can delete rooms"
  on public.rooms for delete to authenticated
  using (public.is_active_admin());

drop policy if exists "devices can insert readings" on public.readings;
create policy "devices can insert readings"
  on public.readings for insert to anon, authenticated
  with check (true);

drop policy if exists "authenticated can read readings" on public.readings;
create policy "authenticated can read readings"
  on public.readings for select to authenticated
  using (public.is_approved_account());


-- ============================================================================
-- PART 7 - platform_thresholds: drop the permissive writes, then go admin-only
-- 20260911000000 granted writes to ALL authenticated users, so any signed-in
-- account including pending could rewrite the CO2/LPG alarm limits. Policies OR
-- together, so the old ones must be dropped first.
-- ============================================================================

alter table public.platform_thresholds enable row level security;

drop policy if exists "authenticated can write platform_thresholds" on public.platform_thresholds;
drop policy if exists "authenticated can update platform_thresholds" on public.platform_thresholds;

drop policy if exists "authenticated can read platform_thresholds" on public.platform_thresholds;
create policy "authenticated can read platform_thresholds"
  on public.platform_thresholds for select to authenticated
  using (public.is_approved_account());

drop policy if exists "admins can insert platform_thresholds" on public.platform_thresholds;
create policy "admins can insert platform_thresholds"
  on public.platform_thresholds for insert to authenticated
  with check (public.is_active_admin());

drop policy if exists "admins can update platform_thresholds" on public.platform_thresholds;
create policy "admins can update platform_thresholds"
  on public.platform_thresholds for update to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

drop policy if exists "admins can delete platform_thresholds" on public.platform_thresholds;
create policy "admins can delete platform_thresholds"
  on public.platform_thresholds for delete to authenticated
  using (public.is_active_admin());


-- ============================================================================
-- PART 8 - notifications RLS compared uuid to text
-- notifications.user_id is text; auth.uid() returns uuid. PostgreSQL has no
-- `uuid = text` operator, so every read RAISED and the bell silently showed
-- nothing, with the error swallowed into a console.error.
-- ============================================================================

drop policy if exists "users can read own notifications" on public.notifications;
create policy "users can read own notifications"
  on public.notifications for select to authenticated
  using (auth.uid()::text = user_id);

drop policy if exists "users can update own notifications" on public.notifications;
create policy "users can update own notifications"
  on public.notifications for update to authenticated
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);


-- ============================================================================
-- PART 9 - approval-guarded wrappers for the two RPCs the UI calls
-- SECURITY INVOKER underneath, so the readings policy already applies; these
-- make the requirement explicit at the entry point and return a clear message
-- instead of an empty result set.
-- ============================================================================

create or replace function public.report_day_detail_approved(
  p_day date, p_device_id text default null,
  p_thresholds jsonb default '{}'::jsonb, p_bucket_seconds integer default 300)
returns jsonb
language plpgsql stable
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
  p_year integer, p_month integer,
  p_device_id text default null, p_thresholds jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable
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

grant execute on function public.resolve_thresholds(timestamptz) to authenticated, service_role;
grant execute on function public.report_thresholds(jsonb) to authenticated;


-- ============================================================================
-- PART 10 - realtime
-- Only platform_thresholds was ever published, yet the client subscribes to
-- rooms and notifications too; those subscriptions succeeded and delivered
-- nothing. rooms has no polling fallback, so a device added in another tab
-- never appeared. Safe only now that those tables have real RLS.
-- readings is deliberately NOT published: at a 3s cadence that would push every
-- row of every device to every client, and the 2s latest-row poll covers it.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public' and tablename='platform_thresholds') then
      alter publication supabase_realtime add table public.platform_thresholds;
    end if;
    if not exists (select 1 from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public' and tablename='rooms') then
      alter publication supabase_realtime add table public.rooms;
    end if;
    if not exists (select 1 from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public' and tablename='notifications') then
      alter publication supabase_realtime add table public.notifications;
    end if;
  else
    raise warning 'supabase_realtime publication not found - skipped';
  end if;
end
$$;

notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFICATION - read every value against the "want" note beside it.
-- ============================================================================

-- [want 0] anonymous callers must not be able to run any report_* function
select count(*) as anon_can_execute_report_fn
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'report\_%'
  and has_function_privilege('anon', p.oid, 'EXECUTE');

-- [want > 0] signed-in users must still be able to
select count(*) as authenticated_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'report\_%'
  and has_function_privilege('authenticated', p.oid, 'EXECUTE');

-- [want t, t, t, t] RLS must be on everywhere
select relname, relrowsecurity from pg_class
where relname in ('rooms','readings','notifications','platform_thresholds')
order by relname;

-- [want 31] the calendar must return one row per day, not one
select count(*) as rows_for_january_2026
from report_calendar_month('2026-01-01', null, '{}');

-- [want t, f, f, f] anon may INSERT readings only - never read, update or delete
select
  has_table_privilege('anon','public.readings','INSERT') as anon_can_insert,
  has_table_privilege('anon','public.readings','SELECT') as anon_can_select,
  has_table_privilege('anon','public.readings','UPDATE') as anon_can_update,
  has_table_privilege('anon','public.readings','DELETE') as anon_can_delete;

-- [want 4 rows] the guarded helpers the frontend now calls must exist
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and p.proname in ('report_day_detail_approved','report_month_stats_approved',
                    'is_approved_account','is_active_admin')
order by p.proname;

-- [want 1000/2000/3500, 1000/2100/4200, 5/18/35, 20/30/80]
select * from public.platform_thresholds where id = 1;