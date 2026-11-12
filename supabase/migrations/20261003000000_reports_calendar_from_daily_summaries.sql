-- Migration: the Reports calendar (and therefore the monthly list) reads
-- public.daily_summaries instead of public.readings.
--
-- Why
--   report_calendar_month() is the single hottest query on the Reports page.
--   The calendar calls it once for the visible month and the monthly list
--   (MonthlyReportGrid) calls it once per elapsed month of the selected year,
--   in parallel. Each call used to:
--     * Seq Scan public.readings for the whole month,
--     * evaluate the RLS predicate is_approved_account() once per row,
--     * evaluate report_is_danger() once per row,
--     * group the result.
--   daily_summaries already holds every one of those numbers per Manila day,
--   is indexed on (device_id, day) and on (day desc), and is never deleted
--   when raw readings age out.
--
-- What changes
--   1. refresh_daily_summaries() computes min/max/avg from physically valid
--      readings only. It grades a row with public.report_is_danger() instead
--      of public.reading_is_danger(), and suppresses danger when any sensor
--      value is invalid, so a glitch can never become a calendar breach.
--      Invalid rows still count in reading_count and are counted separately
--      in the new daily_summaries.invalid_count column. The refresh also
--      takes a global advisory lock so two refreshes can never upsert the
--      same (device_id, day) rows at the same time.
--   2. A statement-level trigger on public.readings refreshes the Manila day
--     (s) an INSERT touched, so "today" on the calendar is never a day behind
--      the daily cron. It uses pg_try_advisory_xact_lock and skips rather than
--      blocking the ingest path if a refresh is already running.
--   3. report_calendar_month() reads daily_summaries. Same arguments; it also
--      returns invalid_count so Reports can show how many readings were
--      skipped.
--   4. public.daily_summaries becomes readable by approved accounts, which is
--      exactly what public.readings already allows. Without this the
--      SECURITY INVOKER calendar would return nothing to an approved
--      non-admin caller, which is a silent behaviour change.
--   5. Every existing day is backfilled, in month-sized chunks so no single
--      statement outlives a statement timeout. Each month has its own
--      exception handler, so one bad month logs a NOTICE and does not roll
--      back the migration.
--
-- Deliberately NOT changed
--   * p_thresholds stays in the signature (PostgREST would reject the call
--     otherwise) but is no longer used to re-bucket history: the counts come
--     from the thresholds that were in effect on that day, stored in
--     daily_summaries.thresholds_used. Editing a threshold today no longer
--     rewrites last month's dots.
--   * report_month_stats() still reads public.readings - it returns
--     excluded / sensor_fault_readings, which daily_summaries does not store.
--     It only runs on month select and PDF download.
--   * reading_is_danger(), graph_buckets and the JS isDanger() mirrors keep
--     the pure threshold rule they document.
--
-- Verify: scripts/explain_reports.sql (section 3b, report_calendar_month).

-- ---------------------------------------------------------------------------
-- 0. One validity rule, and the durable counter for skipped readings.
--
--    The ranges below are the same physical-plausibility ranges already used
--    by the SMS quality filter (supabase/functions/_shared/air_alerts.ts) and
--    by 20260921000000_report_valid_ranges_and_events.sql. There was no SQL
--    helper to reuse, so this is the single SQL definition.
--
--    A value is valid only when it is present, inside its sensor range, and
--    not part of a DHT22 0/0 fault. A row where all four sensors read exactly
--    zero is a failed read, so none of its values are usable. NULL is invalid.
-- ---------------------------------------------------------------------------
alter table public.daily_summaries
  add column if not exists invalid_count integer not null default 0;

comment on column public.daily_summaries.invalid_count is
  'Reading rows on this day skipped from min/max/avg because at least one sensor value was NULL, out of range, a DHT22 0/0 fault, or the row was all zero.';

create or replace function public.report_metric_is_valid(
  p_metric text,
  p_co2 numeric,
  p_lpg numeric,
  p_temp numeric,
  p_humidity numeric
) returns boolean
language sql
immutable
as $$
  select coalesce(
    case
      when p_co2 = 0 and p_lpg = 0 and p_temp = 0 and p_humidity = 0 then false
      when p_metric = 'co2' then
        p_co2 is not null and p_co2 between 0 and 10000
      when p_metric = 'lpg' then
        p_lpg is not null and p_lpg between 0 and 10000
      when p_metric = 'temp' then
        p_temp is not null and p_temp between -40 and 80
        and not (p_temp = 0 and p_humidity = 0)
      when p_metric = 'humidity' then
        p_humidity is not null and p_humidity between 0 and 100
        and not (p_temp = 0 and p_humidity = 0)
      else false
    end,
    false
  );
$$;

comment on function public.report_metric_is_valid(text, numeric, numeric, numeric, numeric) is
  'Physical plausibility rule for one sensor value. NULL, out-of-range, DHT22 0/0 and all-zero rows are invalid.';

create or replace function public.report_reading_is_invalid(
  p_co2 numeric,
  p_lpg numeric,
  p_temp numeric,
  p_humidity numeric
) returns boolean
language sql
immutable
as $$
  select not (
    public.report_metric_is_valid('co2', p_co2, p_lpg, p_temp, p_humidity)
    and public.report_metric_is_valid('lpg', p_co2, p_lpg, p_temp, p_humidity)
    and public.report_metric_is_valid('temp', p_co2, p_lpg, p_temp, p_humidity)
    and public.report_metric_is_valid('humidity', p_co2, p_lpg, p_temp, p_humidity)
  );
$$;

comment on function public.report_reading_is_invalid(numeric, numeric, numeric, numeric) is
  'True when any of the four sensor values is invalid. Invalid rows still count in reading_count.';

-- Keep every assigned aggregate inside the current numeric column range.
-- 20261003000000 targets numeric(12,3); 20261004000000 widens the columns to
-- numeric(14,3) and raises these bounds. Handling NULL explicitly matters:
-- PostgreSQL least()/greatest() ignore NULLs, which would turn a NULL average
-- into a number.
create or replace function public.report_summary_value(p_value numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_value is null then null
    else least(999999999.999, greatest(-999999999.999, p_value))
  end;
$$;

comment on function public.report_summary_value(numeric) is
  'Clamp a daily_summaries metric to the current numeric column range so one bad value cannot abort a refresh.';

-- ---------------------------------------------------------------------------
-- 1. refresh_daily_summaries(): report-grade danger counts + refresh lock.
-- ---------------------------------------------------------------------------
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

  -- Serialise every refresh. Two of these running at once would race on the
  -- same (device_id, day) rows in the ON CONFLICT DO UPDATE below, which can
  -- deadlock and abort the reading INSERT that fired the trigger. Advisory
  -- locks are re-entrant within a session, so a caller that already holds it
  -- (the trigger) acquires it again harmlessly.
  perform pg_advisory_xact_lock(hashtextextended('daily_summaries.refresh', 0));

  insert into public.daily_summaries as ds (
    device_id, day,
    reading_count, invalid_count, first_reading_at, last_reading_at,
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
      public.report_metric_is_valid('co2', r.co2, r.lpg, r.temp, r.humidity) as co2_valid,
      public.report_metric_is_valid('lpg', r.co2, r.lpg, r.temp, r.humidity) as lpg_valid,
      public.report_metric_is_valid('temp', r.co2, r.lpg, r.temp, r.humidity) as temp_valid,
      public.report_metric_is_valid('humidity', r.co2, r.lpg, r.temp, r.humidity) as humidity_valid,
      public.report_reading_is_invalid(r.co2, r.lpg, r.temp, r.humidity) as is_invalid,
      -- report_is_danger(), not reading_is_danger(): daily_summaries feeds the
      -- Reports calendar, whose danger counts have always come from
      -- report_is_danger(). The two differ on out-of-range values and on the
      -- DHT22 fault signature (temp = 0 and humidity = 0), so using the pure
      -- threshold rule here would make the calendar disagree with the day and
      -- month danger tables.
      -- A row with any invalid sensor value is never danger: a glitch must not
      -- appear on the calendar as a real above-limit event.
      not public.report_reading_is_invalid(r.co2, r.lpg, r.temp, r.humidity)
        and coalesce(
          public.report_is_danger(r.co2, r.lpg, r.temp, r.humidity, b.th),
          false
        ) as is_danger,
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
      -- Invalid rows are still readings: they stay in reading_count and are
      -- additionally counted here so Reports can show what was skipped.
      count(*) filter (where is_invalid)::integer as invalid_count,
      min(created_at)   as first_reading_at,
      max(created_at)   as last_reading_at,

      -- Metric aggregates use valid samples only. A NULL, an out-of-range
      -- value, a DHT22 0/0 fault or an all-zero row never enters min/max/avg,
      -- and *_count reports how many real samples backed each statistic.
      min(co2) filter (where co2_valid) as co2_min,
      max(co2) filter (where co2_valid) as co2_max,
      avg(co2) filter (where co2_valid) as co2_avg,
      count(*) filter (where co2_valid)::integer as co2_count,
      count(*) filter (where co2_valid and not is_invalid
                         and co2 >= (th->>'co2_warning')::numeric
                         and co2 <  (th->>'co2_danger')::numeric)::integer as co2_warning_count,
      count(*) filter (where co2_valid and not is_invalid
                         and co2 >= (th->>'co2_danger')::numeric)::integer as co2_danger_count,

      min(lpg) filter (where lpg_valid) as lpg_min,
      max(lpg) filter (where lpg_valid) as lpg_max,
      avg(lpg) filter (where lpg_valid) as lpg_avg,
      count(*) filter (where lpg_valid)::integer as lpg_count,
      count(*) filter (where lpg_valid and not is_invalid
                         and lpg >= (th->>'lpg_warning')::numeric
                         and lpg <  (th->>'lpg_danger')::numeric)::integer as lpg_warning_count,
      count(*) filter (where lpg_valid and not is_invalid
                         and lpg >= (th->>'lpg_danger')::numeric)::integer as lpg_danger_count,

      min(temp) filter (where temp_valid) as temp_min,
      max(temp) filter (where temp_valid) as temp_max,
      avg(temp) filter (where temp_valid) as temp_avg,
      count(*) filter (where temp_valid)::integer as temp_count,
      count(*) filter (where temp_valid and not is_invalid
                         and (temp < (th->>'temp_freeze_below')::numeric
                           or temp > (th->>'temp_heat_above')::numeric))::integer as temp_danger_count,

      min(humidity) filter (where humidity_valid) as humidity_min,
      max(humidity) filter (where humidity_valid) as humidity_max,
      avg(humidity) filter (where humidity_valid) as humidity_avg,
      count(*) filter (where humidity_valid)::integer as humidity_count,
      count(*) filter (where humidity_valid and not is_invalid
                         and (humidity < (th->>'humidity_dry_below')::numeric
                           or humidity > (th->>'humidity_mold_above')::numeric))::integer as humidity_danger_count,

      count(*) filter (where is_danger)::integer as danger_readings,
      max(severity) as max_recorded_severity,

      -- Which metrics breached, and in how many readings each one.
      -- NOTE this is per-metric counts; danger_readings above is the count of
      -- DISTINCT ROWS, so a row breaching both CO2 and LPG counts once there
      -- and once in each of these buckets. That is deliberate and is what the
      -- report narrative explains.
      jsonb_build_object(
        'co2',      count(*) filter (where is_danger and co2_valid
                                       and co2 >= (th->>'co2_danger')::numeric),
        'lpg',      count(*) filter (where is_danger and lpg_valid
                                       and lpg >= (th->>'lpg_danger')::numeric),
        'temp',     count(*) filter (where is_danger and temp_valid
                                       and (temp <  (th->>'temp_freeze_below')::numeric
                                         or temp > (th->>'temp_heat_above')::numeric)),
        'humidity', count(*) filter (where is_danger and humidity_valid
                                       and (humidity < (th->>'humidity_dry_below')::numeric
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
         from src where co2_valid order by device_id, day, co2 asc,  created_at asc),
  x2 as (select distinct on (device_id, day) device_id, day, created_at as co2_max_at
         from src where co2_valid order by device_id, day, co2 desc, created_at asc),
  x3 as (select distinct on (device_id, day) device_id, day, created_at as lpg_min_at
         from src where lpg_valid order by device_id, day, lpg asc,  created_at asc),
  x4 as (select distinct on (device_id, day) device_id, day, created_at as lpg_max_at
         from src where lpg_valid order by device_id, day, lpg desc, created_at asc),
  x5 as (select distinct on (device_id, day) device_id, day, created_at as temp_min_at
         from src where temp_valid order by device_id, day, temp asc,  created_at asc),
  x6 as (select distinct on (device_id, day) device_id, day, created_at as temp_max_at
         from src where temp_valid order by device_id, day, temp desc, created_at asc),
  x7 as (select distinct on (device_id, day) device_id, day, created_at as humidity_min_at
         from src where humidity_valid order by device_id, day, humidity asc,  created_at asc),
  x8 as (select distinct on (device_id, day) device_id, day, created_at as humidity_max_at
         from src where humidity_valid order by device_id, day, humidity desc, created_at asc),
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
    m.reading_count, m.invalid_count, m.first_reading_at, m.last_reading_at,
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
    public.report_summary_value(m.co2_min),
    public.report_summary_value(m.co2_max),
    public.report_summary_value(m.co2_avg),
    m.co2_count, m.co2_warning_count, m.co2_danger_count, m.co2_min_at, m.co2_max_at,
    public.report_summary_value(m.lpg_min),
    public.report_summary_value(m.lpg_max),
    public.report_summary_value(m.lpg_avg),
    m.lpg_count, m.lpg_warning_count, m.lpg_danger_count, m.lpg_min_at, m.lpg_max_at,
    public.report_summary_value(m.temp_min),
    public.report_summary_value(m.temp_max),
    public.report_summary_value(m.temp_avg),
    m.temp_count, m.temp_danger_count, m.temp_min_at, m.temp_max_at,
    public.report_summary_value(m.humidity_min),
    public.report_summary_value(m.humidity_max),
    public.report_summary_value(m.humidity_avg),
    m.humidity_count, m.humidity_danger_count, m.humidity_min_at, m.humidity_max_at,
    m.danger_readings, m.danger_by_metric, m.max_recorded_severity,
    m.th, (m.th->>'threshold_source')::text, 'live', now()
  from merged m
  on conflict (device_id, day) do update set
    reading_count        = excluded.reading_count,
    invalid_count        = excluded.invalid_count,
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
-- 2. Keep daily_summaries current as readings arrive.
--
--    Statement level, not row level: one INSERT statement produces ONE
--    refresh no matter how many rows it carried, so a bulk import stays
--    O(days) instead of O(rows). The transition table gives the exact Manila
--    day range the statement touched.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_daily_summaries_from_readings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_to   date;
begin
  select min(((inserted.created_at at time zone 'Asia/Manila')::date)),
         max(((inserted.created_at at time zone 'Asia/Manila')::date))
    into v_from, v_to
    from inserted;

  if v_from is null then
    return null;
  end if;

  -- Never make an ingest wait on a refresh. If the daily cron or a previous
  -- insert is already refreshing, skip: the next INSERT or the cron brings
  -- the row up to date, and refresh_daily_summaries() is an upsert.
  if not pg_try_advisory_xact_lock(hashtextextended('daily_summaries.refresh', 0)) then
    return null;
  end if;

  perform public.refresh_daily_summaries(v_from, v_to);
  return null;
end;
$$;

drop trigger if exists readings_refresh_daily_summaries on public.readings;
create trigger readings_refresh_daily_summaries
  after insert on public.readings
  referencing new table as inserted
  for each statement
  execute function public.refresh_daily_summaries_from_readings();

-- ---------------------------------------------------------------------------
-- 3. daily_summaries becomes readable by approved accounts.
--
--    The calendar RPC is SECURITY INVOKER, so it sees exactly what its caller
--    sees. public.readings already allows every approved account to read
--    every raw row, so exposing the per-day aggregates to the same role adds
--    no information - and it keeps an approved non-admin caller getting the
--    same calendar it got before this migration.
-- ---------------------------------------------------------------------------
drop policy if exists daily_summaries_admin_read on public.daily_summaries;
create policy daily_summaries_read
  on public.daily_summaries
  for select
  to authenticated
  using ((select public.is_approved_account()));

-- ---------------------------------------------------------------------------
-- 4. report_calendar_month(): same arguments, daily_summaries source, plus
--    invalid_count so Reports can show how many readings were skipped.
--    The return table changes, so the function must be dropped first:
--    CREATE OR REPLACE cannot change a function's return type.
-- ---------------------------------------------------------------------------
drop function if exists public.report_calendar_month(date, text, jsonb);

create or replace function public.report_calendar_month(
  p_month_start date,
  p_device_id text default null,
  p_thresholds jsonb default '{}'::jsonb
)
returns table (
  day             date,
  reading_count   bigint,
  danger_readings bigint,
  co2_danger      bigint,
  lpg_danger      bigint,
  temp_danger     bigint,
  humidity_danger bigint,
  invalid_count   bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  -- p_thresholds is accepted but no longer applied: the counts below are the
  -- ones stored in daily_summaries, computed with the thresholds that were in
  -- effect on that day (daily_summaries.thresholds_used). A report must not
  -- rewrite history just because someone edited a threshold afterwards.
  with bounds as (
    select p_month_start as lo,
           (p_month_start + interval '1 month')::date as hi
  ),
  days as (
    select generate_series(
             (select lo from bounds)::timestamp,
             ((select hi from bounds) - 1)::timestamp,
             interval '1 day'
           )::date as d
  ),
  agg as (
    select ds.day,
           sum(ds.reading_count)::bigint         as reading_count,
           sum(ds.danger_readings)::bigint       as danger_readings,
           -- Per-metric columns count only valid samples: refresh_daily_summaries
           -- already excludes NULL, out-of-range, DHT22 0/0 and all-zero rows.
           -- danger_readings above is the report-graded count
           -- (report_is_danger), which is what the danger tables on the same
           -- page use.
           sum(ds.co2_danger_count)::bigint      as co2_danger,
           sum(ds.lpg_danger_count)::bigint      as lpg_danger,
           sum(ds.temp_danger_count)::bigint     as temp_danger,
           sum(ds.humidity_danger_count)::bigint as humidity_danger,
           sum(ds.invalid_count)::bigint         as invalid_count
    from public.daily_summaries ds
    cross join bounds b
    where ds.day >= b.lo
      and ds.day <  b.hi
      and (p_device_id is null or ds.device_id = p_device_id)
    group by ds.day
  )
  select d.d,
         coalesce(a.reading_count, 0)::bigint,
         coalesce(a.danger_readings, 0)::bigint,
         coalesce(a.co2_danger, 0)::bigint,
         coalesce(a.lpg_danger, 0)::bigint,
         coalesce(a.temp_danger, 0)::bigint,
         coalesce(a.humidity_danger, 0)::bigint,
         coalesce(a.invalid_count, 0)::bigint
  from days d
  left join agg a on a.day = d.d
  order by 1;
$$;

comment on function public.report_calendar_month(date, text, jsonb) is
  'Per-day reading, danger and skipped-reading counts for one Manila month, read from daily_summaries. Used for calendar dots and the monthly list.';

-- Re-apply the same grant surface the function had before it was dropped.
revoke execute on function public.report_calendar_month(date, text, jsonb) from public;
revoke execute on function public.report_calendar_month(date, text, jsonb) from anon;
grant execute on function public.report_calendar_month(date, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Backfill every existing day. Month-sized chunks so no single statement
--    runs longer than a statement timeout on a large readings table. Each
--    month is its own subtransaction: a bad month raises a NOTICE and the
--    loop carries on, so it cannot roll back the whole migration.
-- ---------------------------------------------------------------------------
do $$
declare
  v_from date;
  v_to   date;
  v_cur  date;
  v_days integer := 0;
begin
  select min(((created_at at time zone 'Asia/Manila')::date)),
         max(((created_at at time zone 'Asia/Manila')::date))
    into v_from, v_to
    from public.readings;

  if v_from is null then
    raise notice 'daily_summaries backfill skipped: public.readings is empty';
    return;
  end if;

  v_cur := date_trunc('month', v_from)::date;
  while v_cur <= v_to loop
    begin
      v_days := v_days + public.refresh_daily_summaries(
        greatest(v_cur, v_from),
        least((v_cur + interval '1 month')::date - 1, v_to)
      );
      raise notice 'daily_summaries backfilled for month %', to_char(v_cur, 'YYYY-MM');
    exception when others then
      raise notice 'daily_summaries backfill failed for month %: % (SQLSTATE %)',
                   to_char(v_cur, 'YYYY-MM'), sqlerrm, sqlstate;
    end;
    v_cur := (v_cur + interval '1 month')::date;
  end loop;

  raise notice 'daily_summaries backfilled for %..% (% day/device rows touched)',
               v_from, v_to, v_days;
end $$;

analyze public.daily_summaries;

notify pgrst, 'reload schema';
