-- ============================================================================
-- 20260913000000_annual_reporting.sql
--
-- Yearly archive layer on top of the monthly reporting added in
-- 20260912000000 / 20260912010000.
--
-- Design notes
-- ------------
-- * The annual summary is computed ENTIRELY from public.daily_summaries, never
--   from public.readings. daily_summaries is the durable aggregate and is
--   never deleted, so a 2024 annual report can still be produced in 2027 after
--   the raw rows are long gone. Reading raw rows here would have made yearly
--   reports quietly degrade as data aged out.
--
-- * One annual summary per calendar year, covering all devices. A per-device
--   annual document would just restate its twelve monthly reports; the useful
--   yearly artefact is the cross-device, cross-month comparison.
--
-- * NOTHING here deletes anything. annual_reports, monthly_reports.pdf_paths,
--   daily_summaries and graph_buckets are all permanent. The only table the
--   retention policy ever removes rows from is public.readings.
--
-- Idempotency: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. annual_reports  (one row per calendar year)
-- ---------------------------------------------------------------------------

create table if not exists public.annual_reports (
  id                 bigserial primary key,
  report_year        integer     not null,
  month_start        date        not null,   -- Jan 1 of report_year
  month_end          date        not null,   -- Dec 31 of report_year
  -- True when report_year is the current Manila calendar year, in which case the
  -- document covers only the elapsed part of the year and is titled "Year to
  -- date" rather than claiming a full-year total.
  is_year_to_date    boolean     not null default false,
  -- Actual first/last instants with recorded data, and the last Manila day
  -- included. Null when the year has no data at all.
  coverage_start     timestamptz,
  coverage_end       timestamptz,
  coverage_last_day  date,

  generation_status  text        not null default 'pending'
                       check (generation_status in ('pending', 'generating', 'succeeded', 'failed')),
  verified           boolean     not null default false,
  verified_at        timestamptz,
  pdf_path           text,
  size_bytes         bigint,

  reading_count          bigint not null default 0,
  danger_reading_count   bigint not null default 0,
  months_with_data       integer not null default 0,
  months_total           integer not null default 12,

  -- Year totals plus the 12-row monthly comparison, and the narrative.
  stats             jsonb       not null default '{}'::jsonb,
  analysis          jsonb       not null default '{}'::jsonb,
  thresholds_used   jsonb,
  threshold_source  text,

  error_reason      text,
  attempts          integer     not null default 0,
  generated_at      timestamptz,
  created_at        timestamptz not null default now(),

  constraint annual_reports_year_uniq unique (report_year)
);

comment on table public.annual_reports is
  'Annual summary PDF index, one row per calendar year. Built from daily_summaries so it survives raw-reading deletion.';
comment on column public.annual_reports.is_year_to_date is
  'True for the current Manila year: the document is labelled "Year to date" and only covers the elapsed part of the year.';

create index if not exists annual_reports_status_idx
  on public.annual_reports (generation_status, report_year desc);

alter table public.annual_reports enable row level security;

drop policy if exists annual_reports_admin_read on public.annual_reports;
create policy annual_reports_admin_read
  on public.annual_reports for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

drop policy if exists annual_reports_service_write on public.annual_reports;
create policy annual_reports_service_write
  on public.annual_reports for all
  to service_role
  using (true)
  with check (true);


-- ---------------------------------------------------------------------------
-- 2. metric_obj - shared helper, defined FIRST because annual_report_bundle()
--    uses it and Postgres validates language sql bodies at creation time.
-- ---------------------------------------------------------------------------
-- Turns (count, min, max, weighted sum) into a metric object with a true
-- weighted average rather than a mean of daily means, and a NULL average when
-- there were no measurements at all (never coerced to zero).
create or replace function public.metric_obj(
  p_metric text,
  p_unit text,
  p_count bigint,
  p_min numeric,
  p_max numeric,
  p_sum numeric
)
returns jsonb
language sql
immutable
parallel safe
as $$
  select jsonb_build_object(
    'unit', p_unit,
    'count', p_count,
    'min', p_min,
    'max', p_max,
    'avg', case when coalesce(p_count, 0) > 0
                then round(p_sum / p_count, 3)
                else null end
  );
$$;


-- ---------------------------------------------------------------------------
-- 3. annual_report_bundle(p_year)
-- ---------------------------------------------------------------------------
-- Everything the annual PDF needs, in one call, sourced from daily_summaries.
--
-- Returns 12 monthly entries ALWAYS (so the report can show a complete year
-- with honest "no data" months rather than silently omitting them), plus
-- whole-year totals, a monthly series for the graphs, and any threshold changes
-- that happened during the year.
create or replace function public.annual_report_bundle(p_year integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select
      make_date(p_year, 1, 1) as year_start,
      make_date(p_year, 12, 31) as year_end,
      (now() at time zone public.report_tz())::date as today
  ),
  months as (
    select
      p.year_start,
      p.year_end,
      p.today,
      (m - 1)::integer as month_number,
      m::date as m_start,
      (make_date(p_year, m, 1) + interval '1 month - 1 day')::date as m_end
    from params p
    cross join generate_series(1, 12) m
  ),
  -- Per-month rollup from the durable daily aggregates.
  month_agg as (
    select
      mo.month_number,
      mo.m_start,
      mo.m_end,
      -- A month is "elapsed" once its last Manila day is before today.
      mo.m_end < mo.today as is_elapsed,
      coalesce(sum(ds.reading_count), 0)::bigint as reading_count,
      coalesce(sum(ds.danger_readings), 0)::bigint as danger_readings,
      count(distinct ds.device_id) filter (where ds.reading_count > 0)::integer as devices_reporting,
      count(distinct ds.device_id)::integer as devices_with_rows,
      count(*) filter (where ds.reading_count > 0)::integer as days_with_data,
      -- Full-month day count, needed to compute the share of days that produced
      -- any reading at all.
      (mo.m_end - mo.m_start + 1)::integer as days_in_month,
      min(ds.first_reading_at) as first_reading_at,
      max(ds.last_reading_at) as last_reading_at,

      min(ds.co2_min) as co2_min, max(ds.co2_max) as co2_max,
      sum(ds.co2_avg * ds.co2_count) as co2_sum, coalesce(sum(ds.co2_count), 0)::bigint as co2_count,
      min(ds.lpg_min) as lpg_min, max(ds.lpg_max) as lpg_max,
      sum(ds.lpg_avg * ds.lpg_count) as lpg_sum, coalesce(sum(ds.lpg_count), 0)::bigint as lpg_count,
      min(ds.temp_min) as temp_min, max(ds.temp_max) as temp_max,
      sum(ds.temp_avg * ds.temp_count) as temp_sum, coalesce(sum(ds.temp_count), 0)::bigint as temp_count,
      min(ds.humidity_min) as humidity_min, max(ds.humidity_max) as humidity_max,
      sum(ds.humidity_avg * ds.humidity_count) as humidity_sum,
      coalesce(sum(ds.humidity_count), 0)::bigint as humidity_count,

      -- Weighted coverage: sum(readings) / sum(expected), not a mean of
      -- percentages, so a device offline all month cannot be averaged away.
      case when coalesce(sum(ds.expected_count), 0) > 0
        then least(100, round(
          coalesce(sum(ds.reading_count), 0)::numeric
          / sum(ds.expected_count)::numeric * 100, 2))
        else 0 end::numeric(5,2) as coverage_pct
    from months mo
    left join public.daily_summaries ds
      on ds.day >= mo.m_start
     and ds.day <= mo.m_end
    group by mo.month_number, mo.m_start, mo.m_end, mo.today
  ),
  -- Whole-year totals.
  year_totals as (
    select
      coalesce(sum(reading_count), 0)::bigint as reading_count,
      coalesce(sum(danger_readings), 0)::bigint as danger_reading_count,
      min(co2_min) as co2_min, max(co2_max) as co2_max,
      sum(co2_sum) as co2_sum, coalesce(sum(co2_count), 0)::bigint as co2_count,
      min(lpg_min) as lpg_min, max(lpg_max) as lpg_max,
      sum(lpg_sum) as lpg_sum, coalesce(sum(lpg_count), 0)::bigint as lpg_count,
      min(temp_min) as temp_min, max(temp_max) as temp_max,
      sum(temp_sum) as temp_sum, coalesce(sum(temp_count), 0)::bigint as temp_count,
      min(humidity_min) as humidity_min, max(humidity_max) as humidity_max,
      sum(humidity_sum) as humidity_sum, coalesce(sum(humidity_count), 0)::bigint as humidity_count,
      min(first_reading_at) as first_reading_at,
      max(last_reading_at) as last_reading_at
    from month_agg
  ),
  month_list as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'month_number', ma.month_number,
        'month_start', ma.m_start,
        'month_end', ma.m_end,
        'label', to_char(ma.m_start, 'FMMonth'),
        'is_elapsed', ma.is_elapsed,
        'reading_count', ma.reading_count,
        'danger_readings', ma.danger_readings,
        'devices_reporting', ma.devices_reporting,
        'days_with_data', ma.days_with_data,
        'days_in_month', ma.days_in_month,
        'coverage_pct', ma.coverage_pct,
        'first_reading_at', ma.first_reading_at,
        'last_reading_at', ma.last_reading_at,
        'metrics', jsonb_build_object(
          'co2', metric_obj('co2', 'ppm', ma.co2_count, ma.co2_min, ma.co2_max, ma.co2_sum),
          'lpg', metric_obj('lpg', 'ppm', ma.lpg_count, ma.lpg_min, ma.lpg_max, ma.lpg_sum),
          'temp', metric_obj('temp', '°C', ma.temp_count, ma.temp_min, ma.temp_max, ma.temp_sum),
          'humidity', metric_obj('humidity', '%', ma.humidity_count, ma.humidity_min, ma.humidity_max, ma.humidity_sum)
        )
      ) order by ma.month_number
    ), '[]'::jsonb) as months
    from month_agg ma
  ),
  year_row as (
    select
      coalesce(jsonb_build_object(
        'reading_count', yt.reading_count,
        'danger_reading_count', yt.danger_reading_count,
        'first_reading_at', yt.first_reading_at,
        'last_reading_at', yt.last_reading_at,
        'metrics', jsonb_build_object(
          'co2', metric_obj('co2', 'ppm', yt.co2_count, yt.co2_min, yt.co2_max, yt.co2_sum),
          'lpg', metric_obj('lpg', 'ppm', yt.lpg_count, yt.lpg_min, yt.lpg_max, yt.lpg_sum),
          'temp', metric_obj('temp', '°C', yt.temp_count, yt.temp_min, yt.temp_max, yt.temp_sum),
          'humidity', metric_obj('humidity', '%', yt.humidity_count, yt.humidity_min, yt.humidity_max, yt.humidity_sum)
        )
      ), '{}'::jsonb) as stats
    from year_totals yt
  ),
  -- Any threshold change during the year. The annual PDF states these rather
  -- than implying one fixed set of thresholds applied all year.
  th_changes as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'effective_from', th.effective_from,
      'co2_danger', th.co2_danger, 'lpg_danger', th.lpg_danger,
      'temp_freeze_below', th.temp_freeze_below, 'temp_heat_above', th.temp_heat_above,
      'humidity_dry_below', th.humidity_dry_below, 'humidity_mold_above', th.humidity_mold_above
    ) order by th.effective_from), '[]'::jsonb) as changes
    from public.threshold_history th
    where th.effective_from >= make_date(p_year, 1, 1)
      and th.effective_from <  make_date(p_year + 1, 1, 1)
  )
  select jsonb_build_object(
    'report_year', p_year,
    'year_start', p.year_start,
    'year_end', p.year_end,
    'today', p.today,
    'is_year_to_date', (p_year = extract(year from p.today)::integer),
    'months', ml.months,
    'stats', y.stats,
    'months_with_data', (
      select count(*) from month_agg where reading_count > 0
    ),
    -- Devices that actually contributed readings during the year, so the
    -- annual report can name its sources instead of presenting unattributed
    -- figures.
    'devices', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'device_id', d.device_id,
               'room_name', d.room_name,
               'room_floor', d.room_floor,
               'reading_count', d.reading_count,
               'danger_readings', d.danger_readings,
               'days_with_data', d.days_with_data
             ) order by d.reading_count desc), '[]'::jsonb)
      from (
        select ds.device_id,
               coalesce(rm.name, ds.device_id) as room_name,
               coalesce(rm.floor, '-')       as room_floor,
               sum(ds.reading_count)::bigint  as reading_count,
               sum(ds.danger_readings)::bigint as danger_readings,
               count(*) filter (where ds.reading_count > 0)::integer as days_with_data
        from public.daily_summaries ds
        left join public.rooms rm on rm.id = ds.device_id
        where ds.day >= make_date(p_year, 1, 1)
          and ds.day <= make_date(p_year, 12, 31)
          and ds.reading_count > 0
        group by ds.device_id, rm.name, rm.floor
      ) d
    ),
    'threshold_changes', tc.changes
  )
  from params p
  cross join month_list ml
  cross join year_row y
  cross join th_changes tc;
$$;

comment on function public.annual_report_bundle(integer) is
  'Annual totals, 12-month comparison and series for one calendar year, computed from durable daily_summaries. Always returns all 12 months.';


-- Helper defined above (section 2).


-- ---------------------------------------------------------------------------
-- 4. month_activity_index(p_year)
-- ---------------------------------------------------------------------------
-- Per-month status for the 12 month cards, so the UI never has to infer
-- "Report ready / In progress / No data / Upcoming" from guesswork.
--
-- status values:
--   ready       succeeded + verified monthly report exists
--   failed      a report exists but generation failed (readings retained)
--   in_progress the month has started and data exists, but no verified report yet
--   no_data     the month has started and nothing was ever recorded
--   upcoming    the month has not started yet
create or replace function public.month_activity_index(p_year integer)
returns table (
  month_number    integer,
  month_start     date,
  month_end       date,
  label           text,
  status          text,
  is_elapsed      boolean,
  reading_count   bigint,
  danger_readings bigint,
  days_with_data  integer,
  days_in_month   integer,
  coverage_pct    numeric,
  device_count    integer,
  report_id       bigint,
  part_count      integer,
  pdf_paths       text[],
  csv_path        text,
  csv_row_count   bigint,
  readings_deleted boolean,
  verified        boolean,
  error_reason    text
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select (now() at time zone public.report_tz())::date as today
  ),
  months as (
    select
      (m - 1)::integer as month_number,
      m::date as m_start,
      (make_date(p_year, m, 1) + interval '1 month - 1 day')::date as m_end
    from generate_series(1, 12) m
  ),
  activity as (
    select
      mo.month_number,
      mo.m_start,
      mo.m_end,
      -- Elapsed: the month's last Manila day is before today.
      mo.m_end < p.today as is_elapsed,
      -- Started: today is on or after the first day of the month.
      p.today >= mo.m_start as has_started,
      coalesce(sum(ds.reading_count), 0)::bigint as reading_count,
      coalesce(sum(ds.danger_readings), 0)::bigint as danger_readings,
      count(*) filter (where ds.reading_count > 0)::integer as days_with_data,
      (mo.m_end - mo.m_start + 1)::integer as days_in_month,
      count(distinct ds.device_id) filter (where ds.reading_count > 0)::integer as devices_reporting,
      case when coalesce(sum(ds.expected_count), 0) > 0
        then least(100, round(
          coalesce(sum(ds.reading_count), 0)::numeric
          / sum(ds.expected_count)::numeric * 100, 2))
        else 0 end::numeric(5,2) as coverage_pct
    from months mo
    cross join params p
    left join public.daily_summaries ds
      on ds.day >= mo.m_start
     and ds.day <= mo.m_end
    group by mo.month_number, mo.m_start, mo.m_end, p.today
  ),
  reports as (
    -- Collapse the per-device monthly reports for a month. "ready" requires at
    -- least one verified report; the paths of all of them are concatenated so
    -- Download All can fetch every device's PDFs for that month.
    select
      (report_start) as m_start,
      bool_or(generation_status = 'succeeded' and verified) as any_verified,
      bool_or(generation_status = 'failed') as any_failed,
      bool_or(generation_status in ('pending', 'generating')) as any_pending,
      sum(part_count) filter (where generation_status = 'succeeded' and verified) as part_count,
      array_agg(pdf_path) filter (
        where generation_status = 'succeeded' and verified and pdf_path is not null
      ) as pdf_paths,
      array_remove(array_agg(csv_path) filter (
        where generation_status = 'succeeded' and verified and csv_path is not null
      ), null) as csv_paths,
      min(id) filter (where generation_status = 'succeeded' and verified) as report_id,
      bool_or(readings_deleted) as readings_deleted,
      min(error_reason) filter (where generation_status = 'failed') as error_reason
    from public.monthly_reports
    where report_start >= make_date(p_year, 1, 1)
      and report_start <  make_date(p_year + 1, 1, 1)
    group by report_start
  ),
  monthly_devices as (
    select report_start, count(*) as device_count
    from public.monthly_reports
    where report_start >= make_date(p_year, 1, 1)
      and report_start <  make_date(p_year + 1, 1, 1)
      and generation_status = 'succeeded' and verified
    group by report_start
  )
  select
    a.month_number,
    a.m_start,
    a.m_end,
    to_char(a.m_start, 'FMMonth'),
    -- Order matters: an upcoming month must never be labelled "no data" just
    -- because nothing has been recorded in it yet.
    case
      when not a.has_started                                 then 'upcoming'
      when coalesce(r.any_verified, false)                   then 'ready'
      when coalesce(r.any_failed, false)                     then 'failed'
      when a.reading_count > 0                              then 'in_progress'
      else 'no_data'
    end,
    a.is_elapsed,
    a.reading_count,
    a.danger_readings,
    a.days_with_data,
    a.days_in_month,
    a.coverage_pct,
    greatest(a.devices_reporting, coalesce(md.device_count, 0)) as device_count,
    r.report_id,
    coalesce(r.part_count, 0)::integer,
    coalesce(r.pdf_paths, '{}'::text[]),
    -- One CSV column for the card. With multiple devices there are several;
    -- the Monthly Reports panel is where per-device CSVs are downloaded.
    (r.csv_paths)[1] as csv_path,
    null::bigint as csv_row_count,
    coalesce(r.readings_deleted, false),
    coalesce(r.any_verified, false),
    r.error_reason
  from activity a
  left join reports r on r.m_start = a.m_start
  left join monthly_devices md on md.report_start = a.m_start
  order by a.month_number;
$$;

comment on function public.month_activity_index(integer) is
  'Per-month archive status for one year: ready / failed / in_progress / no_data / upcoming, plus readings and danger counts.';


-- ---------------------------------------------------------------------------
-- 4. Grant execution
-- ---------------------------------------------------------------------------
-- Same pattern as the monthly migration: revoke everything first, then grant
-- the read-only helpers to authenticated and the writers to service_role only.

revoke all on function
  public.annual_report_bundle(integer),
  public.month_activity_index(integer),
  public.metric_obj(text, text, bigint, numeric, numeric, numeric)
from public, anon, authenticated;

grant execute on function
  public.annual_report_bundle(integer),
  public.month_activity_index(integer),
  public.metric_obj(text, text, bigint, numeric, numeric, numeric)
to authenticated, service_role;

revoke all on function
  public.claim_annual_report(integer),
  public.complete_annual_report(integer, boolean, date, date, timestamptz, timestamptz, date, bigint, bigint, integer, jsonb, jsonb, jsonb, text, boolean),
  public.fail_annual_report(integer, text)
from public, anon, authenticated;

grant execute on function
  public.claim_annual_report(integer),
  public.complete_annual_report(integer, boolean, date, date, timestamptz, timestamptz, date, bigint, bigint, integer, jsonb, jsonb, jsonb, text, boolean),
  public.fail_annual_report(integer, text)
to service_role;


-- ---------------------------------------------------------------------------
-- 5. Single-writer claim + completion, mirroring the monthly functions
-- ---------------------------------------------------------------------------

create or replace function public.claim_annual_report(p_year integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  insert into public.annual_reports as ar (
    report_year, month_start, month_end, is_year_to_date,
    generation_status, verified, attempts
  )
  values (
    p_year, make_date(p_year, 1, 1), make_date(p_year, 12, 31),
    (p_year = extract(year from (now() at time zone public.report_tz()))::integer),
    'generating', false, 1
  )
  on conflict (report_year) do update
    set attempts = ar.attempts + 1,
        generation_status = 'generating',
        error_reason = null
    where ar.generation_status in ('pending', 'failed')
       or (ar.generation_status = 'generating'
           and ar.created_at < now() - interval '30 minutes')
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;


create or replace function public.complete_annual_report(
  p_year integer,
  p_is_ytd boolean,
  p_coverage_start timestamptz,
  p_coverage_end timestamptz,
  p_coverage_last_day date,
  p_reading_count bigint,
  p_danger_reading_count bigint,
  p_months_with_data integer,
  p_stats jsonb,
  p_analysis jsonb,
  p_thresholds jsonb,
  p_threshold_source text,
  p_verified boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.annual_reports ar
  set generation_status = case when p_verified then 'succeeded' else 'failed' end,
      is_year_to_date    = p_is_ytd,
      coverage_start     = p_coverage_start,
      coverage_end       = p_coverage_end,
      coverage_last_day  = p_coverage_last_day,
      reading_count      = p_reading_count,
      danger_reading_count = p_danger_reading_count,
      months_with_data   = p_months_with_data,
      stats              = p_stats,
      analysis           = p_analysis,
      thresholds_used    = p_thresholds,
      threshold_source   = p_threshold_source,
      verified           = p_verified,
      verified_at        = case when p_verified then now() else null end,
      generated_at       = now(),
      error_reason       = case when p_verified then null
                               else 'Annual summary stored but failed storage verification.'
                          end
  where ar.report_year = p_year;

  if not found then
    raise exception 'complete_annual_report: no row for year %', p_year;
  end if;
end;
$$;


create or replace function public.fail_annual_report(p_year integer, p_error_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.annual_reports ar
  set generation_status = 'failed',
      verified          = false,
      verified_at       = null,
      error_reason      = left(coalesce(p_error_reason, 'unknown error'), 1000)
  where ar.report_year = p_year;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. Storage: annual artefacts live in the same private bucket
-- ---------------------------------------------------------------------------
-- monthly-reports is already private with admin-only read (added in
-- 20260912000000). Annual PDFs and the yearly ZIPs are written under
--   annual/<year>/annual-summary.pdf
--   annual/<year>/monthly-reports.zip
-- in that same bucket, so no additional policy is required and access control
-- is identical to the monthly reports.

-- Allow application/zip alongside the PDF and CSV types already permitted.
update storage.buckets
   set allowed_mime_types = array['application/pdf', 'text/csv', 'application/zip']
 where id = 'monthly-reports';


-- ---------------------------------------------------------------------------
-- 7. Schedule the automatic annual summary
-- ---------------------------------------------------------------------------
-- Runs at 02:40 UTC (10:40 Asia/Manila) on the 1st of January, generating the
-- summary for the year that just ended. The same function is also callable on
-- demand from the Reports page, so a user never has to wait for this job.
--
-- Skipped silently when reporting_config.cron_secret has not been set, for the
-- same reason the monthly job is: there is nothing to authenticate with yet.

do $$
begin
  if public.reporting_cron_secret() is null then
    raise notice 'reporting_config.cron_secret is not set, so no annual cron job was scheduled.';
    return;
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'annual-report-summary';

  perform cron.schedule(
    'annual-report-summary',
    '40 2 1 1 *',
    $job$select net.http_post(
      url := public.reporting_project_url() || '/functions/v1/annual-report',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || public.reporting_cron_secret()
      ),
      body := jsonb_build_object(
        'year', (now() at time zone 'Asia/Manila')::date - 365
      )
    );$job$
  );

  raise notice 'Scheduled annual-report-summary (02:40 UTC on 1 January).';
exception
  when insufficient_privilege then
    raise notice 'Not permitted to manage cron jobs (run this as the postgres role).';
  when undefined_function then
    raise notice 'pg_cron is not available; the annual summary must be requested from the Reports page.';
end;
$$;

-- The body above computes "last year" as today minus 365 days, which is only
-- correct when called on 1 January. Documented here so nobody reuses it on
-- another date: the function also accepts an explicit year, and the Reports page
-- always sends one explicitly.