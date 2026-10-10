-- ============================================================================
-- 20260912010000_monthly_reporting_functions.sql
--
-- Aggregation, candidate selection, report bookkeeping and the retention
-- delete. The delete is FAIL-CLOSED: it refuses unless the month is genuinely
-- older than one calendar month AND its archive row is succeeded AND verified.
--
-- Idempotency: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Threshold resolution
-- ---------------------------------------------------------------------------

-- Returns the threshold set in effect at p_at plus how it was resolved.
--   threshold_source = 'historical' -> a threshold_history row existed for p_at
--   threshold_source = 'current'   -> no history row; the CURRENT platform_thresholds
--                                     values were used, and reports must say so.
create or replace function public.resolve_thresholds(p_at timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hist   public.threshold_history%rowtype;
  v_live   public.platform_thresholds%rowtype;
  v_source text := 'current';
begin
  select * into v_hist
  from public.threshold_history
  where effective_from <= p_at
  order by effective_from desc
  limit 1;

  if found then
    v_source := 'historical';
  else
    select * into v_live from public.platform_thresholds where id = 1;
  end if;

  if v_source = 'historical' then
    return jsonb_build_object(
      'threshold_source', 'historical',
      'effective_from',   v_hist.effective_from,
      'co2_warning',      v_hist.co2_warning,
      'co2_high',         v_hist.co2_high,
      'co2_danger',       v_hist.co2_danger,
      'lpg_warning',      v_hist.lpg_warning,
      'lpg_high',         v_hist.lpg_high,
      'lpg_danger',       v_hist.lpg_danger,
      'temp_freeze_below', v_hist.temp_freeze_below,
      'temp_cool_below',  v_hist.temp_cool_below,
      'temp_heat_above',  v_hist.temp_heat_above,
      'humidity_dry_below', v_hist.humidity_dry_below,
      'humidity_low_below', v_hist.humidity_low_below,
      'humidity_mold_above', v_hist.humidity_mold_above
    );
  end if;

  if not found then
    -- No platform_thresholds row either. Fall back to the documented defaults
    -- and say so via threshold_source = 'default'.
    return jsonb_build_object(
      'threshold_source', 'default',
      'co2_warning', 1000, 'co2_high', 3500, 'co2_danger', 3500,
      'lpg_warning', 1000, 'lpg_high', 2000, 'lpg_danger', 5000,
      'temp_freeze_below', 5, 'temp_cool_below', 18, 'temp_heat_above', 35,
      'humidity_dry_below', 20, 'humidity_low_below', 30, 'humidity_mold_above', 80
    );
  end if;

  return jsonb_build_object(
    'threshold_source', 'current',
    'effective_from',   v_live.updated_at,
    'co2_warning',      v_live.co2_warning,
    'co2_high',         v_live.co2_high,
    'co2_danger',       v_live.co2_danger,
    'lpg_warning',      v_live.lpg_warning,
    'lpg_high',         v_live.lpg_high,
    'lpg_danger',       v_live.lpg_danger,
    'temp_freeze_below', v_live.temp_freeze_below,
    'temp_cool_below',  v_live.temp_cool_below,
    'temp_heat_above',  v_live.temp_heat_above,
    'humidity_dry_below', v_live.humidity_dry_below,
    'humidity_low_below', v_live.humidity_low_below,
    'humidity_mold_above', v_live.humidity_mold_above
  );
end;
$$;

comment on function public.resolve_thresholds(timestamptz) is
  'Threshold set in effect at a point in time, plus how it was resolved (historical/current/default).';


-- Helper: was a reading row in the danger band under these thresholds?
-- Extracted so refresh_daily_summaries and refresh_graph_buckets cannot drift.
create or replace function public.reading_is_danger(
  p_co2 numeric, p_lpg numeric, p_temp numeric, p_humidity numeric,
  p_th jsonb
)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(p_co2  >= (p_th->>'co2_danger')::numeric, false)
      or coalesce(p_lpg  >= (p_th->>'lpg_danger')::numeric, false)
      or coalesce(p_temp <  (p_th->>'temp_freeze_below')::numeric
               or p_temp >  (p_th->>'temp_heat_above')::numeric, false)
      or coalesce(p_humidity < (p_th->>'humidity_dry_below')::numeric
               or p_humidity > (p_th->>'humidity_mold_above')::numeric, false);
$$;


-- ---------------------------------------------------------------------------
-- Daily summary refresh
-- ---------------------------------------------------------------------------

-- Recompute daily_summaries for every device over [p_from, p_to] (Manila dates,
-- inclusive). Must run BEFORE raw readings become eligible for deletion.
--
-- Safe to re-run: it is an upsert, not an append.
create or replace function public.refresh_daily_summaries(
  p_from date,
  p_to   date,
  p_expected_sample_seconds integer default 3,
  p_gap_threshold_seconds    integer default 120
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  if p_to < p_from then
    return 0;
  end if;

  insert into public.daily_summaries as ds (
    device_id, day,
    reading_count, first_reading_at, last_reading_at,
    expected_count, coverage_pct, longest_gap_seconds, gap_count,
    co2_min, co2_max, co2_avg, co2_count, co2_warning_count, co2_danger_count, co2_min_at, co2_max_at,
    lpg_min, lpg_max, lpg_avg, lpg_count, lpg_warning_count, lpg_danger_count, lpg_min_at, lpg_max_at,
    temp_min, temp_max, temp_avg, temp_count, temp_danger_count, temp_min_at, temp_max_at,
    humidity_min, humidity_max, humidity_avg, humidity_count, humidity_danger_count, humidity_min_at, humidity_max_at,
    danger_readings, danger_by_metric, max_recorded_severity,
    thresholds_used, threshold_source, source, updated_at
  )
  -- MATERIALIZED so resolve_thresholds() runs once per day rather than once
  -- per reading row. Without this the join predicate below would be evaluated
  -- millions of times for a full month.
  with bounds as materialized (
    select
      g::date as day,
      public.manila_day_start(g::date) as win_start,
      public.manila_day_end(g::date)   as win_end,
      public.resolve_thresholds(public.manila_day_start(g::date)) as th
    from generate_series(p_from, p_to, interval '1 day') g
  ),
  src as (
    select
      r.device_id,
      b.day,
      b.th,
      r.created_at,
      r.co2, r.lpg, r.temp, r.humidity, r.severity,
      public.reading_is_danger(r.co2, r.lpg, r.temp, r.humidity, b.th) as is_danger,
      r.created_at - lag(r.created_at) over (
             partition by r.device_id, b.day order by r.created_at
           ) as gap
    from bounds b
    join public.readings r
      on r.created_at >= b.win_start
     and r.created_at <  b.win_end
  ),
  per_device_day as (
    select
      device_id, day,
      th,
      count(*)::integer as reading_count,
      min(created_at)   as first_reading_at,
      max(created_at)   as last_reading_at,

      -- Metric aggregates. avg/min/max ignore NULLs - a missing sensor value
      -- is never folded in as a zero, and *_count reports how many real
      -- samples backed each statistic.
      min(co2) as co2_min, max(co2) as co2_max, avg(co2) as co2_avg,
      count(co2)::integer as co2_count,
      count(co2) filter (where co2 >= (th->>'co2_warning')::numeric
                           and co2 <  (th->>'co2_danger')::numeric)::integer as co2_warning_count,
      count(co2) filter (where co2 >= (th->>'co2_danger')::numeric)::integer as co2_danger_count,

      min(lpg) as lpg_min, max(lpg) as lpg_max, avg(lpg) as lpg_avg,
      count(lpg)::integer as lpg_count,
      count(lpg) filter (where lpg >= (th->>'lpg_warning')::numeric
                           and lpg <  (th->>'lpg_danger')::numeric)::integer as lpg_warning_count,
      count(lpg) filter (where lpg >= (th->>'lpg_danger')::numeric)::integer as lpg_danger_count,

      min(temp) as temp_min, max(temp) as temp_max, avg(temp) as temp_avg,
      count(temp)::integer as temp_count,
      count(temp) filter (where temp <  (th->>'temp_freeze_below')::numeric
                            or temp > (th->>'temp_heat_above')::numeric)::integer as temp_danger_count,

      min(humidity) as humidity_min, max(humidity) as humidity_max, avg(humidity) as humidity_avg,
      count(humidity)::integer as humidity_count,
      count(humidity) filter (where humidity < (th->>'humidity_dry_below')::numeric
                                or humidity > (th->>'humidity_mold_above')::numeric)::integer as humidity_danger_count,

      count(*) filter (where is_danger)::integer as danger_readings,
      max(severity) as max_recorded_severity,

      -- Which metrics breached, and in how many readings each one.
      -- NOTE this is per-metric counts; danger_readings above is the count of
      -- DISTINCT ROWS, so a row breaching both CO2 and LPG counts once there
      -- and once in each of these buckets. That is deliberate and is what the
      -- report narrative explains.
      jsonb_build_object(
        'co2',      count(*) filter (where is_danger and co2 >= (th->>'co2_danger')::numeric),
        'lpg',      count(*) filter (where is_danger and lpg >= (th->>'lpg_danger')::numeric),
        'temp',     count(*) filter (where is_danger and (temp <  (th->>'temp_freeze_below')::numeric
                                                  or temp >  (th->>'temp_heat_above')::numeric)),
        'humidity', count(*) filter (where is_danger and (humidity < (th->>'humidity_dry_below')::numeric
                                                  or humidity > (th->>'humidity_mold_above')::numeric))
      ) as danger_by_metric,

      -- Gap analysis across the data we DID receive. This only sees gaps
      -- inside the observed span; a device that sent nothing all day produces
      -- no gap rows at all, which is exactly why coverage_pct (measured
      -- against the full day) is the primary completeness signal.
      coalesce(
        extract(epoch from max(gap) filter (
          where gap >= make_interval(secs => p_gap_threshold_seconds))),
        0
      )::integer as longest_gap_seconds,
      count(gap) filter (where gap >= make_interval(secs => p_gap_threshold_seconds))::integer
        as gap_count
    from src
    group by device_id, day, th
  ),
  -- Timestamps for each min/max, via DISTINCT ON so it behaves identically
  -- across every Postgres version (no dependence on arg_min/arg_max).
  x1 as (select distinct on (device_id, day) device_id, day, created_at as co2_min_at
         from src where co2 is not null order by device_id, day, co2 asc,  created_at asc),
  x2 as (select distinct on (device_id, day) device_id, day, created_at as co2_max_at
         from src where co2 is not null order by device_id, day, co2 desc, created_at asc),
  x3 as (select distinct on (device_id, day) device_id, day, created_at as lpg_min_at
         from src where lpg is not null order by device_id, day, lpg asc,  created_at asc),
  x4 as (select distinct on (device_id, day) device_id, day, created_at as lpg_max_at
         from src where lpg is not null order by device_id, day, lpg desc, created_at asc),
  x5 as (select distinct on (device_id, day) device_id, day, created_at as temp_min_at
         from src where temp is not null order by device_id, day, temp asc,  created_at asc),
  x6 as (select distinct on (device_id, day) device_id, day, created_at as temp_max_at
         from src where temp is not null order by device_id, day, temp desc, created_at asc),
  x7 as (select distinct on (device_id, day) device_id, day, created_at as humidity_min_at
         from src where humidity is not null order by device_id, day, humidity asc,  created_at asc),
  x8 as (select distinct on (device_id, day) device_id, day, created_at as humidity_max_at
         from src where humidity is not null order by device_id, day, humidity desc, created_at asc),
  merged as (
    select p.*,
           x1.co2_min_at, x2.co2_max_at,
           x3.lpg_min_at, x4.lpg_max_at,
           x5.temp_min_at, x6.temp_max_at,
           x7.humidity_min_at, x8.humidity_max_at
    from per_device_day p
    left join x1 on x1.device_id = p.device_id and x1.day = p.day
    left join x2 on x2.device_id = p.device_id and x2.day = p.day
    left join x3 on x3.device_id = p.device_id and x3.day = p.day
    left join x4 on x4.device_id = p.device_id and x4.day = p.day
    left join x5 on x5.device_id = p.device_id and x5.day = p.day
    left join x6 on x6.device_id = p.device_id and x6.day = p.day
    left join x7 on x7.device_id = p.device_id and x7.day = p.day
    left join x8 on x8.device_id = p.device_id and x8.day = p.day
  )
  select
    m.device_id, m.day,
    m.reading_count, m.first_reading_at, m.last_reading_at,
    -- Coverage is measured against the FULL Manila day, so an offline device
    -- scores near 0% rather than being scored only against the span it happened
    -- to cover. This is a DATA COMPLETENESS figure and never a safety score.
    -- extract(epoch ...) because there is no direct interval::integer cast.
    greatest(0, (extract(epoch from (
        public.manila_day_end(m.day) - public.manila_day_start(m.day))
      ) / greatest(1, p_expected_sample_seconds))::integer) as expected_count,
    least(100, round(
      (m.reading_count::numeric
       / greatest(1, extract(epoch from (
           public.manila_day_end(m.day) - public.manila_day_start(m.day))
         ) / greatest(1, p_expected_sample_seconds))) * 100, 2))::numeric(5,2)
      as coverage_pct,
    m.longest_gap_seconds, m.gap_count,
    m.co2_min, m.co2_max, m.co2_avg, m.co2_count, m.co2_warning_count, m.co2_danger_count, m.co2_min_at, m.co2_max_at,
    m.lpg_min, m.lpg_max, m.lpg_avg, m.lpg_count, m.lpg_warning_count, m.lpg_danger_count, m.lpg_min_at, m.lpg_max_at,
    m.temp_min, m.temp_max, m.temp_avg, m.temp_count, m.temp_danger_count, m.temp_min_at, m.temp_max_at,
    m.humidity_min, m.humidity_max, m.humidity_avg, m.humidity_count, m.humidity_danger_count, m.humidity_min_at, m.humidity_max_at,
    m.danger_readings, m.danger_by_metric, m.max_recorded_severity,
    m.th, (m.th->>'threshold_source')::text, 'live', now()
  from merged m
  on conflict (device_id, day) do update set
    reading_count        = excluded.reading_count,
    first_reading_at     = excluded.first_reading_at,
    last_reading_at      = excluded.last_reading_at,
    expected_count       = excluded.expected_count,
    coverage_pct         = excluded.coverage_pct,
    longest_gap_seconds  = excluded.longest_gap_seconds,
    gap_count            = excluded.gap_count,
    co2_min = excluded.co2_min, co2_max = excluded.co2_max, co2_avg = excluded.co2_avg,
    co2_count = excluded.co2_count, co2_warning_count = excluded.co2_warning_count,
    co2_danger_count = excluded.co2_danger_count,
    co2_min_at = excluded.co2_min_at, co2_max_at = excluded.co2_max_at,
    lpg_min = excluded.lpg_min, lpg_max = excluded.lpg_max, lpg_avg = excluded.lpg_avg,
    lpg_count = excluded.lpg_count, lpg_warning_count = excluded.lpg_warning_count,
    lpg_danger_count = excluded.lpg_danger_count,
    lpg_min_at = excluded.lpg_min_at, lpg_max_at = excluded.lpg_max_at,
    temp_min = excluded.temp_min, temp_max = excluded.temp_max, temp_avg = excluded.temp_avg,
    temp_count = excluded.temp_count, temp_danger_count = excluded.temp_danger_count,
    temp_min_at = excluded.temp_min_at, temp_max_at = excluded.temp_max_at,
    humidity_min = excluded.humidity_min, humidity_max = excluded.humidity_max, humidity_avg = excluded.humidity_avg,
    humidity_count = excluded.humidity_count, humidity_danger_count = excluded.humidity_danger_count,
    humidity_min_at = excluded.humidity_min_at, humidity_max_at = excluded.humidity_max_at,
    danger_readings = excluded.danger_readings,
    danger_by_metric = excluded.danger_by_metric,
    max_recorded_severity = excluded.max_recorded_severity,
    thresholds_used = excluded.thresholds_used,
    threshold_source = excluded.threshold_source,
    source = excluded.source,
    updated_at = excluded.updated_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.refresh_daily_summaries(date, date, integer, integer) is
  'Recompute daily_summaries for all devices over an inclusive Manila date range. Upsert - safe to re-run.';


-- ---------------------------------------------------------------------------
-- Graph bucket refresh
-- ---------------------------------------------------------------------------

create or replace function public.refresh_graph_buckets(
  p_from date,
  p_to   date,
  p_bucket_seconds integer default 3600
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  if p_to < p_from then
    return 0;
  end if;

  insert into public.graph_buckets as gb (
    device_id, bucket_start, bucket_seconds, reading_count,
    co2_min, co2_max, co2_avg,
    lpg_min, lpg_max, lpg_avg,
    temp_min, temp_max, temp_avg,
    humidity_min, humidity_max, humidity_avg,
    danger_readings, updated_at
  )
  -- Materialized so the threshold lookup happens once per Manila day rather
  -- than once per reading row.
  with day_th as materialized (
    select
      g::date as day,
      public.resolve_thresholds(public.manila_day_start(g::date)) as th
    from generate_series(p_from, p_to, interval '1 day') g
  )
  select
    r.device_id,
    to_timestamp(floor(extract(epoch from r.created_at) / p_bucket_seconds) * p_bucket_seconds),
    p_bucket_seconds,
    count(*)::integer,
    min(r.co2), max(r.co2), avg(r.co2),
    min(r.lpg), max(r.lpg), avg(r.lpg),
    min(r.temp), max(r.temp), avg(r.temp),
    min(r.humidity), max(r.humidity), avg(r.humidity),
    count(*) filter (
      where public.reading_is_danger(
        r.co2, r.lpg, r.temp, r.humidity, d.th
      )
    )::integer,
    now()
  from public.readings r
  join day_th d
    on d.day = (r.created_at at time zone public.report_tz())::date
  where r.created_at >= public.manila_day_start(p_from)
    and r.created_at <  public.manila_day_end(p_to)
  group by 1, 2
  on conflict (device_id, bucket_start, bucket_seconds) do update set
    reading_count   = excluded.reading_count,
    co2_min = excluded.co2_min, co2_max = excluded.co2_max, co2_avg = excluded.co2_avg,
    lpg_min = excluded.lpg_min, lpg_max = excluded.lpg_max, lpg_avg = excluded.lpg_avg,
    temp_min = excluded.temp_min, temp_max = excluded.temp_max, temp_avg = excluded.temp_avg,
    humidity_min = excluded.humidity_min, humidity_max = excluded.humidity_max, humidity_avg = excluded.humidity_avg,
    danger_readings = excluded.danger_readings,
    updated_at = excluded.updated_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;


-- ---------------------------------------------------------------------------
-- Monthly report candidates
-- ---------------------------------------------------------------------------
-- Every COMPLETE calendar month (Manila) that has readings but no succeeded
-- report yet. Deliberately returns ALL such months, not just the previous one,
-- so a missed run is picked up automatically on the next daily invocation.

create or replace function public.monthly_report_candidates(
  p_only_month date default null
)
returns table (
  device_id   text,
  month_start date,
  month_end   date,
  month_label text,
  reading_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone public.report_tz())::date;
begin
  return query
  with months as (
    -- Complete months only: month_end must be strictly before today.
    select gs::date as m_start,
           (gs::date + interval '1 month - 1 day')::date as m_end
    from generate_series(
           date_trunc('month', v_today - interval '1 month'),
           date_trunc('month', v_today) - interval '1 day',
           interval '1 month'
         ) gs
  )
  select
    rm.id,
    mo.m_start,
    mo.m_end,
    to_char(mo.m_start, 'FMMonth YYYY'),
    count(r.id) as reading_count
  from public.rooms rm
  cross join months mo
  join public.readings r
    on r.device_id = rm.id
   and r.created_at >= public.manila_day_start(mo.m_start)
   and r.created_at <  public.manila_day_start(mo.m_start + interval '1 month')
  where (p_only_month is null or mo.m_start = p_only_month)
    -- Idempotency: a month already archived successfully is never re-queued,
    -- which is what stops duplicate reports on retry.
    and not exists (
      select 1 from public.monthly_reports mr
      where mr.device_id = rm.id
        and mr.month_start = mo.m_start
        and mr.generation_status = 'succeeded'
    )
    -- Never queue a month that has not fully elapsed in Manila time.
    and mo.m_end < v_today
  group by rm.id, mo.m_start, mo.m_end
  order by mo.m_start, rm.id;
end;
$$;

comment on function public.monthly_report_candidates(date) is
  'Device-months with raw readings and no succeeded report. Returns every overdue month so a missed run self-heals.';


-- ---------------------------------------------------------------------------
-- Report bookkeeping
-- ---------------------------------------------------------------------------

-- Atomically claim a device-month for generation.
-- Returns true when THIS caller claimed it, false when another run got there
-- first or it is already succeeded. This is the duplicate-report guard.
create or replace function public.claim_monthly_report(
  p_device_id   text,
  p_month_start date,
  p_device_name text default null,
  p_device_floor text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_end date;
  v_claimed   boolean := false;
begin
  v_month_end := (p_month_start + interval '1 month - 1 day')::date;

  insert into public.monthly_reports as mr (
    device_id, month_start, month_end, month_label,
    generation_status, verified, device_name, device_floor,
    attempts, last_attempt_at
  )
  values (
    p_device_id, p_month_start, v_month_end,
    to_char(p_month_start, 'FMMonth YYYY'),
    'generating', false, p_device_name, p_device_floor,
    1, now()
  )
  on conflict (device_id, month_start) do update
    set attempts          = mr.attempts + 1,
        last_attempt_at   = now(),
        generation_status = 'generating',
        error_reason      = null,
        device_name       = coalesce(excluded.device_name, mr.device_name),
        device_floor      = coalesce(excluded.device_floor, mr.device_floor)
    -- Only take over a row that is not already finished or in flight.
    where mr.generation_status in ('pending', 'failed')
       or (mr.generation_status = 'generating'
           and mr.last_attempt_at < now() - interval '30 minutes')
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

comment on function public.claim_monthly_report(text, date, text, text) is
  'Atomic single-writer claim for a device-month. false means skip - do not generate a second report.';


create or replace function public.complete_monthly_report(
  p_device_id   text,
  p_month_start date,
  p_part_count  integer,
  p_pdf_paths   text[],
  p_csv_path    text,
  p_csv_row_count bigint,
  p_reading_count bigint,
  p_danger_reading_count bigint,
  p_stats       jsonb,
  p_daily_rows  jsonb,
  p_analysis    jsonb,
  p_thresholds  jsonb,
  p_threshold_source text,
  p_verified    boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.monthly_reports mr
  set generation_status = case when p_verified then 'succeeded' else 'failed' end,
      verified          = p_verified,
      verified_at       = case when p_verified then now() else null end,
      part_count        = p_part_count,
      pdf_paths         = p_pdf_paths,
      csv_path          = p_csv_path,
      csv_row_count     = p_csv_row_count,
      reading_count     = p_reading_count,
      danger_reading_count = p_danger_reading_count,
      stats             = p_stats,
      daily_rows        = p_daily_rows,
      analysis          = p_analysis,
      thresholds_used   = p_thresholds,
      threshold_source  = p_threshold_source,
      generated_at      = now(),
      error_reason      = case when p_verified then null
                               else 'Archive stored but failed storage verification; readings retained.'
                          end
  where mr.device_id   = p_device_id
    and mr.month_start = p_month_start;

  if not found then
    raise exception 'complete_monthly_report: no row for device % month %', p_device_id, p_month_start;
  end if;
end;
$$;


create or replace function public.fail_monthly_report(
  p_device_id    text,
  p_month_start  date,
  p_error_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.monthly_reports mr
  set generation_status = 'failed',
      verified          = false,
      verified_at       = null,
      error_reason      = left(coalesce(p_error_reason, 'unknown error'), 1000),
      last_attempt_at   = now()
  where mr.device_id   = p_device_id
    and mr.month_start = p_month_start;
end;
$$;


-- ---------------------------------------------------------------------------
-- THE RETENTION DELETE  (fail-closed)
-- ---------------------------------------------------------------------------
-- Deletes raw readings for exactly one archived device-month, and only when
-- ALL of the following hold:
--   1. a monthly_reports row exists for that device-month
--   2. generation_status = 'succeeded'
--   3. verified = true          (PDF parts + CSV uploaded AND re-listed)
--   4. the month is at least one full calendar month in the past (Manila)
--   5. readings_deleted is still false (so a retry cannot double-count)
-- If any check fails it raises, and nothing is deleted.
create or replace function public.delete_readings_for_archived_month(
  p_device_id   text,
  p_month_start date
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row         public.monthly_reports%rowtype;
  v_month_end   date;
  v_today       date := (now() at time zone public.report_tz())::date;
  v_next_start  date := (p_month_start + interval '1 month')::date;
  -- Earliest date on which EVERY reading in the month is at least one full
  -- calendar month old. See the explanation at the guard below.
  v_eligible_on date := (p_month_start + interval '2 months')::date;
  v_deleted     bigint := 0;
begin
  select * into v_row
  from public.monthly_reports
  where device_id = p_device_id and month_start = p_month_start
  for update;

  if not found then
    raise exception
      'RETENTION BLOCKED: no monthly archive row for device % month %. Readings retained.',
      p_device_id, p_month_start;
  end if;

  if v_row.generation_status <> 'succeeded' then
    raise exception
      'RETENTION BLOCKED: archive for device % month % is %, not succeeded. Readings retained.',
      p_device_id, p_month_start, v_row.generation_status;
  end if;

  if not v_row.verified then
    raise exception
      'RETENTION BLOCKED: archive for device % month % was never verified in Storage. Readings retained.',
      p_device_id, p_month_start;
  end if;

  if v_row.readings_deleted then
    raise exception
      'RETENTION BLOCKED: archive for device % month % already had its readings deleted. No action taken.',
      p_device_id, p_month_start;
  end if;

  v_month_end := (p_month_start + interval '1 month - 1 day')::date;

  -- The month must have fully elapsed in Manila time.
  if v_month_end >= v_today then
    raise exception
      'RETENTION BLOCKED: month % for device % has not fully elapsed. Readings retained.',
      p_month_start, p_device_id;
  end if;

  -- CALENDAR-MONTH RULE, evaluated per reading rather than per month.
  --
  -- The youngest reading in this month falls on v_month_end at 23:59:59
  -- Manila. For THAT reading to be at least one full calendar month old we
  -- must have reached (v_month_end + 1 month + 1 day), which is the 1st of
  -- the month after next - exactly v_eligible_on.
  --
  -- Deleting a whole month on the 1st of the following month would NOT
  -- satisfy the rule: a reading taken at 23:59 on the last day of the month
  -- would be only hours old at that point. Deleting on the 1st of the month
  -- after next means every reading survives at least one full calendar month,
  -- and at any instant the database holds the current partial month plus the
  -- complete previous one - between one and two months of raw data.
  if v_today < v_eligible_on then
    raise exception
      'RETENTION BLOCKED: month % for device % is not yet one full calendar month old; readings from this month may be deleted no earlier than % (Asia/Manila). Today is %. Readings retained.',
      p_month_start, p_device_id, v_eligible_on, v_today;
  end if;

  if v_today < v_next_start then
    raise exception
      'RETENTION BLOCKED: month % for device % is not yet one full calendar month old (today is % Manila). Readings retained.',
      p_month_start, p_device_id, v_today;
  end if;

  -- Final defence: the durable aggregates for the month must already exist,
  -- otherwise deleting raw rows would lose the calendar forever.
  if not exists (
    select 1 from public.daily_summaries ds
    where ds.device_id = p_device_id
      and ds.day >= p_month_start
      and ds.day <= v_month_end
  ) then
    raise exception
      'RETENTION BLOCKED: no daily_summaries rows exist for device % month %; refusing to remove the only record. Readings retained.',
      p_device_id, p_month_start;
  end if;

  delete from public.readings r
  where r.device_id = p_device_id
    and r.created_at >= public.manila_day_start(p_month_start)
    and r.created_at <  public.manila_day_start(v_next_start);

  get diagnostics v_deleted = row_count;

  update public.monthly_reports
  set readings_deleted      = true,
      readings_deleted_at   = now(),
      deleted_reading_count = v_deleted
  where device_id = p_device_id and month_start = p_month_start;

  return v_deleted;
end;
$$;

comment on function public.delete_readings_for_archived_month(text, date) is
  'Fail-closed retention delete. Raises unless the month is archived, verified, fully elapsed, and old enough that EVERY reading in it is at least one full calendar month old (deletion no earlier than the 1st of the month after next). Never partially deletes.';


-- ---------------------------------------------------------------------------
-- Calendar index
-- ---------------------------------------------------------------------------
-- Per Manila date, the counts the calendar needs to highlight a day.
-- 'raw' means raw readings still exist; 'archived' means only aggregates remain.
create or replace function public.calendar_day_index(
  p_from date,
  p_to   date,
  p_device_id text default null
)
returns table (
  day               date,
  device_count      integer,
  reading_count     bigint,
  danger_readings   bigint,
  has_raw           boolean,
  has_archived      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select gs::date as d
    from generate_series(p_from, p_to, interval '1 day') gs
  ),
  agg as (
    select ds.day,
           count(distinct ds.device_id)::integer as device_count,
           sum(ds.reading_count)::bigint       as reading_count,
           sum(ds.danger_readings)::bigint      as danger_readings
    from public.daily_summaries ds
    where ds.day between p_from and p_to
      and (p_device_id is null or ds.device_id = p_device_id)
    group by ds.day
  ),
  raw_rows as (
    select (r.created_at at time zone public.report_tz())::date as d,
           count(*)::bigint as n
    from public.readings r
    where r.created_at >= public.manila_day_start(p_from)
      and r.created_at <  public.manila_day_end(p_to)
      and (p_device_id is null or r.device_id = p_device_id)
    group by 1
  )
  select
    days.d,
    coalesce(agg.device_count, 0),
    coalesce(agg.reading_count, 0),
    coalesce(agg.danger_readings, 0),
    (coalesce(raw_rows.n, 0) > 0),
    (coalesce(agg.reading_count, 0) > 0)
  from days
  left join agg on agg.day = days.d
  left join raw_rows on raw_rows.d = days.d
  order by days.d;
$$;

comment on function public.calendar_day_index(date, date, text) is
  'Per-Manila-date counts for the Reports calendar. has_raw false + has_archived true = raw deleted, aggregates remain.';


-- ---------------------------------------------------------------------------
-- Daily bundle (single RPC for the Reports day panel + daily PDF)
-- ---------------------------------------------------------------------------

create or replace function public.daily_report_bundle(
  p_device_id text,
  p_day       date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with ds as (
    select * from public.daily_summaries
    where device_id = p_device_id and day = p_day
  ),
  raw_count as (
    select count(*)::bigint as n
    from public.readings r
    where r.device_id = p_device_id
      and r.created_at >= public.manila_day_start(p_day)
      and r.created_at <  public.manila_day_end(p_day)
  ),
  rm as (
    select name, floor from public.rooms where id = p_device_id
  ),
  buckets as (
    select jsonb_agg(
      jsonb_build_object(
        'bucket_start', bucket_start,
        'reading_count', reading_count,
        'co2_avg', co2_avg, 'co2_min', co2_min, 'co2_max', co2_max,
        'lpg_avg', lpg_avg, 'lpg_min', lpg_min, 'lpg_max', lpg_max,
        'temp_avg', temp_avg, 'temp_min', temp_min, 'temp_max', temp_max,
        'humidity_avg', humidity_avg, 'humidity_min', humidity_min, 'humidity_max', humidity_max,
        'danger_readings', danger_readings
      ) order by bucket_start
    ) as series
    from public.graph_buckets
    where device_id = p_device_id
      and bucket_start >= public.manila_day_start(p_day)
      and bucket_start <  public.manila_day_end(p_day)
  )
  select jsonb_build_object(
    'device_id',   p_device_id,
    'device_name', coalesce((select name from rm), p_device_id),
    'device_floor',coalesce((select floor from rm), '-'),
    'day',         p_day,
    'day_start',   public.manila_day_start(p_day),
    'day_end',     public.manila_day_end(p_day),
    'has_raw',     (select n from raw_count) > 0,
    'raw_reading_count', (select n from raw_count),
    'has_archive', exists (select 1 from ds),
    -- Aggregated data is ALL that survives once raw readings are deleted.
    'source',      case
                     when (select n from raw_count) > 0 then 'raw'
                     when exists (select 1 from ds)    then 'archived'
                     else 'none'
                   end,
    'summary',     (select to_jsonb(ds) from ds),
    'graph_buckets', coalesce((select series from buckets), '[]'::jsonb)
  );
$$;

comment on function public.daily_report_bundle(text, date) is
  'Everything the Reports day panel and the daily PDF need for one device-day, raw or archived.';


-- ---------------------------------------------------------------------------
-- Month stats (kept server-side so the PDF and the UI agree exactly)
-- ---------------------------------------------------------------------------

create or replace function public.monthly_stats(
  p_device_id   text,
  p_month_start date
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select p_month_start as m_start,
           (p_month_start + interval '1 month')::date as next_start
  ),
  day_th as materialized (
    -- One threshold resolution per Manila day in the month, not per reading.
    select
      g::date as day,
      public.resolve_thresholds(public.manila_day_start(g::date)) as th
    from generate_series(p_month_start::date,
                         (p_month_start + interval '1 month - 1 day')::date,
                         interval '1 day') g
  ),
  agg as (
    select
      count(*)::bigint as reading_count,
      count(*) filter (
        where public.reading_is_danger(r.co2, r.lpg, r.temp, r.humidity, d.th)
      )::bigint as danger_reading_count,
      count(co2)::bigint    as co2_count,
      min(r.co2) as co2_min, max(r.co2) as co2_max, avg(r.co2) as co2_avg,
      count(lpg)::bigint    as lpg_count,
      min(r.lpg) as lpg_min, max(r.lpg) as lpg_max, avg(r.lpg) as lpg_avg,
      count(temp)::bigint   as temp_count,
      min(r.temp) as temp_min, max(r.temp) as temp_max, avg(r.temp) as temp_avg,
      count(r.humidity)::bigint as humidity_count,
      min(r.humidity) as humidity_min, max(r.humidity) as humidity_max, avg(r.humidity) as humidity_avg,
      min(r.created_at) as first_reading_at,
      max(r.created_at) as last_reading_at
    from public.readings r
    join bounds b
      on r.device_id = p_device_id
     and r.created_at >= public.manila_day_start(b.m_start)
     and r.created_at <  public.manila_day_start(b.next_start)
    join day_th d
      on d.day = (r.created_at at time zone public.report_tz())::date
  )
  select jsonb_build_object(
    'reading_count', coalesce((select reading_count from agg), 0),
    'danger_reading_count', coalesce((select danger_reading_count from agg), 0),
    'first_reading_at', (select first_reading_at from agg),
    'last_reading_at',  (select last_reading_at from agg),
    'metrics', jsonb_build_object(
      'co2', jsonb_build_object(
        'unit', 'ppm', 'count', coalesce((select co2_count from agg), 0),
        'min', (select co2_min from agg), 'max', (select co2_max from agg),
        'avg', (select co2_avg from agg)),
      'lpg', jsonb_build_object(
        'unit', 'ppm', 'count', coalesce((select lpg_count from agg), 0),
        'min', (select lpg_min from agg), 'max', (select lpg_max from agg),
        'avg', (select lpg_avg from agg)),
      'temp', jsonb_build_object(
        'unit', '°C', 'count', coalesce((select temp_count from agg), 0),
        'min', (select temp_min from agg), 'max', (select temp_max from agg),
        'avg', (select temp_avg from agg)),
      'humidity', jsonb_build_object(
        'unit', '%', 'count', coalesce((select humidity_count from agg), 0),
        'min', (select humidity_min from agg), 'max', (select humidity_max from agg),
        'avg', (select humidity_avg from agg))
    )
  );
$$;

comment on function public.monthly_stats(text, date) is
  'Whole-month min/max/avg/count per metric from raw readings. Counts ignore NULLs rather than treating them as zero.';