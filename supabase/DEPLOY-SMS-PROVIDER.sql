-- Migration: provider-pluggable SMS (sms_logs gains provider columns).
--
-- The send-sms / air-alerts / send-sms-alert functions now route every send
-- through supabase/functions/_shared/sms-provider.ts, selected by the
-- SMS_PROVIDER secret (semaphore | philsms | iprog, default semaphore).
-- Every attempt is logged in sms_logs with the provider name and the raw
-- provider response so a failed send can be diagnosed per provider.
--
-- Idempotent: safe to re-run. Paste-ready copy:
-- supabase/DEPLOY-SMS-PROVIDER.sql

do $$
begin
  if to_regclass('public.sms_logs') is null then
    raise warning 'public.sms_logs does not exist - skipping provider columns';
    return;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_logs' and column_name = 'provider'
  ) then
    alter table public.sms_logs add column provider text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_logs' and column_name = 'provider_message_id'
  ) then
    alter table public.sms_logs add column provider_message_id text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_logs' and column_name = 'provider_status'
  ) then
    alter table public.sms_logs add column provider_status text;
  end if;
end $$;

create index if not exists sms_logs_provider_idx on public.sms_logs (provider);

-- Legacy webhook function send-sms-alert logs to alert_log instead of
-- sms_logs; give it the same provider visibility.
do $$
begin
  if to_regclass('public.alert_log') is not null and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'alert_log' and column_name = 'provider'
  ) then
    alter table public.alert_log add column provider text;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Verification: should list provider, provider_message_id, provider_status.
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'sms_logs'
  and column_name in ('provider', 'provider_message_id', 'provider_status')
order by column_name;
