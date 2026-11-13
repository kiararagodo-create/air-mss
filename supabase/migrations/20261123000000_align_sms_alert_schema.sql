-- 20261123000000_align_sms_alert_schema.sql
-- Idempotent production alignment for SMS/alert schema expected by Edge Functions:
-- air-alerts, send-sms, check-offline (+ _shared helpers) and frontend.
-- Safe to run on existing production data.

begin;

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- app_config: webhook/cron config. Keep key/value schema and compat with id-based rows.
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  key text primary key,
  value text not null
);

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_config' and column_name = 'id'
  ) then
    alter table public.app_config add column id integer;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_config' and column_name = 'anon_key'
  ) then
    alter table public.app_config add column anon_key text;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_config' and column_name = 'project_url'
  ) then
    alter table public.app_config add column project_url text;
  end if;
end $$;

create unique index if not exists app_config_id_uidx on public.app_config(id) where id is not null;

-- Canonical anon key row (value may be placeholder until admin sets it)
insert into public.app_config(key, value)
values ('anon_key', 'REPLACE_WITH_PROJECT_ANON_KEY')
on conflict (key) do nothing;

update public.app_config c
set anon_key = coalesce(nullif(c.anon_key, ''), nullif(c.value, ''))
where c.key = 'anon_key';

-- Compatibility row for migrations/functions that read "where id = 1"
insert into public.app_config(key, value, id, anon_key)
select 'app_config_row_1', coalesce(a.value, 'REPLACE_WITH_PROJECT_ANON_KEY'), 1, coalesce(a.anon_key, a.value, 'REPLACE_WITH_PROJECT_ANON_KEY')
from public.app_config a
where a.key = 'anon_key'
on conflict (key) do update set
  id = excluded.id,
  anon_key = coalesce(excluded.anon_key, public.app_config.anon_key),
  value = coalesce(excluded.value, public.app_config.value);

-- ---------------------------------------------------------------------------
-- profiles: SMS/recipient fields expected by app and edge functions
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists sms_enabled boolean;
update public.profiles set sms_enabled = true where sms_enabled is null;
alter table public.profiles alter column sms_enabled set default true;
alter table public.profiles alter column sms_enabled set not null;

alter table public.profiles add column if not exists sms_min_severity text;
update public.profiles
set sms_min_severity = case
  when sms_min_severity in ('warning', 'danger') then sms_min_severity
  else 'warning'
end
where sms_min_severity is null or sms_min_severity not in ('warning', 'danger');
alter table public.profiles alter column sms_min_severity set default 'warning';
alter table public.profiles alter column sms_min_severity set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_sms_min_severity_check') then
    alter table public.profiles
      add constraint profiles_sms_min_severity_check
      check (sms_min_severity in ('warning', 'danger'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sms_alert_settings: full set used by air-alerts
-- ---------------------------------------------------------------------------
create table if not exists public.sms_alert_settings (
  id integer primary key default 1 check (id = 1),
  automatic_sms boolean not null default true,
  min_severity text not null default 'warning',
  reminder_minutes integer not null default 60,
  close_after_minutes integer not null default 10,
  max_sms_per_hour integer not null default 5,
  max_sms_per_day integer not null default 20,
  low_credit_threshold integer not null default 20,
  updated_at timestamptz not null default now()
);

alter table public.sms_alert_settings add column if not exists automatic_sms boolean;
alter table public.sms_alert_settings add column if not exists min_severity text;
alter table public.sms_alert_settings add column if not exists reminder_minutes integer;
alter table public.sms_alert_settings add column if not exists close_after_minutes integer;
alter table public.sms_alert_settings add column if not exists max_sms_per_hour integer;
alter table public.sms_alert_settings add column if not exists max_sms_per_day integer;
alter table public.sms_alert_settings add column if not exists low_credit_threshold integer;
alter table public.sms_alert_settings add column if not exists updated_at timestamptz;

update public.sms_alert_settings
set
  automatic_sms = coalesce(automatic_sms, true),
  min_severity = case when min_severity in ('warning','danger') then min_severity else 'warning' end,
  reminder_minutes = coalesce(reminder_minutes, 60),
  close_after_minutes = coalesce(close_after_minutes, 10),
  max_sms_per_hour = coalesce(max_sms_per_hour, 5),
  max_sms_per_day = coalesce(max_sms_per_day, 20),
  low_credit_threshold = coalesce(low_credit_threshold, 20),
  updated_at = coalesce(updated_at, now())
where id = 1;

alter table public.sms_alert_settings alter column automatic_sms set default true;
alter table public.sms_alert_settings alter column min_severity set default 'warning';
alter table public.sms_alert_settings alter column reminder_minutes set default 60;
alter table public.sms_alert_settings alter column close_after_minutes set default 10;
alter table public.sms_alert_settings alter column max_sms_per_hour set default 5;
alter table public.sms_alert_settings alter column max_sms_per_day set default 20;
alter table public.sms_alert_settings alter column low_credit_threshold set default 20;
alter table public.sms_alert_settings alter column updated_at set default now();

insert into public.sms_alert_settings(id) values (1) on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_alert_settings_min_severity_check') then
    alter table public.sms_alert_settings add constraint sms_alert_settings_min_severity_check check (min_severity in ('warning','danger'));
  end if;
exception when duplicate_object then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sms_alert_settings_reminder_minutes_check') then
    alter table public.sms_alert_settings add constraint sms_alert_settings_reminder_minutes_check check (reminder_minutes between 5 and 1440);
  end if;
exception when duplicate_object then null; end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sms_alert_settings_close_after_minutes_check') then
    alter table public.sms_alert_settings add constraint sms_alert_settings_close_after_minutes_check check (close_after_minutes between 1 and 1440);
  end if;
exception when duplicate_object then null; end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sms_alert_settings_max_sms_per_hour_check') then
    alter table public.sms_alert_settings add constraint sms_alert_settings_max_sms_per_hour_check check (max_sms_per_hour between 1 and 1000);
  end if;
exception when duplicate_object then null; end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sms_alert_settings_max_sms_per_day_check') then
    alter table public.sms_alert_settings add constraint sms_alert_settings_max_sms_per_day_check check (max_sms_per_day between 1 and 10000);
  end if;
exception when duplicate_object then null; end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sms_alert_settings_low_credit_threshold_check') then
    alter table public.sms_alert_settings add constraint sms_alert_settings_low_credit_threshold_check check (low_credit_threshold between 0 and 100000);
  end if;
exception when duplicate_object then null; end $$;

alter table public.sms_alert_settings enable row level security;
drop policy if exists "admins manage sms_alert_settings" on public.sms_alert_settings;
create policy "admins manage sms_alert_settings"
  on public.sms_alert_settings for all to authenticated
  using (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.role='admin' and p.account_status='approved' and p.is_active))
  with check (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.role='admin' and p.account_status='approved' and p.is_active));
drop policy if exists "approved read sms_alert_settings" on public.sms_alert_settings;
create policy "approved read sms_alert_settings"
  on public.sms_alert_settings for select to authenticated
  using (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.is_active and (p.role='admin' or p.account_status='approved')));
drop policy if exists "service role full sms_alert_settings" on public.sms_alert_settings;
create policy "service role full sms_alert_settings"
  on public.sms_alert_settings for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- air_notifications: columns used by edge functions / UI timelines
-- ---------------------------------------------------------------------------
create table if not exists public.air_notifications (
  id            bigserial primary key,
  device_id     text        not null,
  room_name     text        not null default '',
  floor         text        not null default '',
  sensor_type   text        not null,
  level_label   text        not null,
  severity      text        not null default 'warning',
  reading_value numeric,
  reading_unit  text        not null default '',
  message       text        not null default '',
  status        text        not null default 'open',
  handled_by_name text,
  handled_by_role text,
  handled_at    timestamptz,
  escalation_of bigint references public.air_notifications(id) on delete set null,
  resolution_note text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
alter table public.air_notifications add column if not exists escalated_at timestamptz;
alter table public.air_notifications add column if not exists escalation_of bigint;
alter table public.air_notifications add column if not exists resolution_note text;
alter table public.air_notifications add column if not exists handled_by_name text;
alter table public.air_notifications add column if not exists handled_by_role text;
alter table public.air_notifications add column if not exists handled_at timestamptz;

-- Ensure partial unique dedupe index exists (open per device+sensor+level)
create unique index if not exists air_notifications_one_open_per_device_sensor_level
  on public.air_notifications (device_id, sensor_type, level_label)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- notification_recipients / notification_actions / notification_reads / sms_logs
-- (create if missing for fresh/partial envs; additive columns below)
-- ---------------------------------------------------------------------------
create table if not exists public.notification_recipients (
  id            bigserial primary key,
  notification_id bigint not null references public.air_notifications(id) on delete cascade,
  personnel_id  uuid references public.profiles(id) on delete set null,
  personnel_name text not null default '',
  personnel_role text not null default '',
  phone         text,
  action_token  text not null,
  expires_at    timestamptz not null default (now() + interval '7 days'),
  created_at    timestamptz not null default now(),
  unique (notification_id, personnel_id)
);
create unique index if not exists notification_recipients_token_idx on public.notification_recipients(action_token);
create index if not exists notification_recipients_notification_idx on public.notification_recipients(notification_id);
create index if not exists notification_recipients_personnel_idx on public.notification_recipients(personnel_id);

create table if not exists public.notification_actions (
  id              bigserial primary key,
  notification_id bigint not null references public.air_notifications(id) on delete cascade,
  personnel_id    uuid references public.profiles(id) on delete set null,
  personnel_name  text not null default '',
  personnel_role  text not null default '',
  action          text not null,
  note            text,
  taken_at        timestamptz not null default now()
);
create index if not exists notification_actions_notification_idx on public.notification_actions(notification_id, taken_at desc);

create table if not exists public.notification_reads (
  notification_id bigint not null references public.air_notifications(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

create table if not exists public.sms_logs (
  id              bigserial primary key,
  notification_id bigint references public.air_notifications(id) on delete set null,
  personnel_id    uuid references public.profiles(id) on delete set null,
  recipient_name  text not null default '',
  recipient_role  text not null default '',
  phone           text,
  message         text not null default '',
  status          text not null default 'submitted',
  provider_response text,
  sent_at         timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

alter table public.sms_logs add column if not exists provider text;
alter table public.sms_logs add column if not exists provider_message_id text;
alter table public.sms_logs add column if not exists provider_status text;
alter table public.sms_logs add column if not exists send_mode text;
alter table public.sms_logs add column if not exists is_auto boolean;
alter table public.sms_logs add column if not exists notification_id bigint;
alter table public.sms_logs add column if not exists personnel_id uuid;
alter table public.sms_logs add column if not exists recipient_name text;
alter table public.sms_logs add column if not exists recipient_role text;
alter table public.sms_logs add column if not exists phone text;
alter table public.sms_logs add column if not exists provider_response text;
alter table public.sms_logs add column if not exists sent_at timestamptz;
alter table public.sms_logs add column if not exists created_at timestamptz;

update public.sms_logs
set
  send_mode = case
    when send_mode in ('auto','manual') then send_mode
    when coalesce(is_auto, false) then 'auto'
    else 'manual'
  end,
  is_auto = case
    when is_auto is not null then is_auto
    when send_mode = 'auto' then true
    else false
  end,
  recipient_name = coalesce(recipient_name, ''),
  recipient_role = coalesce(recipient_role, ''),
  message = coalesce(message, ''),
  status = coalesce(status, 'failed'),
  sent_at = coalesce(sent_at, created_at, now()),
  created_at = coalesce(created_at, sent_at, now()),
  provider_status = coalesce(provider_status, status);

alter table public.sms_logs alter column send_mode set default 'manual';
alter table public.sms_logs alter column is_auto set default false;
alter table public.sms_logs alter column recipient_name set default '';
alter table public.sms_logs alter column recipient_role set default '';
alter table public.sms_logs alter column message set default '';
alter table public.sms_logs alter column status set default 'failed';

alter table public.sms_logs drop constraint if exists sms_logs_status_check;
alter table public.sms_logs add constraint sms_logs_status_check
  check (status in (
    'submitted','in_progress','failed','invalid_number',
    'skipped_no_number','skipped_dry_run','skipped_low_credits','skipped_rate_limited',
    'skipped_no_recipients','skipped_open_incident','skipped_quality',
    'skipped_acknowledged','skipped_invalid_number','skipped_disabled',
    'skipped_cooldown','sent'
  ));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_logs_send_mode_check') then
    alter table public.sms_logs add constraint sms_logs_send_mode_check check (send_mode in ('auto','manual'));
  end if;
exception when duplicate_object then null; end $$;

create index if not exists sms_logs_notification_idx on public.sms_logs (notification_id, sent_at desc);
create index if not exists sms_logs_status_idx on public.sms_logs (status);
create index if not exists sms_logs_sent_at_idx on public.sms_logs (sent_at desc);
create index if not exists sms_logs_provider_idx on public.sms_logs (provider);
create index if not exists sms_logs_send_mode_idx on public.sms_logs (send_mode);
create index if not exists sms_logs_is_auto_idx on public.sms_logs (is_auto);

-- ---------------------------------------------------------------------------
-- Webhook trigger: readings INSERT -> air-alerts edge function (DB-driven, no dashboard needed)
-- Uses app_config(key='anon_key').value/anon_key and current project URL from
-- app_config(key='project_url') when present, else existing hardcoded URL fallback.
-- ---------------------------------------------------------------------------
create or replace function public.notify_air_alerts_on_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_anon text;
begin
  select coalesce(nullif(value,''), nullif(anon_key,''))
    into v_anon
  from public.app_config
  where key = 'anon_key'
  limit 1;

  select nullif(value,'') into v_url
  from public.app_config
  where key = 'project_url'
  limit 1;

  if v_url is null or btrim(v_url) = '' then
    v_url := 'https://zxoeqazpatujesgotswd.supabase.co/functions/v1/air-alerts';
  else
    v_url := rtrim(v_url, '/') || '/functions/v1/air-alerts';
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', coalesce(v_anon, ''),
      'Authorization', 'Bearer ' || coalesce(v_anon, '')
    ),
    body := jsonb_build_object('record', to_jsonb(new))
  );
  return new;
exception when others then
  raise notice 'notify_air_alerts_on_reading failed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists readings_air_alerts_webhook on public.readings;
create trigger readings_air_alerts_webhook
  after insert on public.readings
  for each row
  execute function public.notify_air_alerts_on_reading();

notify pgrst, 'reload schema';
commit;
