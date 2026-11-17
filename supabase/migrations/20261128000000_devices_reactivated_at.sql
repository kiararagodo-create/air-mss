-- Migration: add reactivated_at timestamp to devices table
--
-- reactivated_at records when a soft-removed device was last brought back
-- (active = true, removed_at = NULL via addRoom reactivation). It is used by
-- the offline sweep and the dashboard's online/offline logic so that a device
-- just re-registered does not immediately trip a stale-reading offline alert
-- based on an old readings.created_at.
--
-- Historical readings and alert history are never touched.

alter table public.devices
  add column if not exists reactivated_at timestamptz;

notify pgrst, 'reload schema';
