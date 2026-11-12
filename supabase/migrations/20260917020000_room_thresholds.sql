-- Migration: create room_thresholds table
--
-- Per-room threshold overrides. When a room has a row here, the SMS alert
-- function and PDF reports use these values instead of the global
-- platform_thresholds. A NULL value means "use the global default."
-- Every room starts with no override, so the global config applies.

create table if not exists public.room_thresholds (
  id bigserial primary key,
  room_id text not null references public.rooms(id) on delete cascade,
  -- Per-metric thresholds (override global when not NULL).
  co2_warning integer,
  co2_high integer,
  co2_danger integer,
  lpg_warning integer,
  lpg_high integer,
  lpg_danger integer,
  temp_freeze_below integer,
  temp_cool_below integer,
  temp_heat_above integer,
  humidity_dry_below integer,
  humidity_low_below integer,
  humidity_mold_above integer,
  -- Audit / activity.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for fast per-room lookups
create index if not exists room_thresholds_room_id_idx on public.room_thresholds (room_id);

-- RLS: authenticated (approved) users can read; admins can manage
drop policy if exists "authenticated can read room_thresholds" on public.room_thresholds;
create policy "authenticated can read room_thresholds"
  on public.room_thresholds
  for select
  to authenticated
  using (public.is_approved_account());

drop policy if exists "admins can manage room_thresholds" on public.room_thresholds;
create policy "admins can manage room_thresholds"
  on public.room_thresholds
  for all
  to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());