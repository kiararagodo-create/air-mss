-- Migration: simplified Reports page data layer.
--
-- Replaces the monthly/annual reporting stack (20260912000000, 20260912010000,
-- 20260912020000, 20260913000000), none of which is applied to the live
-- database. This migration is deliberately SELF-CONTAINED: it depends only on
-- public.readings, which is pre-existing, and creates nothing that the old
-- chain created.
--
-- Design notes:
--   * SECURITY INVOKER everywhere, so the caller's own RLS on readings applies.
--   * All day/month boundaries are Asia/Manila.
--   * Danger is derived from thresholds passed in by the client as jsonb, so
--     this migration does not depend on public.platform_thresholds existing.
--     Missing keys fall back to the same defaults as src/data/Data.ts.
--   * No daily_summaries / graph_buckets / monthly_reports tables.

-- ---------------------------------------------------------------------------
-- Thresholds + the single canonical danger rule.
-- ---------------------------------------------------------------------------

create or replace function public.report_thresholds(p_thresholds jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(p_thresholds, '{}'::jsonb) || jsonb_build_object(
    'co2_danger',          coalesce((p_thresholds->>'co2_danger')::numeric, 3500),
    'lpg_danger',          coalesce((p_thresholds->>'lpg_danger')::numeric, 5000),
    'temp_freeze_below',   coalesce((p_thresholds->>'temp_freeze_below')::numeric, 5),
    'temp_heat_above',     coalesce((p_thresholds->>'temp_heat_above')::numeric, 35),
    'humidity_dry_below',  coalesce((p_thresholds->>'humidity_dry_below')::numeric, 20),
    'humidity_mold_above', coalesce((p_thresholds->>'humidity_mold_above')::numeric, 80)
  );
$$;

comment on function public.report_thresholds(jsonb) is
  'Merges client-supplied danger thresholds over safe defaults.';

-- Any single metric breaching makes the whole reading a danger reading.
-- Mirrors isDanger() in src/lib/reports.ts and isDangerRow() in
-- supabase/functions/_shared/reporting.ts.
create or replace function public.report_is_danger(
  p_co2 numeric,
  p_lpg numeric,
  p_temp numeric,
  p_humidity numeric,
  p_thresholds jsonb
)
returns boolean
language sql
immutable
as $$
  select coalesce(p_co2  >= (p_thresholds->>'co2_danger')::numeric, false)
      or coalesce(p_lpg  >= (p_thresholds->>'lpg_danger')::numeric, false)
      or coalesce(p_temp  < (p_thresholds->>'temp_freeze_below')::numeric
               or p_temp  > (p_thresholds->>'temp_heat_above')::numeric, false)
      or coalesce(p_humidity < (p_thresholds->>'humidity_dry_below')::numeric
               or p_humidity > (p_thresholds->>'humidity_mold_above')::numeric, false);
$$;

comment on function public.report_is_danger(numeric, numeric, numeric, numeric, jsonb) is
  'True when any one metric is outside its safe band.';

-- Which metric(s) breached, for the "Triggered by" column.
create or replace function public.report_triggered_by(
  p_co2 numeric,
  p_lpg numeric,
  p_temp numeric,
  p_humidity numeric,
  p_thresholds jsonb
)
returns text[]
language sql
immutable
as $$
  select coalesce(array_remove(array[
    case when p_co2 is not null and p_co2 >= (p_thresholds->>'co2_danger')::numeric
      then 'CO2' end,
    case when p_lpg is not null and p_lpg >= (p_thresholds->>'lpg_danger')::numeric
      then 'LPG' end,
    case when p_temp is not null
       and (p_temp < (p_thresholds->>'temp_freeze_below')::numeric
         or p_temp > (p_thresholds->>'temp_heat_above')::numeric)
      then 'Temperature' end,
    case when p_humidity is not null
       and (p_humidity < (p_thresholds->>'humidity_dry_below')::numeric
         or p_humidity > (p_thresholds->>'humidity_mold_above')::numeric)
      then 'Humidity' end
  ], null), '{}'::text[]);
$$;

-- Per-metric aggregate object used by report_day_detail and report_month_stats.
create or replace function public.report_metric_obj(
  p_min numeric, p_avg numeric, p_max numeric, p_count bigint, p_unit text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'min', p_min, 'avg', p_avg, 'max', p_max, 'count', p_count, 'unit', p_unit
  );
$$;

-- ---------------------------------------------------------------------------
-- Calendar: one row per Manila day in the month, for the calendar dots.
-- ---------------------------------------------------------------------------

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
  humidity_danger bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with th as (select public.report_thresholds(p_thresholds) v),
  bounds as (
    -- `date + integer` adds DAYS in PostgreSQL, not months. Using `+ 1` here
    -- would bound the month to a single day (the 1st) and silently zero out
    -- every other day of the month.
    select (p_month_start::timestamp at time zone 'Asia/Manila') as lo,
           (((p_month_start + interval '1 month')::date)::timestamp at time zone 'Asia/Manila') as hi
  ),
  days as (
    select generate_series(
      (select lo from bounds),
      (select hi from bounds) - interval '1 second',
      interval '1 day'
    )::timestamptz as ts
  ),
  agg as (
    select (r.created_at at time zone 'Asia/Manila')::date as day,
           count(*)::bigint as reading_count,
           count(*) filter (
             where public.report_is_danger(r.co2, r.lpg, r.temp, r.humidity, th.v)
           )::bigint as danger_readings,
           count(*) filter (
             where r.co2 is not null
               and r.co2 >= (th.v->>'co2_danger')::numeric
           )::bigint as co2_danger,
           count(*) filter (
             where r.lpg is not null
               and r.lpg >= (th.v->>'lpg_danger')::numeric
           )::bigint as lpg_danger,
           count(*) filter (
             where r.temp is not null
               and (r.temp < (th.v->>'temp_freeze_below')::numeric
                 or r.temp > (th.v->>'temp_heat_above')::numeric)
           )::bigint as temp_danger,
           count(*) filter (
             where r.humidity is not null
               and (r.humidity < (th.v->>'humidity_dry_below')::numeric
                 or r.humidity > (th.v->>'humidity_mold_above')::numeric)
           )::bigint as humidity_danger
    from public.readings r
    cross join th
    cross join bounds b
    where (p_device_id is null or r.device_id = p_device_id)
      and r.created_at >= b.lo
      and r.created_at <  b.hi
    group by 1
  )
  -- (d.ts at time zone 'Asia/Manila')::date, NOT d.ts::date: casting a
  -- timestamptz straight to date uses the session TimeZone, which would shift
  -- every label by a day if the session is not on Asia/Manila.
  select (d.ts at time zone 'Asia/Manila')::date,
         coalesce(a.reading_count, 0)::bigint,
         coalesce(a.danger_readings, 0)::bigint,
         coalesce(a.co2_danger, 0)::bigint,
         coalesce(a.lpg_danger, 0)::bigint,
         coalesce(a.temp_danger, 0)::bigint,
         coalesce(a.humidity_danger, 0)::bigint
  from days d
  left join agg a on a.day = (d.ts at time zone 'Asia/Manila')::date
  order by 1;
$$;

comment on function public.report_calendar_month(date, text, jsonb) is
  'Per-day reading and danger counts for one Manila month, used for calendar dots.';

-- ---------------------------------------------------------------------------
-- Selected day: min/avg/max per metric plus a downsampled series for the chart.
-- Series is bucketed to p_bucket_seconds so a full day stays under ~300 points.
-- ---------------------------------------------------------------------------

create or replace function public.report_day_detail(
  p_day date,
  p_device_id text default null,
  p_thresholds jsonb default '{}'::jsonb,
  p_bucket_seconds integer default 300
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with th as (select public.report_thresholds(p_thresholds) v),
  bounds as (
    select (p_day::timestamp at time zone 'Asia/Manila') as lo,
           ((p_day + 1)::timestamp at time zone 'Asia/Manila') as hi
  ),
  scoped as (
    select r.*
    from public.readings r
    cross join bounds b
    where (p_device_id is null or r.device_id = p_device_id)
      and r.created_at >= b.lo
      and r.created_at <  b.hi
  ),
  stats as (
    select count(*)::bigint as reading_count,
           min(co2)::numeric      as co2_min,  avg(co2)::numeric      as co2_avg,  max(co2)::numeric      as co2_max,  count(co2)::bigint      as co2_count,
           min(lpg)::numeric      as lpg_min,  avg(lpg)::numeric      as lpg_avg,  max(lpg)::numeric      as lpg_max,  count(lpg)::bigint      as lpg_count,
           min(temp)::numeric     as temp_min, avg(temp)::numeric     as temp_avg, max(temp)::numeric     as temp_max, count(temp)::bigint     as temp_count,
           min(humidity)::numeric as hum_min,  avg(humidity)::numeric as hum_avg,  max(humidity)::numeric as hum_max,  count(humidity)::bigint as hum_count,
           count(*) filter (
             where public.report_is_danger(co2, lpg, temp, humidity, (select v from th))
           )::bigint as danger_readings,
           count(*) filter (
             where co2 is not null and co2 >= ((select v from th)->>'co2_danger')::numeric
           )::bigint as co2_danger,
           count(*) filter (
             where lpg is not null and lpg >= ((select v from th)->>'lpg_danger')::numeric
           )::bigint as lpg_danger,
           count(*) filter (
             where temp is not null
               and (temp < ((select v from th)->>'temp_freeze_below')::numeric
                 or temp > ((select v from th)->>'temp_heat_above')::numeric)
           )::bigint as temp_danger,
           count(*) filter (
             where humidity is not null
               and (humidity < ((select v from th)->>'humidity_dry_below')::numeric
                 or humidity > ((select v from th)->>'humidity_mold_above')::numeric)
           )::bigint as humidity_danger
    from scoped
  ),
  bucketed as (
    select to_timestamp(
             floor(extract(epoch from created_at) / greatest(1, p_bucket_seconds))
             * greatest(1, p_bucket_seconds)
           ) as bucket_ts,
           avg(co2)::numeric      as co2,
           avg(lpg)::numeric      as lpg,
           avg(temp)::numeric     as temp,
           avg(humidity)::numeric as humidity
    from scoped
    group by 1
    order by 1
  )
  select jsonb_build_object(
    'day', p_day,
    'reading_count', (select reading_count from stats),
    'danger_readings', (select danger_readings from stats),
    'danger_by_metric', jsonb_build_object(
      'co2',      coalesce((select co2_danger from stats), 0),
      'lpg',      coalesce((select lpg_danger from stats), 0),
      'temp',     coalesce((select temp_danger from stats), 0),
      'humidity', coalesce((select humidity_danger from stats), 0)
    ),
    'metrics', jsonb_build_object(
      'co2', public.report_metric_obj(
        (select co2_min from stats), (select co2_avg from stats),
        (select co2_max from stats), (select co2_count from stats), 'ppm'),
      'lpg', public.report_metric_obj(
        (select lpg_min from stats), (select lpg_avg from stats),
        (select lpg_max from stats), (select lpg_count from stats), 'ppm'),
      'temp', public.report_metric_obj(
        (select temp_min from stats), (select temp_avg from stats),
        (select temp_max from stats), (select temp_count from stats), 'C'),
      'humidity', public.report_metric_obj(
        (select hum_min from stats), (select hum_avg from stats),
        (select hum_max from stats), (select hum_count from stats), '%')
    ),
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
        't', bucket_ts,
        'co2', co2, 'lpg', lpg, 'temp', temp, 'humidity', humidity
      ) order by bucket_ts)
      from bucketed
    ), '[]'::jsonb)
  );
$$;

comment on function public.report_day_detail(date, text, jsonb, integer) is
  'Min/avg/max per metric plus a bucketed series for one Manila day.';

-- ---------------------------------------------------------------------------
-- Danger readings for the selected day, paginated (250 per page in the UI).
-- ---------------------------------------------------------------------------

create or replace function public.report_day_danger_rows(
  p_day date,
  p_device_id text default null,
  p_thresholds jsonb default '{}'::jsonb,
  p_limit integer default 250,
  p_offset integer default 0
)
returns table (
  created_at   timestamptz,
  device_id    text,
  co2          numeric,
  lpg          numeric,
  temp         numeric,
  humidity     numeric,
  triggered_by text[]
)
language sql
stable
security invoker
set search_path = public
as $$
  with th as (select public.report_thresholds(p_thresholds) v),
  bounds as (
    select (p_day::timestamp at time zone 'Asia/Manila') as lo,
           ((p_day + 1)::timestamp at time zone 'Asia/Manila') as hi
  )
  select r.created_at,
         r.device_id,
         r.co2,
         r.lpg,
         r.temp,
         r.humidity,
         public.report_triggered_by(r.co2, r.lpg, r.temp, r.humidity, th.v)
  from public.readings r
  cross join bounds b
  cross join th
  where (p_device_id is null or r.device_id = p_device_id)
    and r.created_at >= b.lo
    and r.created_at <  b.hi
    and public.report_is_danger(r.co2, r.lpg, r.temp, r.humidity, th.v)
  order by r.created_at
  limit greatest(1, least(coalesce(p_limit, 250), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.report_day_danger_rows(date, text, jsonb, integer, integer) is
  'Danger readings for one Manila day, ordered by time and paginated.';

-- ---------------------------------------------------------------------------
-- Month statistics for the monthly PDF.
-- ---------------------------------------------------------------------------

create or replace function public.report_month_stats(
  p_year integer,
  p_month integer,
  p_device_id text default null,
  p_thresholds jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with th as (select public.report_thresholds(p_thresholds) v),
  bounds as (
    -- See report_calendar_month: `date + integer` adds days, so the upper
    -- bound must be built with an interval or the "month" covers one day.
    select (make_date(p_year, p_month, 1)::timestamp at time zone 'Asia/Manila') as lo,
           (((make_date(p_year, p_month, 1) + interval '1 month')::date)::timestamp at time zone 'Asia/Manila') as hi
  ),
  scoped as (
    select r.*
    from public.readings r
    cross join bounds b
    where (p_device_id is null or r.device_id = p_device_id)
      and r.created_at >= b.lo
      and r.created_at <  b.hi
  ),
  stats as (
    select count(*)::bigint as reading_count,
           count(distinct (created_at at time zone 'Asia/Manila')::date)::integer as days_with_data,
           min(co2)::numeric      as co2_min,  avg(co2)::numeric      as co2_avg,  max(co2)::numeric      as co2_max,  count(co2)::bigint      as co2_count,
           min(lpg)::numeric      as lpg_min,  avg(lpg)::numeric      as lpg_avg,  max(lpg)::numeric      as lpg_max,  count(lpg)::bigint      as lpg_count,
           min(temp)::numeric     as temp_min, avg(temp)::numeric     as temp_avg, max(temp)::numeric     as temp_max, count(temp)::bigint     as temp_count,
           min(humidity)::numeric as hum_min,  avg(humidity)::numeric as hum_avg,  max(humidity)::numeric as hum_max,  count(humidity)::bigint as hum_count,
           count(*) filter (
             where public.report_is_danger(co2, lpg, temp, humidity, (select v from th))
           )::bigint as danger_readings,
           count(distinct (created_at at time zone 'Asia/Manila')::date) filter (
             where public.report_is_danger(co2, lpg, temp, humidity, (select v from th))
           )::integer as days_with_danger,
           count(*) filter (
             where co2 is not null and co2 >= ((select v from th)->>'co2_danger')::numeric
           )::bigint as co2_danger,
           count(*) filter (
             where lpg is not null and lpg >= ((select v from th)->>'lpg_danger')::numeric
           )::bigint as lpg_danger,
           count(*) filter (
             where temp is not null
               and (temp < ((select v from th)->>'temp_freeze_below')::numeric
                 or temp > ((select v from th)->>'temp_heat_above')::numeric)
           )::bigint as temp_danger,
           count(*) filter (
             where humidity is not null
               and (humidity < ((select v from th)->>'humidity_dry_below')::numeric
                 or humidity > ((select v from th)->>'humidity_mold_above')::numeric)
           )::bigint as humidity_danger
    from scoped
  ),
  daily as (
    select (created_at at time zone 'Asia/Manila')::date as day,
           count(*)::bigint as reading_count,
           count(*) filter (
             where public.report_is_danger(co2, lpg, temp, humidity, (select v from th))
           )::bigint as danger_readings,
           avg(co2)::numeric      as co2_avg, min(co2)::numeric      as co2_min, max(co2)::numeric      as co2_max,
           avg(lpg)::numeric      as lpg_avg, min(lpg)::numeric      as lpg_min, max(lpg)::numeric      as lpg_max,
           avg(temp)::numeric     as temp_avg, min(temp)::numeric    as temp_min, max(temp)::numeric    as temp_max,
           avg(humidity)::numeric as hum_avg, min(humidity)::numeric as hum_min, max(humidity)::numeric as hum_max
    from scoped
    group by 1
    order by 1
  ),
  daily_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'day', day,
      'reading_count', reading_count,
      'danger_readings', danger_readings,
      'co2_avg', co2_avg, 'co2_min', co2_min, 'co2_max', co2_max,
      'lpg_avg', lpg_avg, 'lpg_min', lpg_min, 'lpg_max', lpg_max,
      'temp_avg', temp_avg, 'temp_min', temp_min, 'temp_max', temp_max,
      'humidity_avg', hum_avg, 'humidity_min', hum_min, 'humidity_max', hum_max
    ) order by day), '[]'::jsonb) as v
    from daily
  ),
  worst as (
    select jsonb_build_object(
      'day', day,
      'danger_readings', danger_readings,
      'reading_count', reading_count
    ) as v
    from daily
    order by danger_readings desc, day
    limit 1
  )
  select jsonb_build_object(
    'year', p_year,
    'month', p_month,
    'device_id', p_device_id,
    'reading_count', (select reading_count from stats),
    'danger_readings', (select danger_readings from stats),
    'days_with_data', (select days_with_data from stats),
    'days_with_danger', (select days_with_danger from stats),
    'thresholds', (select v from th),
    'danger_by_metric', jsonb_build_object(
      'co2',      coalesce((select co2_danger from stats), 0),
      'lpg',      coalesce((select lpg_danger from stats), 0),
      'temp',     coalesce((select temp_danger from stats), 0),
      'humidity', coalesce((select humidity_danger from stats), 0)
    ),
    'metrics', jsonb_build_object(
      'co2', public.report_metric_obj(
        (select co2_min from stats), (select co2_avg from stats),
        (select co2_max from stats), (select co2_count from stats), 'ppm'),
      'lpg', public.report_metric_obj(
        (select lpg_min from stats), (select lpg_avg from stats),
        (select lpg_max from stats), (select lpg_count from stats), 'ppm'),
      'temp', public.report_metric_obj(
        (select temp_min from stats), (select temp_avg from stats),
        (select temp_max from stats), (select temp_count from stats), 'C'),
      'humidity', public.report_metric_obj(
        (select hum_min from stats), (select hum_avg from stats),
        (select hum_max from stats), (select hum_count from stats), '%')
    ),
    'daily', (select v from daily_json),
    'worst_day', (select v from worst)
  );
$$;

comment on function public.report_month_stats(integer, integer, text, jsonb) is
  'Whole-month summary plus a per-day series, used to build the monthly PDF.';

-- ---------------------------------------------------------------------------
-- Grants + PostgREST schema reload.
-- ---------------------------------------------------------------------------

-- REVOKE must name PUBLIC, not anon. `create function` grants EXECUTE to the
-- pseudo-role PUBLIC by default, and `anon` is only an implicit member of it,
-- so `revoke ... from anon` removes a grant that was never made and leaves
-- every one of these RPCs callable by an unauthenticated caller holding only
-- the public anon key. Revoke from public FIRST, then re-grant narrowly.
revoke execute on function public.report_thresholds(jsonb) from public;
revoke execute on function public.report_is_danger(numeric, numeric, numeric, numeric, jsonb) from public;
revoke execute on function public.report_triggered_by(numeric, numeric, numeric, numeric, jsonb) from public;
revoke execute on function public.report_metric_obj(numeric, numeric, numeric, bigint, text) from public;
revoke execute on function public.report_calendar_month(date, text, jsonb) from public;
revoke execute on function public.report_day_detail(date, text, jsonb, integer) from public;
revoke execute on function public.report_day_danger_rows(date, text, jsonb, integer, integer) from public;
revoke execute on function public.report_month_stats(integer, integer, text, jsonb) from public;

revoke execute on function public.report_thresholds(jsonb) from anon;
revoke execute on function public.report_is_danger(numeric, numeric, numeric, numeric, jsonb) from anon;
revoke execute on function public.report_triggered_by(numeric, numeric, numeric, numeric, jsonb) from anon;
revoke execute on function public.report_metric_obj(numeric, numeric, numeric, bigint, text) from anon;
revoke execute on function public.report_calendar_month(date, text, jsonb) from anon;
revoke execute on function public.report_day_detail(date, text, jsonb, integer) from anon;
revoke execute on function public.report_day_danger_rows(date, text, jsonb, integer, integer) from anon;
revoke execute on function public.report_month_stats(integer, integer, text, jsonb) from anon;

grant execute on function public.report_thresholds(jsonb) to authenticated;
grant execute on function public.report_is_danger(numeric, numeric, numeric, numeric, jsonb) to authenticated;
grant execute on function public.report_triggered_by(numeric, numeric, numeric, numeric, jsonb) to authenticated;
grant execute on function public.report_metric_obj(numeric, numeric, numeric, bigint, text) to authenticated;
grant execute on function public.report_calendar_month(date, text, jsonb) to authenticated;
grant execute on function public.report_day_detail(date, text, jsonb, integer) to authenticated;
grant execute on function public.report_day_danger_rows(date, text, jsonb, integer, integer) to authenticated;
grant execute on function public.report_month_stats(integer, integer, text, jsonb) to authenticated;

notify pgrst, 'reload schema';