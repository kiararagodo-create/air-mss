-- ============================================================================
-- 20260912020000_monthly_reporting_cron.sql
--
-- Replaces the weekly 7-day schedule with the monthly reporting schedule and
-- hard-disables the old deletion path so nothing can remove readings early.
--
-- WHY DAILY, NOT JUST MONTHLY:
--   The archive job is idempotent (monthly_report_candidates only returns
--   months with no succeeded report), so scheduling it every day costs one
--   cheap indexed query and means a missed run - crash, cold start, deploy
--   outage, Supabase incident - is picked up automatically the next day
--   instead of leaving a month permanently un-archived. The 1st-of-month job
--   remains as a second, independent trigger.
--
-- Idempotency: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ---------------------------------------------------------------------------
-- Stop the old 7-day deletion path permanently
-- ---------------------------------------------------------------------------
-- The old job deleted raw readings 7 days after a weekly archive. Leaving the
-- function callable means an old deployment could still wipe a month of data.
-- Replaced with a function that always raises.

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'delete_archived_readings'
  ) then
    execute 'drop function if exists public.delete_archived_readings(text, timestamptz, timestamptz) cascade';
    execute 'drop function if exists public.delete_archived_readings(uuid, timestamptz, timestamptz) cascade';
    -- Recreate under the (text, timestamptz, timestamptz) signature as a tombstone.
    execute $fn$
      create or replace function public.delete_archived_readings(
        p_device_id text, p_report_start timestamptz, p_report_end timestamptz
      ) returns bigint
      language plpgsql
      as $body$
      begin
        raise exception
          'delete_archived_readings() was retired by the monthly retention migration. Use delete_readings_for_archived_month(device_id, month_start), which enforces the calendar-month + verified-archive rule.';
      end;
      $body$;
    $fn$;
    raise notice 'Legacy delete_archived_readings() disabled. Retention now goes through delete_readings_for_archived_month().';
  end if;
end;
$$;

-- The old weekly candidate function is no longer used by anything.
drop function if exists public.archive_completed_reports(integer);


-- ---------------------------------------------------------------------------
-- Reporting configuration (single place for the cron secret)
-- ---------------------------------------------------------------------------
-- Previously the cron secret was hardcoded in plaintext in a migration. It is
-- now a row in this table, so there is exactly one place to rotate it.
--
-- The matching edge-function secret must be set with:
--   npx supabase secrets set CRON_SECRET='<the same value>'
-- Service-role and other privileged keys stay in edge-function secrets and are
-- never stored in this table.

create table if not exists public.reporting_config (
  key        text primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

alter table public.reporting_config enable row level security;

drop policy if exists reporting_config_admin_read on public.reporting_config;
create policy reporting_config_admin_read
  on public.reporting_config for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

comment on table public.reporting_config is
  'Server-side configuration for the reporting jobs. Contains the cron bearer token; rotate via set_reporting_cron_secret().';

-- Set/rotate the secret. Callable by the service role only.
create or replace function public.set_reporting_cron_secret(p_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_secret is null or length(p_secret) < 16 then
    raise exception 'Cron secret must be at least 16 characters.';
  end if;

  insert into public.reporting_config (key, value, updated_at)
  values ('cron_secret', p_secret, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;

  perform cron.unschedule(jobname) from cron.job where jobname in (
    'monthly-sensor-report-archive',
    'daily-sensor-report-aggregate'
  );
end;
$$;

revoke all on function public.set_reporting_cron_secret(text) from public, anon, authenticated;


-- Read the secret for use inside a cron job definition (SECURITY DEFINER so the
-- job can build the Authorization header without the caller seeing the value).
create or replace function public.reporting_cron_secret()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select value from public.reporting_config where key = 'cron_secret';
$$;

revoke all on function public.reporting_cron_secret() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Project URL used to build the function endpoint
-- ---------------------------------------------------------------------------

create or replace function public.set_reporting_project_url(p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_url is null or p_url !~ '^https://[a-z0-9]+\.supabase\.co$' then
    raise exception 'Project URL must look like https://<ref>.supabase.co (got %)', p_url;
  end if;
  insert into public.reporting_config (key, value, updated_at)
  values ('project_url', p_url, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.set_reporting_project_url(text) from public, anon, authenticated;


create or replace function public.reporting_project_url()
returns text
language sql
stable
as $$
  select value from public.reporting_config where key = 'project_url';
$$;


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE to PUBLIC by default, which would leave the
-- retention delete and the write-side helpers callable by any signed-in user.
-- Every reporting function is revoked first and then re-granted explicitly:
--
--   authenticated -> read-only helpers the browser calls through PostgREST
--   service_role  -> everything, including archive + retention
--
-- The retention delete stays fail-closed even so; this is defence in depth, not
-- the primary control.

revoke all on function
  public.calendar_day_index(date, date, text),
  public.daily_report_bundle(text, date),
  public.resolve_thresholds(timestamptz),
  public.refresh_daily_summaries(date, date, integer, integer),
  public.refresh_graph_buckets(date, date, integer),
  public.monthly_report_candidates(date),
  public.claim_monthly_report(text, date, text, text),
  public.complete_monthly_report(text, date, integer, text[], text, bigint, bigint, bigint, jsonb, jsonb, jsonb, jsonb, text, boolean),
  public.fail_monthly_report(text, date, text),
  public.delete_readings_for_archived_month(text, date),
  public.monthly_stats(text, date),
  public.reading_is_danger(numeric, numeric, numeric, numeric, jsonb),
  public.manila_day_start(date),
  public.manila_day_end(date),
  public.manila_month_start(timestamptz),
  public.manila_month_end(timestamptz),
  public.manila_previous_month(timestamptz),
  public.report_tz()
from public, anon, authenticated;

grant usage on schema public to authenticated, service_role;

-- Read-only: safe for the Reports page.
grant execute on function
  public.calendar_day_index(date, date, text),
  public.daily_report_bundle(text, date),
  public.resolve_thresholds(timestamptz),
  public.manila_day_start(date),
  public.manila_day_end(date),
  public.manila_month_start(timestamptz),
  public.manila_month_end(timestamptz),
  public.manila_previous_month(timestamptz),
  public.report_tz()
to authenticated, service_role;

-- Server-side only: aggregation refresh, archiving and retention.
grant execute on function
  public.refresh_daily_summaries(date, date, integer, integer),
  public.refresh_graph_buckets(date, date, integer),
  public.monthly_report_candidates(date),
  public.claim_monthly_report(text, date, text, text),
  public.complete_monthly_report(text, date, integer, text[], text, bigint, bigint, bigint, jsonb, jsonb, jsonb, jsonb, text, boolean),
  public.fail_monthly_report(text, date, text),
  public.delete_readings_for_archived_month(text, date),
  public.monthly_stats(text, date),
  public.reading_is_danger(numeric, numeric, numeric, numeric, jsonb)
to service_role;


-- ---------------------------------------------------------------------------
-- Remove the old schedules
-- ---------------------------------------------------------------------------
do $$
declare
  j record;
begin
  for j in select jobid, jobname from cron.job
           where jobname in (
             'weekly-sensor-report-archive',
             'daily-sensor-report-archive',
             'monthly-sensor-report-archive',
             'daily-sensor-report-aggregate'
           )
  loop
    perform cron.unschedule(j.jobid);
    raise notice 'Unscheduled cron job: % (%)', j.jobname, j.jobid;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- Schedule the new jobs
-- ---------------------------------------------------------------------------
-- pg_cron schedules in the DATABASE timezone (UTC on Supabase), NOT Manila.
--   daily  : 02:10 UTC = 10:10 Asia/Manila, every day
--   monthly: 02:20 UTC = 10:20 Asia/Manila, 1st of each month
-- Both run the same idempotent job; neither is required for correctness, so a
-- failure of one is covered by the other plus the next daily run.

do $$
declare
  v_secret text;
  v_url    text;
begin
  v_secret := public.reporting_cron_secret();
  v_url    := public.reporting_project_url();

  if v_secret is null then
    raise notice
      'reporting_config.cron_secret is not set, so no cron jobs were scheduled. Run:  select set_reporting_cron_secret(''<your secret>'');  then set the matching edge secret with:  npx supabase secrets set CRON_SECRET=<same value>';
    return;
  end if;

  if v_url is null then
    raise notice
      'reporting_config.project_url is not set. Run:  select set_reporting_project_url(''https://<your-ref>.supabase.co'');  and re-apply this migration.';
    return;
  end if;

  -- Daily: refresh aggregates for the last 4 days (catches late arrivals and
  -- re-runs after failures), then archive any overdue complete month.
  perform cron.schedule(
    'daily-sensor-report-aggregate',
    '10 2 * * *',
    $job$select net.http_post(
      url := public.reporting_project_url() || '/functions/v1/run-monthly-archive',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || public.reporting_cron_secret()
      ),
      body := jsonb_build_object('mode', 'daily')
    );$job$
  );

  -- Monthly: same job, guaranteed to fire on the 1st even if the daily job
  -- has been failing.
  perform cron.schedule(
    'monthly-sensor-report-archive',
    '20 2 1 * *',
    $job$select net.http_post(
      url := public.reporting_project_url() || '/functions/v1/run-monthly-archive',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || public.reporting_cron_secret()
      ),
      body := jsonb_build_object('mode', 'monthly')
    );$job$
  );

  raise notice 'Scheduled daily-sensor-report-aggregate (02:10 UTC) and monthly-sensor-report-archive (02:20 UTC on the 1st).';
exception
  when insufficient_privilege then
    raise notice 'Not permitted to manage cron jobs (run this as the postgres role).';
end;
$$;