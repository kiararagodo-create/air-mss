-- ============================================================================
-- A.I.R. - resume block
-- PART 6 (predicates) + PART 7 (RLS on rooms/readings) + PART 8
-- (platform_thresholds), plus the table PART 8 needs.
--
-- Why this exists: PASTE-IN-SUPABASE.sql reached PART 7 without
-- public.is_approved_account() / public.is_active_admin() existing, because an
-- earlier statement in that run raised and the Supabase editor rolled the whole
-- batch back. PART 7 and PART 8 policies reference those two functions, so
-- they cannot be applied on their own.
--
-- This block is order-independent and safe to paste more than once:
--   * the two predicates are create-or-replace, so it repairs or keeps them
--   * the precondition is asserted AFTER the definitions, never before
--   * every policy is dropped before it is created
--
-- profiles.id is uuid on this project (the earlier run assumed text and raised
-- 42883 "operator does not exist: uuid = text"). Both predicates now cast the
-- column instead of auth.uid(), so they are correct for uuid and text alike.
-- ============================================================================


-- ============================================================================
-- PART 6 - prerequisites: the tables the policies below attach to
--
-- platform_thresholds did not exist on the live project (20260911000000 was
-- never applied) and PART 8 does `alter table` on it, so without this the
-- whole batch aborts on 42P01 again. create ... if not exists: a no-op when
-- PART 1 of PASTE-IN-SUPABASE.sql already created it. The single row is seeded
-- below, because an empty table silently disables every SQL report function.
-- ============================================================================

create table if not exists public.platform_thresholds (
  id          integer primary key default 1,
  co2_warning integer not null,
  co2_high    integer not null,
  co2_danger  integer not null,
  lpg_warning integer not null,
  lpg_high    integer not null,
  lpg_danger  integer not null,
  temp_freeze_below integer not null,
  temp_cool_below   integer not null,
  temp_heat_above   integer not null,
  humidity_dry_below   integer not null,
  humidity_low_below   integer not null,
  humidity_mold_above  integer not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists platform_thresholds_single_row
  on public.platform_thresholds (id);

-- Seed the single configuration row, but ONLY when it is absent: the values
-- below are the same ones DEFAULT_THRESHOLDS uses in src/data/Data.ts, and an
-- admin's saved edits must never be overwritten by re-running this script.
-- do nothing, not do update - a paste must not silently retune the platform's
-- safety limits. Without this row the dashboard falls back to its built-in
-- defaults while every SQL report function raises 'No threshold configuration
-- found'.
insert into public.platform_thresholds (
  id,
  co2_warning, co2_high, co2_danger,
  lpg_warning, lpg_high, lpg_danger,
  temp_freeze_below, temp_cool_below, temp_heat_above,
  humidity_dry_below, humidity_low_below, humidity_mold_above,
  updated_at
)
values (1, 1000, 2000, 3500, 1000, 2100, 4200, 5, 18, 35, 20, 30, 80, now())
on conflict (id) do nothing;


-- ============================================================================
-- PART 6 - the two access predicates
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
    -- p.id::text, not auth.uid()::text: on this project profiles.id is uuid, and
    -- PostgreSQL has no uuid = text operator (42883). Casting the column works
    -- whether profiles.id is uuid or text, so this script is type-agnostic.
    where p.id::text = auth.uid()::text
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
    -- p.id::text, not auth.uid()::text: on this project profiles.id is uuid, and
    -- PostgreSQL has no uuid = text operator (42883). Casting the column works
    -- whether profiles.id is uuid or text, so this script is type-agnostic.
    where p.id::text = auth.uid()::text
      and p.account_status = 'approved'
      and p.is_active
  );
$$;

revoke all on function public.is_active_admin() from public, anon;
revoke all on function public.is_approved_account() from public, anon;
grant execute on function public.is_active_admin() to authenticated;
grant execute on function public.is_approved_account() to authenticated;


-- precondition - now safe to check, the functions above are in place
do $check$
begin
  if to_regprocedure('public.is_approved_account()') is null
     or to_regprocedure('public.is_active_admin()') is null then
    raise exception 'precondition failed: is_approved_account() and is_active_admin() must exist before the RLS policies below';
  end if;
end
$check$;


-- ============================================================================
-- PART 7 - RLS on public.rooms and public.readings
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
-- PART 8 - platform_thresholds: drop the permissive writes, then go admin-only
-- The original policies granted write to ALL authenticated users, so any
-- signed-in account including pending could rewrite the CO2/LPG alarm limits.
-- Policies OR together, so the old ones must be dropped first.
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
-- VERIFICATION
-- [want uuid]        profiles.id - the type behind the 42883
-- [want 2 rows]      both predicates exist, is_active_admin first
-- [want t, t, t]     RLS on for all three tables
-- ============================================================================

-- [want uuid] the type that caused 42883 below; the predicates cast the column
-- so they work either way
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'id';

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_approved_account','is_active_admin')
order by p.proname;

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('rooms','readings','platform_thresholds')
order by relname;

select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('rooms','readings','platform_thresholds')
order by tablename, cmd, policyname;
