alter table public.air_notifications add column if not exists last_sms_sent_at timestamptz;

-- 1-minute sweep so delayed Warning/High SMS (WARNING_SMS_DELAY_SECONDS, default 30s)
-- and offline/reminder processing run promptly via air-alerts {action:"check_offline"}.
-- Safe to re-run. Requires pg_cron + pg_net and correct app_config.anon_key/URL.
begin;

create index if not exists idx_air_notifications_pending_warning_sms
  on public.air_notifications (created_at)
  where status = 'open'
    and severity in ('warning', 'high')
    and handled_at is null
    and resolved_at is null;

create index if not exists idx_air_notifications_open_reminders
  on public.air_notifications (last_sms_sent_at, created_at)
  where status = 'open';

do $schedule$
declare
  v_job_id bigint;
begin
  if not exists (select 1 from pg_namespace where nspname = 'cron') then
    raise notice 'pg_cron not installed; skipping schedule.';
    return;
  end if;

  for v_job_id in select jobid from cron.job where jobname = 'air-check-offline' loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'air-check-offline',
    '* * * * *',
    $$
    select net.http_post(
      url := 'https://rvgoojkdcgzzcipzjlon.supabase.co/functions/v1/air-alerts',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select anon_key from public.app_config where id = 1)
      ),
      body := '{"action":"check_offline"}'::jsonb
    );
    $$
  );
end;
$schedule$;

commit;
