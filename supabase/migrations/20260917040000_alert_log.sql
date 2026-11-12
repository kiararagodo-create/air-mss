-- Migration: create alert_log table
--
-- Logs every SMS alert attempt.
-- Cooldown: do not resend the same device + sensor + level within 10 minutes.
-- Escalation (e.g. Danger -> Critical) always sends immediately.
-- sms_status: pending | sent | failed
-- sms_response: provider's error message or "sent" on success.

create table if not exists public.alert_log (
  id bigserial primary key,
  device_id text not null,
  room_id text not null,
  room_name text not null,
  sensor text not null,        -- e.g. "CO2", "LPG", "Temperature", "Humidity"
  level text not null,         -- e.g. "Elevated Gas", "Danger", "Critical"
  created_at timestamptz not null default now(),
  sms_status text not null default 'pending',   -- pending, sent, failed
  sms_response text            -- provider response or error detail
);

-- Index for cooldown lookups: same device + sensor + level within 10 min
create index if not exists alert_log_device_sensor_level_idx
  on public.alert_log (device_id, sensor, level, created_at);

-- Index for querying by room/chronology
create index if not exists alert_log_room_created_idx
  on public.alert_log (room_id, created_at desc);

-- RLS: authenticated (approved) users can read; admins can manage
drop policy if exists "authenticated can read alert_log" on public.alert_log;
create policy "authenticated can read alert_log"
  on public.alert_log
  for select
  to authenticated
  using (public.is_approved_account());

drop policy if exists "admins can manage alert_log" on public.alert_log;
create policy "admins can manage alert_log"
  on public.alert_log
  for all
  to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());