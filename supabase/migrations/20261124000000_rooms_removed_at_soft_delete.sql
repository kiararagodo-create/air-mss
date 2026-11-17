-- Migration: add removed_at timestamp to rooms for soft-delete audit tracking
--
-- The `active` boolean on public.rooms already exists (added by
-- 20260917000000_rooms_type_active.sql) and defaults to true. This migration
-- adds a `removed_at` timestamp so we can record when a device was soft-deleted,
-- without ever deleting the row or its historical readings/alerts.

alter table public.rooms
  add column if not exists removed_at timestamptz;

-- Also track removal on the devices table for consistency.
alter table public.devices
  add column if not exists removed_at timestamptz;

-- RLS: authenticated users can read the new column (inherits existing select policy).
-- Admins can update it (inherits existing update policy).
