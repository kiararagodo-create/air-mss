-- Migration: incident-based SMS dedupe + global safety caps + credit guard config.
--
-- Replaces per-reading SMS spam with one SMS per incident per device, with
-- DB-enforced single open incident per device, configurable caps/reminder
-- settings, and low-credit support.

alter table public.sms_alert_settings
  add column if not exists reminder_minutes int not null default 60
    check (reminder_minutes between 5 and 1440),
  add column if not exists close_after_minutes int not null default 10
    check (close_after_minutes between 1 and 1440),
  add column if not exists max_sms_per_hour int not null default 5
    check (max_sms_per_hour between 1 and 1000),
  add column if not exists max_sms_per_day int not null default 20
    check (max_sms_per_day between 1 and 10000),
  add column if not exists low_credit_threshold int not null default 20
    check (low_credit_threshold between 0 and 100000);

-- One open incident per device, enforced in the database.
create table if not exists public.air_sms_incidents (
  id bigserial primary key,
  device_id text not null,
  room_name text not null default '',
  floor text not null default '',
  severity text not null,
  level_label text not null default '',
  status text not null default 'open'
    check (status in ('open', 'closed')),
  started_at timestamptz not null default now(),
  last_abnormal_at timestamptz not null default now(),
  last_sms_at timestamptz,
  reminder_sent_at timestamptz,
  acknowledged boolean not null default false,
  closed_at timestamptz,
  close_reason text
);

create unique index if not exists air_sms_incidents_one_open_per_device
  on public.air_sms_incidents (device_id) where status = 'open';

create index if not exists air_sms_incidents_device_idx
  on public.air_sms_incidents (device_id, started_at desc);

alter table public.air_sms_incidents enable row level security;

drop policy if exists "admins read air_sms_incidents" on public.air_sms_incidents;
create policy "admins read air_sms_incidents"
  on public.air_sms_incidents for select to authenticated
  using (public.is_active_admin());

drop policy if exists "service role full air_sms_incidents" on public.air_sms_incidents;
create policy "service role full air_sms_incidents"
  on public.air_sms_incidents for all to service_role
  using (true) with check (true);

notify pgrst, 'reload schema';
