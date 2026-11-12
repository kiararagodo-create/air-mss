-- Migration: create devices table
--
-- Tracks ESP32 device IDs and their room assignment.
-- device_id is the ESP32's unique ID (matches rooms.id and readings.device_id).
-- room_id links to the rooms table for room assignment.
-- active flag indicates the device is currently monitored / online.

create table if not exists public.devices (
  device_id text primary key,
  room_id text not null references public.rooms(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for fast room-to-device lookups
create index if not exists devices_room_id_idx on public.devices (room_id);

-- Index for device existence checks
create index if not exists devices_device_id_idx on public.devices (device_id);

-- RLS: authenticated (approved) users can read; admins can manage
drop policy if exists "authenticated can read devices" on public.devices;
create policy "authenticated can read devices"
  on public.devices
  for select
  to authenticated
  using (public.is_approved_account());

drop policy if exists "admins can manage devices" on public.devices;
create policy "admins can manage devices"
  on public.devices
  for all
  to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

-- Migrate existing data: every room that has an id becomes a device entry.
-- This preserves the existing room->device mapping without losing history.
-- Readings.device_id already points to rooms.id, so this links them explicitly.
insert into public.devices (device_id, room_id, active)
select id, id, active from public.rooms
where not exists (
  select 1 from public.devices d where d.device_id = public.rooms.id
);