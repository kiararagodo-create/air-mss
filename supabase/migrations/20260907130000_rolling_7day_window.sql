-- Migration: replace archive_completed_reports with rolling 7-day window logic
--
-- - Archives the LAST 7 DAYS of data for each device that has readings.
-- - Tracks per-device progress so new devices get their first report immediately
--   and subsequent reports are non-overlapping.
-- - Auto-detects new devices from the rooms table - no manual setup needed.
-- - grace_minutes ensures the window is closed before archiving (handles stragglers).

drop function if exists public.archive_completed_reports(integer);
drop function if exists public.archive_completed_reports();

create function public.archive_completed_reports(
  grace_minutes integer default 60
)
returns table (
  device_id     text,
  report_start  timestamptz,
  report_end    timestamptz,
  reading_count bigint
)
language sql
stable
as $$
  with
  all_devices as (
    select id as device_id from public.rooms
  ),
  last_archived as (
    select
      device_id,
      max(report_end) as last_report_end
    from public.sensor_reports
    where generation_status = 'succeeded'
      and readings_deleted  = true
    group by device_id
  ),
  target_windows as (
    select
      d.device_id,
      coalesce(
        la.last_report_end,
        now() at time zone 'Asia/Manila' - interval '7 days'
      ) at time zone 'Asia/Manila' as window_start,
      coalesce(
        la.last_report_end,
        now() at time zone 'Asia/Manila'
      ) at time zone 'Asia/Manila' as window_end
    from all_devices d
    left join last_archived la on la.device_id = d.device_id
  ),
  window_readings as (
    select
      tw.device_id,
      tw.window_start,
      tw.window_end,
      count(r.id) as reading_count
    from target_windows tw
    left join public.readings r
      on  r.device_id = tw.device_id
      and r.created_at >= tw.window_start
      and r.created_at <  tw.window_end
    group by tw.device_id, tw.window_start, tw.window_end
  )
  select
    wr.device_id,
    wr.window_start                                             as report_start,
    wr.window_end                                               as report_end,
    wr.reading_count
  from window_readings wr
  where
    now() >= wr.window_end + make_interval(mins => grace_minutes)
    and wr.reading_count >= 1
    and not exists (
      select 1 from public.sensor_reports sr
      where sr.device_id       = wr.device_id
        and sr.report_start    = wr.window_start
        and sr.report_end      = wr.window_end
        and sr.readings_deleted = true
    );
$$;
