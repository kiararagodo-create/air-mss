-- Migration: thresholds table for persistent safety-limit configuration.
--
-- The Settings page lets admins adjust CO2 / LPG / DHT22 temp / DHT22 humidity
-- safety tiers. Previously these lived only in React state and reset to the
-- DEFAULT_THRESHOLDS on every page reload. This table makes them permanent:
-- the RoomsContext loads them on startup and writes them back on save.

create table if not exists public.platform_thresholds (
  id          integer primary key default 1,
  -- Single canonical row (id = 1) - one global config for the whole platform.
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

-- Only one row is ever meaningful (the global platform config).
create unique index if not exists platform_thresholds_single_row
  on public.platform_thresholds (id);

alter table public.platform_thresholds enable row level security;

-- Authenticated admins can read/write the global thresholds.
drop policy if exists "authenticated can read platform_thresholds" on public.platform_thresholds;
create policy "authenticated can read platform_thresholds"
  on public.platform_thresholds
  for select
  to authenticated
  using (true);

drop policy if exists "authenticated can write platform_thresholds" on public.platform_thresholds;
create policy "authenticated can write platform_thresholds"
  on public.platform_thresholds
  for insert
  to authenticated
  with check (true);

drop policy if exists "authenticated can update platform_thresholds" on public.platform_thresholds;
create policy "authenticated can update platform_thresholds"
  on public.platform_thresholds
  for update
  to authenticated
  using (true)
  with check (true);