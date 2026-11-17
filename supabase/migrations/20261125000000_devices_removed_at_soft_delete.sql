-- Migration: add removed_at timestamp to devices table for soft-delete audit tracking
--
-- The `active` boolean on public.devices already exists (added by
-- 20260917010000_devices_table.sql) and defaults to true. This migration
-- adds a `removed_at` timestamp so we can record when a device was soft-deleted,
-- without ever deleting the row or its historical readings/alerts.
--
-- NOTE: This column is added ONLY to public.devices, not to public.rooms.
-- Device removal operates on individual device records; rooms remain intact
-- even when all their devices are removed.

alter table public.devices
  add column if not exists removed_at timestamptz;

-- RLS: authenticated users can read the new column (inherits existing select policy).
-- Admins can update it (inherits existing update policy).
