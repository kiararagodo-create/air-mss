-- Migration: save ALL readings (normal + danger), add status column, throttle
-- normal readings to once per 60s per device, and make retention configurable.
--
-- Run this in the Supabase SQL Editor. It is idempotent (if not exists / or replace).

-- ---------------------------------------------------------------------------
-- 1. Status column on readings
-- ---------------------------------------------------------------------------
alter table public.readings
  add column if not exists status text not null default 'danger';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'readings_status_check' and conrelid = 'public.readings'::regclass
  ) then
    alter table public.readings
      add constraint readings_status_check
      check (status in ('normal', 'warning', 'high', 'danger'));
  end if;
end $$;

-- Backfill: every pre-existing row is treated as danger (per rollout instruction).
update public.readings set status = 'danger' where status is null;

-- ---------------------------------------------------------------------------
-- 2. Threshold resolution helper (room override -> global platform thresholds)
-- ---------------------------------------------------------------------------
create or replace function public.resolve_reading_thresholds(p_device_id text)
returns table (
  co2_warning int, co2_high int, co2_danger int,
  lpg_warning int, lpg_high int, lpg_danger int,
  temp_freeze_below int, temp_heat_above int,
  humidity_dry_below int, humidity_mold_above int
)
language sql stable as $$
  select
    coalesce(rt.co2_warning,  pt.co2_warning)  as co2_warning,
    coalesce(rt.co2_high,     pt.co2_high)     as co2_high,
    coalesce(rt.co2_danger,   pt.co2_danger)   as co2_danger,
    coalesce(rt.lpg_warning,  pt.lpg_warning)  as lpg_warning,
    coalesce(rt.lpg_high,     pt.lpg_high)     as lpg_high,
    coalesce(rt.lpg_danger,   pt.lpg_danger)   as lpg_danger,
    coalesce(rt.temp_freeze_below, pt.temp_freeze_below) as temp_freeze_below,
    coalesce(rt.temp_heat_above,   pt.temp_heat_above)   as temp_heat_above,
    coalesce(rt.humidity_dry_below, pt.humidity_dry_below) as humidity_dry_below,
    coalesce(rt.humidity_mold_above, pt.humidity_mold_above) as humidity_mold_above
  from public.platform_thresholds pt
  left join public.room_thresholds rt
    on rt.room_id = p_device_id and rt.active = true
  where pt.id = 1
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 3. Status computation
-- ---------------------------------------------------------------------------
create or replace function public.compute_reading_status(
  p_device_id text,
  p_co2 numeric, p_lpg numeric, p_temp numeric, p_humidity numeric
) returns text
language plpgsql stable as $$
declare
  t record;
begin
  select * into t from public.resolve_reading_thresholds(p_device_id);
  if t is null then
    return 'normal';
  end if;

  -- CO2
  if p_co2 is not null then
    if p_co2 >= t.co2_danger then return 'danger'; end if;
    if p_co2 >= t.co2_high    then return 'high';    end if;
    if p_co2 >= t.co2_warning then return 'warning'; end if;
  end if;
  -- LPG
  if p_lpg is not null then
    if p_lpg >= t.lpg_danger then return 'danger'; end if;
    if p_lpg >= t.lpg_high    then return 'high';    end if;
    if p_lpg >= t.lpg_warning then return 'warning'; end if;
  end if;
  -- Temperature
  if p_temp is not null then
    if p_temp < t.temp_freeze_below or p_temp > t.temp_heat_above then return 'danger'; end if;
  end if;
  -- Humidity
  if p_humidity is not null then
    if p_humidity < t.humidity_dry_below or p_humidity > t.humidity_mold_above then return 'danger'; end if;
  end if;

  return 'normal';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Config tables (throttle interval + retention days)
-- ---------------------------------------------------------------------------
create table if not exists public.reading_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
insert into public.reading_config (key, value)
values ('normal_interval_seconds', '60')
on conflict (key) do nothing;

create table if not exists public.retention_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
insert into public.retention_config (key, value)
values ('retention_days', '35')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 5. BEFORE INSERT trigger: set status + throttle normal readings
-- ---------------------------------------------------------------------------
create or replace function public.readings_before_insert()
returns trigger
language plpgsql as $$
declare
  v_status text;
  v_interval int;
  v_last timestamptz;
begin
  if new.created_at is null then
    new.created_at := now();
  end if;

  v_status := public.compute_reading_status(new.device_id, new.co2, new.lpg, new.temp, new.humidity);
  new.status := v_status;

  -- Throttle: normal readings at most once per configured interval per device.
  if v_status = 'normal' then
    select coalesce((select value::int from public.reading_config where key = 'normal_interval_seconds'), 60)
      into v_interval;
    select max(created_at) into v_last
      from public.readings where device_id = new.device_id and status = 'normal';
    if v_last is not null and new.created_at - v_last < make_interval(secs => v_interval) then
      -- Skip this insert (silent) to avoid flooding the database.
      return null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists readings_before_insert on public.readings;
create trigger readings_before_insert
  before insert on public.readings
  for each row execute function public.readings_before_insert();

-- Keep status fresh on update.
create or replace function public.readings_before_update()
returns trigger
language plpgsql as $$
begin
  new.status := public.compute_reading_status(new.device_id, new.co2, new.lpg, new.temp, new.humidity);
  return new;
end;
$$;

drop trigger if exists readings_before_update on public.readings;
create trigger readings_before_update
  before update on public.readings
  for each row execute function public.readings_before_update();

-- ---------------------------------------------------------------------------
-- 6. Indexes
-- ---------------------------------------------------------------------------
create index if not exists readings_device_created_idx
  on public.readings (device_id, created_at);
create index if not exists readings_status_idx
  on public.readings (status);

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------
-- * Alarms/SMS still fire only for non-normal readings: the air-alerts edge
--   function is unchanged and continues to evaluate thresholds; this migration
--   only changes what gets persisted. The Notifications page keeps showing
--   alerts only.
-- * Retention: existing archive-based retention is untouched. The new
--   retention_config.retention_days (default 35) is provided for a configurable
--   cleanup window; wire it into the cleanup job if/when desired. Proposing 35
--   days so a full month of reports remains queryable.
-- * Storage impact estimate: throttling normal readings to 1/min/device means
--   ~1440 rows/device/day (~0.15 MB/device/day at ~100 bytes/row) instead of
--   one row per sensor sample. A 3-device deployment for 35 days is roughly
--   15 MB of raw readings plus indexes; danger/warning rows are additional but
--   comparatively small.
-- Configurable retention cleanup (default 35 days).
create or replace function public.cleanup_old_readings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days int;
  v_cutoff timestamptz;
  v_deleted int;
begin
  select coalesce((select value::int from public.retention_config where key = 'retention_days'), 35)
    into v_days;
  v_cutoff := now() - make_interval(days => v_days);
  delete from public.readings where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Optional daily schedule (requires pg_cron). Uncomment if desired:
-- select cron.schedule('cleanup-old-readings', '0 3 * * *', 'select public.cleanup_old_readings()');

notify pgrst, 'reload schema';
