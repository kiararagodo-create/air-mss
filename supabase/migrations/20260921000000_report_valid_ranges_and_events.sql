-- Additive migration: valid physical ranges, excluded counts, danger events,
-- and danger rows for the monthly report. Does not touch readings data.

-- 1. Redefine report_is_danger to ignore physically impossible values and
--    suspected DHT22 faults (temp=0 AND humidity=0).
create or replace function public.report_is_danger(
  p_co2 numeric, p_lpg numeric, p_temp numeric, p_humidity numeric, p_thresholds jsonb
) returns boolean language sql immutable as $$
  select
    (p_co2 is not null and p_co2 between 0 and 10000
       and p_co2 >= (p_thresholds->>'co2_danger')::numeric)
    or
    (p_lpg is not null and p_lpg between 0 and 10000
       and p_lpg >= (p_thresholds->>'lpg_danger')::numeric)
    or
    (p_temp is not null and p_temp between -40 and 80
       and not (p_temp = 0 and p_humidity = 0)
       and (p_temp < (p_thresholds->>'temp_freeze_below')::numeric
         or p_temp > (p_thresholds->>'temp_heat_above')::numeric))
    or
    (p_humidity is not null and p_humidity between 0 and 100
       and not (p_temp = 0 and p_humidity = 0)
       and (p_humidity < (p_thresholds->>'humidity_dry_below')::numeric
         or p_humidity > (p_thresholds->>'humidity_mold_above')::numeric));
$$;

create or replace function public.report_triggered_by(
  p_co2 numeric, p_lpg numeric, p_temp numeric, p_humidity numeric, p_thresholds jsonb
) returns text[] language sql immutable as $$
  select coalesce(array_remove(array[
    case when p_co2 is not null and p_co2 between 0 and 10000
              and p_co2 >= (p_thresholds->>'co2_danger')::numeric
         then 'CO2' end,
    case when p_lpg is not null and p_lpg between 0 and 10000
              and p_lpg >= (p_thresholds->>'lpg_danger')::numeric
         then 'LPG' end,
    case when p_temp is not null and p_temp between -40 and 80
              and not (p_temp = 0 and p_humidity = 0)
              and (p_temp < (p_thresholds->>'temp_freeze_below')::numeric
                or p_temp > (p_thresholds->>'temp_heat_above')::numeric)
         then 'Temperature' end,
    case when p_humidity is not null and p_humidity between 0 and 100
              and not (p_temp = 0 and p_humidity = 0)
              and (p_humidity < (p_thresholds->>'humidity_dry_below')::numeric
                or p_humidity > (p_thresholds->>'humidity_mold_above')::numeric)
         then 'Humidity' end
  ], null), '{}'::text[]);
$$;

-- 2. report_day_detail: valid-only aggregates + excluded counts.
create or replace function public.report_day_detail(
  p_day date, p_device_id text default null, p_thresholds jsonb default '{}'::jsonb, p_bucket_seconds integer default 300
) returns jsonb language sql stable security invoker set search_path = public as $$
  with th as (select public.report_thresholds(p_thresholds) v),
  bounds as (select (p_day::timestamp at time zone 'Asia/Manila') as lo, ((p_day + 1)::timestamp at time zone 'Asia/Manila') as hi),
  scoped as (select r.* from public.readings r cross join bounds b where (p_device_id is null or r.device_id = p_device_id) and r.created_at >= b.lo and r.created_at < b.hi),
  stats as (
    select count(*)::bigint as reading_count,
      count(co2) filter (where co2 between 0 and 10000)::bigint as co2_count,
      min(co2) filter (where co2 between 0 and 10000)::numeric as co2_min,
      avg(co2) filter (where co2 between 0 and 10000)::numeric as co2_avg,
      max(co2) filter (where co2 between 0 and 10000)::numeric as co2_max,
      count(lpg) filter (where lpg between 0 and 10000)::bigint as lpg_count,
      min(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_min,
      avg(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_avg,
      max(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_max,
      count(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::bigint as temp_count,
      min(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_min,
      avg(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_avg,
      max(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_max,
      count(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::bigint as hum_count,
      min(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_min,
      avg(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_avg,
      max(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_max,
      count(*) filter (where public.report_is_danger(co2, lpg, temp, humidity, (select v from th)))::bigint as danger_readings,
      count(*) filter (where co2 is not null and not (co2 between 0 and 10000))::bigint as co2_excl,
      count(*) filter (where lpg is not null and not (lpg between 0 and 10000))::bigint as lpg_excl,
      count(*) filter (where temp is not null and (temp not between -40 and 80 or (temp = 0 and humidity = 0)))::bigint as temp_excl,
      count(*) filter (where humidity is not null and (humidity not between 0 and 100 or (temp = 0 and humidity = 0)))::bigint as hum_excl,
      count(*) filter (where
        (co2 is not null and not (co2 between 0 and 10000)) or
        (lpg is not null and not (lpg between 0 and 10000)) or
        (temp is not null and (temp not between -40 and 80 or (temp = 0 and humidity = 0))) or
        (humidity is not null and (humidity not between 0 and 100 or (temp = 0 and humidity = 0)))
      )::bigint as sensor_fault_readings,
      count(*) filter (where co2 is not null and co2 >= ((select v from th)->>'co2_danger')::numeric and co2 between 0 and 10000)::bigint as co2_danger,
      count(*) filter (where lpg is not null and lpg >= ((select v from th)->>'lpg_danger')::numeric and lpg between 0 and 10000)::bigint as lpg_danger,
      count(*) filter (where temp is not null and (temp < ((select v from th)->>'temp_freeze_below')::numeric or temp > ((select v from th)->>'temp_heat_above')::numeric) and temp between -40 and 80 and not (temp = 0 and humidity = 0))::bigint as temp_danger,
      count(*) filter (where humidity is not null and (humidity < ((select v from th)->>'humidity_dry_below')::numeric or humidity > ((select v from th)->>'humidity_mold_above')::numeric) and humidity between 0 and 100 and not (temp = 0 and humidity = 0))::bigint as humidity_danger
    from scoped
  ),
  bucketed as (
    select to_timestamp(floor(extract(epoch from created_at) / greatest(1, p_bucket_seconds)) * greatest(1, p_bucket_seconds)) as bucket_ts,
      avg(co2) filter (where co2 between 0 and 10000)::numeric as co2,
      avg(lpg) filter (where lpg between 0 and 10000)::numeric as lpg,
      avg(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp,
      avg(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as humidity
    from scoped group by 1 order by 1
  )
  select jsonb_build_object(
    'day', p_day,
    'reading_count', (select reading_count from stats),
    'danger_readings', (select danger_readings from stats),
    'sensor_fault_readings', (select sensor_fault_readings from stats),
    'excluded', jsonb_build_object(
      'co2', (select co2_excl from stats),
      'lpg', (select lpg_excl from stats),
      'temp', (select temp_excl from stats),
      'humidity', (select hum_excl from stats)
    ),
    'danger_by_metric', jsonb_build_object(
      'co2', coalesce((select co2_danger from stats), 0),
      'lpg', coalesce((select lpg_danger from stats), 0),
      'temp', coalesce((select temp_danger from stats), 0),
      'humidity', coalesce((select humidity_danger from stats), 0)
    ),
    'metrics', jsonb_build_object(
      'co2', public.report_metric_obj((select co2_min from stats), (select co2_avg from stats), (select co2_max from stats), (select co2_count from stats), 'ppm'),
      'lpg', public.report_metric_obj((select lpg_min from stats), (select lpg_avg from stats), (select lpg_max from stats), (select lpg_count from stats), 'ppm'),
      'temp', public.report_metric_obj((select temp_min from stats), (select temp_avg from stats), (select temp_max from stats), (select temp_count from stats), 'C'),
      'humidity', public.report_metric_obj((select hum_min from stats), (select hum_avg from stats), (select hum_max from stats), (select hum_count from stats), '%')
    ),
    'series', coalesce((select jsonb_agg(jsonb_build_object('t', bucket_ts, 'co2', co2, 'lpg', lpg, 'temp', temp, 'humidity', humidity) order by bucket_ts) from bucketed), '[]'::jsonb)
  );
$$;

-- 3. report_month_stats: valid-only aggregates + excluded + sensor fault count.
create or replace function public.report_month_stats(
  p_year integer, p_month integer, p_device_id text default null, p_thresholds jsonb default '{}'::jsonb
) returns jsonb language sql stable security invoker set search_path = public as $$
  with th as (select public.report_thresholds(p_thresholds) v),
  bounds as (select (make_date(p_year, p_month, 1)::timestamp at time zone 'Asia/Manila') as lo, (((make_date(p_year, p_month, 1) + interval '1 month')::date)::timestamp at time zone 'Asia/Manila') as hi),
  scoped as (select r.* from public.readings r cross join bounds b where (p_device_id is null or r.device_id = p_device_id) and r.created_at >= b.lo and r.created_at < b.hi),
  stats as (
    select count(*)::bigint as reading_count,
      count(distinct (created_at at time zone 'Asia/Manila')::date)::integer as days_with_data,
      count(co2) filter (where co2 between 0 and 10000)::bigint as co2_count,
      min(co2) filter (where co2 between 0 and 10000)::numeric as co2_min,
      avg(co2) filter (where co2 between 0 and 10000)::numeric as co2_avg,
      max(co2) filter (where co2 between 0 and 10000)::numeric as co2_max,
      count(lpg) filter (where lpg between 0 and 10000)::bigint as lpg_count,
      min(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_min,
      avg(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_avg,
      max(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_max,
      count(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::bigint as temp_count,
      min(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_min,
      avg(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_avg,
      max(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_max,
      count(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::bigint as hum_count,
      min(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_min,
      avg(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_avg,
      max(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_max,
      count(*) filter (where public.report_is_danger(co2, lpg, temp, humidity, (select v from th)))::bigint as danger_readings,
      count(distinct (created_at at time zone 'Asia/Manila')::date) filter (where public.report_is_danger(co2, lpg, temp, humidity, (select v from th)))::integer as days_with_danger,
      count(*) filter (where co2 is not null and not (co2 between 0 and 10000))::bigint as co2_excl,
      count(*) filter (where lpg is not null and not (lpg between 0 and 10000))::bigint as lpg_excl,
      count(*) filter (where temp is not null and (temp not between -40 and 80 or (temp = 0 and humidity = 0)))::bigint as temp_excl,
      count(*) filter (where humidity is not null and (humidity not between 0 and 100 or (temp = 0 and humidity = 0)))::bigint as hum_excl,
      count(*) filter (where
        (co2 is not null and not (co2 between 0 and 10000)) or
        (lpg is not null and not (lpg between 0 and 10000)) or
        (temp is not null and (temp not between -40 and 80 or (temp = 0 and humidity = 0))) or
        (humidity is not null and (humidity not between 0 and 100 or (temp = 0 and humidity = 0)))
      )::bigint as sensor_fault_readings,
      count(*) filter (where co2 is not null and co2 >= ((select v from th)->>'co2_danger')::numeric and co2 between 0 and 10000)::bigint as co2_danger,
      count(*) filter (where lpg is not null and lpg >= ((select v from th)->>'lpg_danger')::numeric and lpg between 0 and 10000)::bigint as lpg_danger,
      count(*) filter (where temp is not null and (temp < ((select v from th)->>'temp_freeze_below')::numeric or temp > ((select v from th)->>'temp_heat_above')::numeric) and temp between -40 and 80 and not (temp = 0 and humidity = 0))::bigint as temp_danger,
      count(*) filter (where humidity is not null and (humidity < ((select v from th)->>'humidity_dry_below')::numeric or humidity > ((select v from th)->>'humidity_mold_above')::numeric) and humidity between 0 and 100 and not (temp = 0 and humidity = 0))::bigint as humidity_danger
    from scoped
  ),
  daily as (
    select (created_at at time zone 'Asia/Manila')::date as day,
      count(*)::bigint as reading_count,
      count(*) filter (where public.report_is_danger(co2, lpg, temp, humidity, (select v from th)))::bigint as danger_readings,
      avg(co2) filter (where co2 between 0 and 10000)::numeric as co2_avg,
      min(co2) filter (where co2 between 0 and 10000)::numeric as co2_min,
      max(co2) filter (where co2 between 0 and 10000)::numeric as co2_max,
      avg(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_avg,
      min(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_min,
      max(lpg) filter (where lpg between 0 and 10000)::numeric as lpg_max,
      avg(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_avg,
      min(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_min,
      max(temp) filter (where temp between -40 and 80 and not (temp = 0 and humidity = 0))::numeric as temp_max,
      avg(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_avg,
      min(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_min,
      max(humidity) filter (where humidity between 0 and 100 and not (temp = 0 and humidity = 0))::numeric as hum_max
    from scoped group by 1 order by 1
  ),
  daily_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'day', day, 'reading_count', reading_count, 'danger_readings', danger_readings,
      'co2_avg', co2_avg, 'co2_min', co2_min, 'co2_max', co2_max,
      'lpg_avg', lpg_avg, 'lpg_min', lpg_min, 'lpg_max', lpg_max,
      'temp_avg', temp_avg, 'temp_min', temp_min, 'temp_max', temp_max,
      'humidity_avg', hum_avg, 'humidity_min', hum_min, 'humidity_max', hum_max
    ) order by day), '[]'::jsonb) as v from daily
  ),
  worst as (select jsonb_build_object('day', day, 'danger_readings', danger_readings, 'reading_count', reading_count) as v from daily order by danger_readings desc, day limit 1)
  select jsonb_build_object(
    'year', p_year, 'month', p_month, 'device_id', p_device_id,
    'reading_count', (select reading_count from stats),
    'danger_readings', (select danger_readings from stats),
    'days_with_data', (select days_with_data from stats),
    'days_with_danger', (select days_with_danger from stats),
    'sensor_fault_readings', (select sensor_fault_readings from stats),
    'excluded', jsonb_build_object(
      'co2', (select co2_excl from stats),
      'lpg', (select lpg_excl from stats),
      'temp', (select temp_excl from stats),
      'humidity', (select hum_excl from stats)
    ),
    'thresholds', (select v from th),
    'danger_by_metric', jsonb_build_object(
      'co2', coalesce((select co2_danger from stats), 0),
      'lpg', coalesce((select lpg_danger from stats), 0),
      'temp', coalesce((select temp_danger from stats), 0),
      'humidity', coalesce((select humidity_danger from stats), 0)
    ),
    'metrics', jsonb_build_object(
      'co2', public.report_metric_obj((select co2_min from stats), (select co2_avg from stats), (select co2_max from stats), (select co2_count from stats), 'ppm'),
      'lpg', public.report_metric_obj((select lpg_min from stats), (select lpg_avg from stats), (select lpg_max from stats), (select lpg_count from stats), 'ppm'),
      'temp', public.report_metric_obj((select temp_min from stats), (select temp_avg from stats), (select temp_max from stats), (select temp_count from stats), 'C'),
      'humidity', public.report_metric_obj((select hum_min from stats), (select hum_avg from stats), (select hum_max from stats), (select hum_count from stats), '%')
    ),
    'daily', (select v from daily_json),
    'worst_day', (select v from worst)
  );
$$;

-- 4. Monthly danger events
create or replace function public.report_month_danger_events(
  p_year integer, p_month integer, p_device_id text default null, p_thresholds jsonb default '{}'::jsonb
) returns table (
  started_at timestamptz, ended_at timestamptz, duration_seconds integer,
  reading_count bigint, sensors text[], peak_metric text, peak_value numeric, peak_time timestamptz
) language sql stable security invoker set search_path = public as $$
  with th as (select public.report_thresholds(p_thresholds) v),
  bounds as (select (make_date(p_year, p_month, 1)::timestamp at time zone 'Asia/Manila') as lo, (((make_date(p_year, p_month, 1) + interval '1 month')::date)::timestamp at time zone 'Asia/Manila') as hi),
  scoped as (select r.* from public.readings r cross join bounds b where (p_device_id is null or r.device_id = p_device_id) and r.created_at >= b.lo and r.created_at < b.hi),
  classified as (
    select r.created_at, r.co2, r.lpg, r.temp, r.humidity,
      public.report_is_danger(r.co2, r.lpg, r.temp, r.humidity, th.v) as is_danger,
      public.report_triggered_by(r.co2, r.lpg, r.temp, r.humidity, th.v) as triggered
    from scoped r cross join th
  ),
  numbered as (
    select created_at, co2, lpg, temp, humidity, is_danger, triggered,
      row_number() over (order by created_at) as rn,
      row_number() over (partition by is_danger order by created_at) as rn2
    from classified
  ),
  danger_rows as (
    select created_at, co2, lpg, temp, humidity, triggered, (rn - rn2) as grp
    from numbered where is_danger
  ),
  events as (
    select grp,
      min(created_at) as started_at,
      max(created_at) as ended_at,
      count(*)::bigint as reading_count,
      (select array_agg(distinct s) from (select unnest(array_agg(dr.triggered)) as s) x) as sensors
    from danger_rows dr group by grp
  ),
  peaks as (
    select e.*,
      case when 'CO2' = any(e.sensors) then 'CO2'
           when 'LPG' = any(e.sensors) then 'LPG'
           when 'Temperature' = any(e.sensors) then 'Temperature'
           when 'Humidity' = any(e.sensors) then 'Humidity' end as peak_metric
    from events e
  )
  select p.started_at, p.ended_at,
    extract(epoch from (p.ended_at - p.started_at))::integer as duration_seconds,
    p.reading_count, p.sensors, p.peak_metric,
    case p.peak_metric
      when 'CO2' then (select max(r.co2) from scoped r where r.created_at >= p.started_at and r.created_at <= p.ended_at)
      when 'LPG' then (select max(r.lpg) from scoped r where r.created_at >= p.started_at and r.created_at <= p.ended_at)
      when 'Temperature' then (select max(r.temp) from scoped r where r.created_at >= p.started_at and r.created_at <= p.ended_at)
      when 'Humidity' then (select max(r.humidity) from scoped r where r.created_at >= p.started_at and r.created_at <= p.ended_at)
    end as peak_value,
    case p.peak_metric
      when 'CO2' then (select r.created_at from scoped r where r.created_at >= p.started_at and r.created_at <= p.ended_at and r.co2 = (select max(r2.co2) from scoped r2 where r2.created_at >= p.started_at and r2.created_at <= p.ended_at) order by r.created_at limit 1)
      when 'LPG' then (select r.created_at from scoped r where r.created_at >= p.started_at and r.created_at <= p.ended_at and r.lpg = (select max(r2.lpg) from scoped r2 where r2.created_at >= p.started_at and r2.created_at <= p.ended_at) order by r.created_at limit 1)
      when 'Temperature' then (select r.created_at from scoped r where r.created_at >= p.started_at and r.created_at <= p.ended_at and r.temp = (select max(r2.temp) from scoped r2 where r2.created_at >= p.started_at and r2.created_at <= p.ended_at) order by r.created_at limit 1)
      when 'Humidity' then (select r.created_at from scoped r where r.created_at >= p.started_at and r.created_at <= p.ended_at and r.humidity = (select max(r2.humidity) from scoped r2 where r2.created_at >= p.started_at and r2.created_at <= p.ended_at) order by r.created_at limit 1)
    end as peak_time
  from peaks p
  order by p.started_at;
$$;

-- 5. Monthly danger rows (paged)
create or replace function public.report_month_danger_rows(
  p_year integer, p_month integer, p_device_id text default null, p_thresholds jsonb default '{}'::jsonb,
  p_limit integer default 250, p_offset integer default 0
) returns table (
  created_at timestamptz, device_id text, co2 numeric, lpg numeric, temp numeric, humidity numeric, triggered_by text[]
) language sql stable security invoker set search_path = public as $$
  with th as (select public.report_thresholds(p_thresholds) v),
  bounds as (select (make_date(p_year, p_month, 1)::timestamp at time zone 'Asia/Manila') as lo, (((make_date(p_year, p_month, 1) + interval '1 month')::date)::timestamp at time zone 'Asia/Manila') as hi)
  select r.created_at, r.device_id, r.co2, r.lpg, r.temp, r.humidity,
    public.report_triggered_by(r.co2, r.lpg, r.temp, r.humidity, th.v)
  from public.readings r cross join bounds b cross join th
  where (p_device_id is null or r.device_id = p_device_id)
    and r.created_at >= b.lo and r.created_at < b.hi
    and public.report_is_danger(r.co2, r.lpg, r.temp, r.humidity, th.v)
  order by r.created_at
  limit greatest(1, least(coalesce(p_limit, 250), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- Grants
revoke execute on function public.report_day_detail(date, text, jsonb, integer) from public;
revoke execute on function public.report_day_detail(date, text, jsonb, integer) from anon;
revoke execute on function public.report_month_stats(integer, integer, text, jsonb) from public;
revoke execute on function public.report_month_stats(integer, integer, text, jsonb) from anon;
revoke execute on function public.report_month_danger_events(integer, integer, text, jsonb) from public;
revoke execute on function public.report_month_danger_events(integer, integer, text, jsonb) from anon;
revoke execute on function public.report_month_danger_rows(integer, integer, text, jsonb, integer, integer) from public;
revoke execute on function public.report_month_danger_rows(integer, integer, text, jsonb, integer, integer) from anon;

grant execute on function public.report_day_detail(date, text, jsonb, integer) to authenticated;
grant execute on function public.report_month_stats(integer, integer, text, jsonb) to authenticated;
grant execute on function public.report_month_danger_events(integer, integer, text, jsonb) to authenticated;
grant execute on function public.report_month_danger_rows(integer, integer, text, jsonb, integer, integer) to authenticated;

notify pgrst, 'reload schema';
