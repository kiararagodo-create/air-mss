-- Migration: ensure removed_at exists on public.devices and public.rooms,
-- add supporting indexes, and reload the PostgREST schema cache.
--
-- This fixes PGRST204 "Could not find the 'removed_at' column of 'devices'
-- in the schema cache" by adding the column (idempotently) and telling
-- PostgREST to reload its schema cache so the column is recognized.
--
-- Historical readings and alert history are never touched. The column is
-- writeable by admins via the existing "admins can manage/update" RLS
-- policies (see 20260917010000_devices_table.sql and
-- 20260917000000_rooms_type_active.sql).

-- Ensure the column exists on both tables (idempotent).
alter table public.devices
  add column if not exists removed_at timestamptz;

alter table public.rooms
  add column if not exists removed_at timestamptz;

-- Index so queries filtering on removed_at (e.g. .is("removed_at", null))
-- and the rejection trigger lookup stay fast as the table grows.
create index if not exists idx_devices_removed_at on public.devices (removed_at);
create index if not exists idx_rooms_removed_at on public.rooms (removed_at);

-- RLS: authenticated users can read the column (inherits existing select policy);
-- admins can UPDATE it (inherits existing update policy). No new policy needed.

-- Reload PostgREST schema cache so the new column is recognized immediately.
notify pgrst, 'reload schema';
