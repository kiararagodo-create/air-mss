-- Migration: schedule the offline/escalation sweep every 5 minutes.
-- Uses the same reporting_config project URL / cron secret pattern as the
-- reporting jobs; no secret is hardcoded here.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'air-check-offline') then
    perform cron.unschedule('air-check-offline');
  end if;
exception when others then
  raise notice 'Could not unschedule air-check-offline: %', sqlerrm;
end;
$$;

do $$
declare
  v_url text;
begin
  v_url := public.reporting_project_url();
  if v_url is null then
    raise notice
      'reporting_config.project_url is not set. Run: select set_reporting_project_url(''https://<your-ref>.supabase.co''); then re-apply this migration.';
    return;
  end if;

  perform cron.schedule(
    'air-check-offline',
    '*/5 * * * *',
    $job$select net.http_post(
      url := public.reporting_project_url() || '/functions/v1/check-offline',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || coalesce(public.reporting_cron_secret(), '')
      ),
      body := '{}'::jsonb
    );$job$
  );

  raise notice 'Scheduled air-check-offline every 5 minutes.';
exception
  when insufficient_privilege then
    raise notice 'Not permitted to manage cron jobs (run this as the postgres role).';
end;
$$;
