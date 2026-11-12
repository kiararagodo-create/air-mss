-- Migration: make alarm SMS fully automatic.
-- Fires the air-alerts edge function on every new reading via pg_net.
-- Run in Supabase SQL Editor. Requires pg_net extension.

create extension if not exists pg_net;

-- Store the project's anon key (public) so the gateway accepts the call.
-- Replace the placeholder value below with your project's anon key.
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
insert into public.app_config (key, value)
values ('anon_key', 'REPLACE_WITH_PROJECT_ANON_KEY')
on conflict (key) do nothing;

create or replace function public.notify_air_alerts_on_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := 'https://zxoeqazpatujesgotswd.supabase.co/functions/v1/air-alerts';
  v_anon text;
begin
  select value into v_anon from public.app_config where key = 'anon_key';
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
end $$;

drop trigger if exists readings_air_alerts_webhook on public.readings;
create trigger readings_air_alerts_webhook
  after insert on public.readings
  for each row
  execute function public.notify_air_alerts_on_reading();

-- Spam prevention, cooldown (10 min default) and escalation are handled inside
-- the air-alerts edge function (upsertNotification + sms_logs cooldown check).
-- Invalid sensor readings are skipped by isQualityReading in _shared/air_alerts.ts.
-- Every SMS attempt is logged in public.sms_logs (recipient, status, error).

notify pgrst, 'reload schema';
