-- Upgrade SQL helpers for improved PDF reporting:
-- 1. sensor_readings_stats: add min_val_at / max_val_at (timestamps)
-- 2. sensor_readings_events: add peak_val / peak_val_at (peak within event)
-- 3. sensor_readings_daily_summary: add first_reading / last_reading / reading_count;
--    return ALL calendar days in the range (fill gaps with NO DATA rows)

drop function if exists public.sensor_readings_stats(text, timestamptz, timestamptz);
drop function if exists public.sensor_readings_events(text, timestamptz, timestamptz, text, double precision, double precision);
drop function if exists public.sensor_readings_daily_summary(text, timestamptz, timestamptz);

-- 4a. Per-metric statistics with timestamps for min/max values.
create or replace function public.sensor_readings_stats(
  p_device_id    text,
  p_window_start timestamptz,
  p_window_end   timestamptz
)
returns table (
  metric             text,
  reading_count      bigint,
  min_val            double precision,
  max_val            double precision,
  avg_val            double precision,
  median_val         double precision,
  stddev_val         double precision,
  safe_count         bigint,
  warning_count      bigint,
  danger_count       bigint,
  warning_threshold  double precision,
  danger_threshold   double precision,
  min_val_at         timestamptz,
  max_val_at         timestamptz
)
language sql
stable
as $$
  with windowed as (
    select * from public.readings
    where device_id = p_device_id
      and created_at >= p_window_start
      and created_at < p_window_end
  ),
  co2_r as (
    select co2, created_at from windowed where co2 is not null
  ),
  lpg_r as (
    select lpg, created_at from windowed where lpg is not null
  ),
  temp_r as (
    select temp, created_at from windowed where temp is not null
  ),
  hum_r as (
    select humidity, created_at from windowed where humidity is not null
  )
  select * from (
    select
      'co2'::text as metric,
      count(*)::bigint as reading_count,
      min(r.co2)::double precision as min_val,
      max(r.co2)::double precision as max_val,
      avg(r.co2)::double precision as avg_val,
      percentile_cont(0.5) within group (order by r.co2)::double precision as median_val,
      stddev_samp(r.co2)::double precision as stddev_val,
      count(*) filter (where r.co2 < 1000)::bigint as safe_count,
      count(*) filter (where r.co2 >= 1000 and r.co2 < 3500)::bigint as warning_count,
      count(*) filter (where r.co2 >= 3500)::bigint as danger_count,
      1000::double precision as warning_threshold,
      3500::double precision as danger_threshold,
      (select w2.created_at from co2_r w2 where w2.co2 = min(r.co2) order by w2.created_at limit 1) as min_val_at,
      (select w3.created_at from co2_r w3 where w3.co2 = max(r.co2) order by w3.created_at limit 1) as max_val_at
    from co2_r r
    union all
    select
      'lpg'::text as metric,
      count(*)::bigint as reading_count,
      min(r.lpg)::double precision as min_val,
      max(r.lpg)::double precision as max_val,
      avg(r.lpg)::double precision as avg_val,
      percentile_cont(0.5) within group (order by r.lpg)::double precision as median_val,
      stddev_samp(r.lpg)::double precision as stddev_val,
      count(*) filter (where r.lpg < 1000)::bigint as safe_count,
      count(*) filter (where r.lpg >= 1000 and r.lpg < 5000)::bigint as warning_count,
      count(*) filter (where r.lpg >= 5000)::bigint as danger_count,
      1000::double precision as warning_threshold,
      5000::double precision as danger_threshold,
      (select w2.created_at from lpg_r w2 where w2.lpg = min(r.lpg) order by w2.created_at limit 1) as min_val_at,
      (select w3.created_at from lpg_r w3 where w3.lpg = max(r.lpg) order by w3.created_at limit 1) as max_val_at
    from lpg_r r
    union all
    select
      'temp'::text as metric,
      count(*)::bigint as reading_count,
      min(r.temp)::double precision as min_val,
      max(r.temp)::double precision as max_val,
      avg(r.temp)::double precision as avg_val,
      percentile_cont(0.5) within group (order by r.temp)::double precision as median_val,
      stddev_samp(r.temp)::double precision as stddev_val,
      count(*) filter (where r.temp >= 5 and r.temp <= 35)::bigint as safe_count,
      count(*) filter (where r.temp < 5 or r.temp > 35)::bigint as warning_count,
      count(*) filter (where r.temp < 5 or r.temp > 35)::bigint as danger_count,
      35::double precision as warning_threshold,
      35::double precision as danger_threshold,
      (select w2.created_at from temp_r w2 where w2.temp = min(r.temp) order by w2.created_at limit 1) as min_val_at,
      (select w3.created_at from temp_r w3 where w3.temp = max(r.temp) order by w3.created_at limit 1) as max_val_at
    from temp_r r
    union all
    select
      'humidity'::text as metric,
      count(*)::bigint as reading_count,
      min(r.humidity)::double precision as min_val,
      max(r.humidity)::double precision as max_val,
      avg(r.humidity)::double precision as avg_val,
      percentile_cont(0.5) within group (order by r.humidity)::double precision as median_val,
      stddev_samp(r.humidity)::double precision as stddev_val,
      count(*) filter (where r.humidity >= 20 and r.humidity <= 80)::bigint as safe_count,
      count(*) filter (where r.humidity < 20 or r.humidity > 80)::bigint as warning_count,
      count(*) filter (where r.humidity < 20 or r.humidity > 80)::bigint as danger_count,
      80::double precision as warning_threshold,
      80::double precision as danger_threshold,
      (select w2.created_at from hum_r w2 where w2.humidity = min(r.humidity) order by w2.created_at limit 1) as min_val_at,
      (select w3.created_at from hum_r w3 where w3.humidity = max(r.humidity) order by w3.created_at limit 1) as max_val_at
    from hum_r r
  ) t
  where reading_count > 0;
$$;

-- 4c. Events with peak value and peak timestamp within each event.
create or replace function public.sensor_readings_events(
  p_device_id     text,
  p_window_start  timestamptz,
  p_window_end    timestamptz,
  p_metric        text,
  p_warning_threshold double precision,
  p_danger_threshold  double precision
)
returns table (
  status            text,
  started_at        timestamptz,
  ended_at          timestamptz,
  duration_seconds  integer,
  reading_count     integer,
  peak_val          double precision,
  peak_val_at       timestamptz
)
language sql
stable
as $$
  with raw as (
    select created_at,
      case p_metric
        when 'co2'      then co2
        when 'lpg'      then lpg
        when 'temp'     then temp
        when 'humidity' then humidity
      end as v
    from public.readings
    where device_id = p_device_id
      and created_at >= p_window_start
      and created_at < p_window_end
  ),
  classed as (
    select created_at, v,
      case
        when v >= p_danger_threshold  then 'DANGER'
        when v >= p_warning_threshold then 'WARNING'
        else 'SAFE'
      end as status
    from raw where v is not null
  ),
  islands as (
    select created_at, v, status,
      row_number() over (order by created_at)
        - row_number() over (partition by
            case when v >= p_danger_threshold  then 'D'
                 when v >= p_warning_threshold then 'W'
                 else 'S' end
            order by created_at) as grp
    from classed
    where status in ('WARNING', 'DANGER')
  )
  select
    status,
    min(created_at) as started_at,
    max(created_at) as ended_at,
    (extract(epoch from max(created_at) - min(created_at)))::integer as duration_seconds,
    count(*)::integer as reading_count,
    max(v)::double precision as peak_val,
    (select created_at from raw r2
       where r2.v = max(islands.v)
         and r2.created_at between min(islands.created_at) and max(islands.created_at)
       order by r2.created_at limit 1) as peak_val_at
  from islands
  group by status, grp
  order by min(created_at);
$$;

-- 4d. Per-day rollup with timestamps, counts, and ALL calendar days in range.
create or replace function public.sensor_readings_daily_summary(
  p_device_id    text,
  p_window_start timestamptz,
  p_window_end   timestamptz
)
returns table (
  day             date,
  first_reading  timestamptz,
  last_reading   timestamptz,
  reading_count  bigint,
  co2_avg        double precision,
  co2_max        double precision,
  lpg_avg        double precision,
  lpg_max        double precision,
  temp_avg       double precision,
  temp_max       double precision,
  humidity_avg   double precision,
  humidity_max   double precision,
  dominant_status text
)
language sql
stable
as $$
  with
  manila_days as (
    select d::date as day
    from generate_series(
      (p_window_start at time zone 'Asia/Manila')::date,
      (p_window_end   at time zone 'Asia/Manila')::date - interval '1 day',
      '1 day'::interval
    ) d
  ),
  bucketed as (
    select
      (created_at at time zone 'Asia/Manila')::date as day,
      min(created_at) as first_reading,
      max(created_at) as last_reading,
      count(*) as reading_count,
      avg(co2)::double precision as c_avg,    max(co2)::double precision as c_max,
      avg(lpg)::double precision as l_avg,    max(lpg)::double precision as l_max,
      avg(temp)::double precision as t_avg,   max(temp)::double precision as t_max,
      avg(humidity)::double precision as h_avg, max(humidity)::double precision as h_max,
      greatest(
        case when max(co2)      >= 3500 then 2 when max(co2)      >= 1000 then 1 else 0 end,
        case when max(lpg)      >= 5000 then 2 when max(lpg)      >= 1000 then 1 else 0 end,
        case when max(temp) < 5 or max(temp) > 35 then 2
             when max(temp) < 18 or max(temp) > 33 then 1 else 0 end,
        case when max(humidity) < 20 or max(humidity) > 80 then 2
             when max(humidity) < 30 or max(humidity) > 70 then 1 else 0 end
      ) as sev
    from public.readings
    where device_id = p_device_id
      and created_at >= p_window_start
      and created_at < p_window_end
    group by 1
  )
  select
    m.day,
    b.first_reading,
    b.last_reading,
    coalesce(b.reading_count, 0::bigint),
    b.c_avg, b.c_max, b.l_avg, b.l_max,
    b.t_avg, b.t_max, b.h_avg, b.h_max,
    case b.sev
      when 2 then 'DANGER'
      when 1 then 'WARNING'
      else 'SAFE'
    end
  from manila_days m
  left join bucketed b using (day)
  order by m.day;
$$;
