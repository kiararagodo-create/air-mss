-- Migration: automatic SMS alert quality/escalation support (additive).
-- Adds escalation tracking to air_notifications and a small SMS alert settings table.

alter table public.air_notifications
  add column if not exists escalated_at timestamptz;

create table if not exists public.sms_alert_settings (
  id int primary key default 1 check (id = 1),
  automatic_sms boolean not null default true,
  min_severity text not null default 'warning'
    check (min_severity in ('warning', 'danger')),
  updated_at timestamptz not null default now()
);

insert into public.sms_alert_settings (id) values (1)
on conflict (id) do nothing;

alter table public.sms_alert_settings enable row level security;

drop policy if exists "admins manage sms_alert_settings" on public.sms_alert_settings;
create policy "admins manage sms_alert_settings"
  on public.sms_alert_settings for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

drop policy if exists "approved read sms_alert_settings" on public.sms_alert_settings;
create policy "approved read sms_alert_settings"
  on public.sms_alert_settings for select to authenticated
  using (public.is_approved_account());

drop policy if exists "service role full sms_alert_settings" on public.sms_alert_settings;
create policy "service role full sms_alert_settings"
  on public.sms_alert_settings for all to service_role
  using (true) with check (true);

notify pgrst, 'reload schema';
