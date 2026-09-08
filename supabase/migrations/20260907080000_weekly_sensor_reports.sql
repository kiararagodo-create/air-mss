-- 20260907080000_weekly_sensor_reports.sql
-- 7-day sensor archival pipeline (weekly PDF reports + safe raw-data cleanup).
--
-- Reuses the existing `readings` table for raw history (already receives every
-- reading from the ESP32). Adds:
--   * `sensor_reports` - permanent metadata for each successfully archived
--     7-day PDF report (one row per device_id+report_start+report_end).
--   * `sensor_reports.readings_deleted` flag - set to true only AFTER the
--     raw readings were actually deleted, so we never lose data on failure.
--   * Unique constraint on (device_id, report_start, report_end) for
--     idempotency - the cron job can run twice without producing duplicate
--     reports or accidental re-deletion.
--   * Composite index on readings(device_id, created_at) for the report
--     query's hot path (already implicitly covered for .eq().gte()/.lte(),
--     but we add it explicitly so the planner picks it on large tables).
--   * `sensor-reports` Storage bucket (private; RLS enforces admin read).
--   * Helper SQL functions used by the Edge Function:
--       - aggregate_readings_for_window(...)
--       - status_breakdown(...)
--       - detect_events(...)
--       - daily_summary(...)
--       - linear_trend(...)
--       - downsample_for_chart(...)
--       - archive_completed_reports() - marks which devices are ready.
--
-- Designed to be additive: if anything in this migration conflicts with a
-- table or function that already exists in your project, the supabase CLI
-- will surface it on `db push` and you can rename/adjust without losing
-- data. No DROP statements.

----------------------------------------------------------------------
-- 1. sensor_reports table
----------------------------------------------------------------------
create table if not exists public.sensor_reports (
  id                  bigserial primary key,
  device_id           text        not null,
  report_start        timestamptz not null,
  report_end          timestamptz not null,
  pdf_path            text        null,                   -- storage object path
  pdf_bucket          text        null,                   -- bucket name (sensor-reports)
  reading_count       integer     not null default 0,
  generation_status   text        not null default 'pending'
                      check (generation_status in ('pending','generating','succeeded','failed')),
  readings_deleted    boolean     not null default false,
  -- summary stats for quick list-view rendering (PDF still holds the detail)
  co2_min             double precision null,
  co2_max             double precision null,
  co2_avg             double precision null,
  co2_danger_events   integer     null,
  lpg_min             double precision null,
  lpg_max             double precision null,
  lpg_avg             double precision null,
  lpg_danger_events   integer     null,
  temp_min            double precision null,
  temp_max            double precision null,
  temp_avg            double precision null,
  humidity_min        double precision null,
  humidity_max        double precision null,
  humidity_avg        double precision null,
  dominant_status     text        null,                   -- 'SAFE' | 'WARNING' | 'DANGER'
  data_coverage_pct   double precision null,             -- 0-100, % of period with data
  error_reason        text        null,
  generated_at        timestamptz null,
  created_at          timestamptz not null default now(),

  -- Idempotency: ONE row per (device_id, report_start, report_end).
  -- The cron job can safely re-run; the second run hits a unique-violation
  -- and skips that device. If the first run failed, the conflict only
  -- blocks duplicate work, not retries - the orchestrator updates the row
  -- instead of inserting when generation_status='failed'.
  constraint sensor_reports_period_uniq
    unique (device_id, report_start, report_end)
);

create index if not exists sensor_reports_device_idx
    on public.sensor_reports (device_id, report_end desc);

create index if not exists sensor_reports_status_idx
    on public.sensor_reports (generation_status, report_end);

-- Composite index for the hot-path query used during archival:
--   WHERE device_id = $1 AND created_at >= $2 AND created_at < $3
-- Speeds up both the analytics pass and the safe DELETE later.
create index if not exists readings_device_time_idx
    on public.readings (device_id, created_at desc);

----------------------------------------------------------------------
-- 2. RLS for sensor_reports
----------------------------------------------------------------------
alter table public.sensor_reports enable row level security;

-- Authenticated users can read report metadata so the dashboard can list
-- archived reports. The PDFs themselves are gated by Storage RLS below.
drop policy if exists "authenticated can read sensor_reports" on public.sensor_reports;
create policy "authenticated can read sensor_reports"
  on public.sensor_reports
  for select
  to authenticated
  using (true);

-- Only the service_role key (used inside the Edge Function) writes here.
-- We deliberately do NOT grant insert/update to anon or authenticated so
-- clients can never forge or mutate report rows.
drop policy if exists "service role writes sensor_reports" on public.sensor_reports;
create policy "service role writes sensor_reports"
  on public.sensor_reports
  for all
  to service_role
  using (true)
  with check (true);

----------------------------------------------------------------------
-- 3. Storage bucket for PDFs (private)
----------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('sensor-reports', 'sensor-reports', false)
on conflict (id) do nothing;

-- Path convention: {device_id}/{report_start}_to_{report_end}.pdf
-- Only admins (authenticated + role=admin) can read these objects.
drop policy if exists "authenticated can read sensor-reports bucket" on storage.objects;
create policy "authenticated can read sensor-reports bucket"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'sensor-reports');

-- Uploads/deletions are service-role-only.
drop policy if exists "service role writes sensor-reports bucket" on storage.objects;
create policy "service role writes sensor-reports bucket"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'sensor-reports')
  with check (bucket_id = 'sensor-reports');

----------------------------------------------------------------------
-- 4. Helper SQL functions
--
-- Each function is SECURITY DEFINER so the Edge Function (service_role)
-- can call them without granting per-function execute rights to anon.
-- They are intentionally small so the Edge Function can compose them
-- independently - keeps the Edge Function code modular.
----------------------------------------------------------------------

-- 4a. Aggregate raw readings into a single JSON row of stats per metric.
-- Returns null for metrics whose column is entirely null (e.g. a device
-- with no temp sensor).
create or replace function public.sensor_readings_stats(
  p_device_id   text,
  p_window_start timestamptz,
  p_window_end   timestamptz
)
returns table (
  metric           text,
  reading_count     bigint,
  min_val           double precision,
  max_val           double precision,
  avg_val           double precision,
  median_val        double precision,
  stddev_val        double precision,
  safe_count        bigint,
  warning_count     bigint,
  danger_count      bigint,
  warning_threshold double precision,
  danger_threshold  double precision
)
language sql
stable
as $$
  -- Each branch is intentionally narrow: the threshold logic mirrors the
  -- existing `severity` calculation in src/data/Data.ts (severityFor()).
  -- CO2 tiers: warning 1000, danger 3500 (firmware CO2_URGENT_PPM).
  -- LPG tiers:  warning 1000, danger 5000.
  -- Temp tiers: danger < 5 OR > 35 (matches ESP32 firmware constants
  --             TEMP_ALARM_LOW_C / TEMP_ALARM_HIGH_C).
  -- Humidity tiers: danger < 20 OR > 80 (matches HUM_ALARM_LOW/HIGH).
  with windowed as (
    select * from public.readings
    where device_id = p_device_id
      and created_at >= p_window_start
      and created_at <  p_window_end
  )
  select * from (
    select
      'co2'::text as metric,
      count(co2) as reading_count,
      min(co2)::double precision as min_val,
      max(co2)::double precision as max_val,
      avg(co2)::double precision as avg_val,
      percentile_cont(0.5) within group (order by co2)::double precision as median_val,
      stddev_samp(co2)::double precision as stddev_val,
      count(*) filter (where co2 is not null and co2 < 1000) as safe_count,
      count(*) filter (where co2 is not null and co2 >= 1000 and co2 < 3500) as warning_count,
      count(*) filter (where co2 is not null and co2 >= 3500) as danger_count,
      1000::double precision as warning_threshold,
      3500::double precision as danger_threshold
    from windowed
    union all
    select
      'lpg'::text,
      count(lpg),
      min(lpg)::double precision, max(lpg)::double precision, avg(lpg)::double precision,
      percentile_cont(0.5) within group (order by lpg)::double precision,
      stddev_samp(lpg)::double precision,
      count(*) filter (where lpg is not null and lpg < 1000),
      count(*) filter (where lpg is not null and lpg >= 1000 and lpg < 5000),
      count(*) filter (where lpg is not null and lpg >= 5000),
      1000::double precision, 5000::double precision
    from windowed
    union all
    select
      'temp'::text,
      count(temp),
      min(temp)::double precision, max(temp)::double precision, avg(temp)::double precision,
      percentile_cont(0.5) within group (order by temp)::double precision,
      stddev_samp(temp)::double precision,
      count(*) filter (where temp is not null and temp >= 5 and temp <= 35),
      count(*) filter (where temp is not null and ((temp >= 18 and temp < 5) or (temp > 35 and temp <= 38))),
      count(*) filter (where temp is not null and (temp < 5 or temp > 35)),
      35::double precision, 38::double precision
    from windowed
    union all
    select
      'humidity'::text,
      count(humidity),
      min(humidity)::double precision, max(humidity)::double precision, avg(humidity)::double precision,
      percentile_cont(0.5) within group (order by humidity)::double precision,
      stddev_samp(humidity)::double precision,
      count(*) filter (where humidity is not null and humidity >= 20 and humidity <= 80),
      count(*) filter (where humidity is not null and ((humidity >= 30 and humidity < 20) or (humidity > 80 and humidity <= 90))),
      count(*) filter (where humidity is not null and (humidity < 20 or humidity > 80)),
      80::double precision, 90::double precision
    from windowed
  ) s
  where reading_count > 0;
$$;

-- 4b. Downsample raw readings into per-bucket averages for chart rendering.
-- Buckets are fixed-width time windows (caller picks the size). Only the
-- average is computed - min/max/statistics come from sensor_readings_stats.
-- This keeps graph rendering fast even for high-frequency devices while
-- preserving analytical precision on the original rows.
create or replace function public.sensor_readings_downsample(
  p_device_id   text,
  p_window_start timestamptz,
  p_window_end   timestamptz,
  p_bucket_seconds integer
)
returns table (
  bucket_start     timestamptz,
  co2_avg          double precision,
  lpg_avg          double precision,
  temp_avg         double precision,
  humidity_avg     double precision
)
language sql
stable
as $$
  with series as (
    select
      to_timestamp(
        floor(extract(epoch from created_at) / p_bucket_seconds) * p_bucket_seconds
      ) at time zone 'UTC' as bucket_start,
      co2, lpg, temp, humidity
    from public.readings
    where device_id = p_device_id
      and created_at >= p_window_start
      and created_at <  p_window_end
  )
  select
    bucket_start,
    avg(co2)::double precision,
    avg(lpg)::double precision,
    avg(temp)::double precision,
    avg(humidity)::double precision
  from series
  group by bucket_start
  order by bucket_start;
$$;

-- 4c. Detect "events": contiguous runs of warning/danger readings.
-- A row per event with start/end, metric, status, and approximate
-- duration in seconds. Uses the standard SQL gap-and-islands trick
-- (each row's rank minus row_number() resets at each status change).
create or replace function public.sensor_readings_events(
  p_device_id   text,
  p_window_start timestamptz,
  p_window_end   timestamptz,
  p_metric       text,                 -- 'co2' | 'lpg' | 'temp' | 'humidity'
  p_warning_threshold double precision,
  p_danger_threshold  double precision
)
returns table (
  status          text,                -- 'WARNING' | 'DANGER'
  started_at      timestamptz,
  ended_at        timestamptz,
  duration_seconds integer,
  reading_count   integer
)
language sql
stable
as $$
  with classified as (
    select
      created_at,
      case
        when p_metric = 'co2' then co2
        when p_metric = 'lpg' then lpg
        when p_metric = 'temp' then temp
        when p_metric = 'humidity' then humidity
      end as v
    from public.readings
    where device_id = p_device_id
      and created_at >= p_window_start
      and created_at <  p_window_end
  ),
  with_status as (
    select
      created_at,
      case
        when v is null then null
        when v >= p_danger_threshold  then 'DANGER'
        when v >= p_warning_threshold then 'WARNING'
        else 'SAFE'
      end as status
    from classified
    where v is not null
  ),
  islands as (
    -- Each (status, group_id) island is one continuous run.
    select
      status,
      created_at,
      (row_number() over (order by created_at) -
       row_number() over (partition by status order by created_at)) as grp
    from with_status
    where status in ('WARNING','DANGER')
  )
  select
    status,
    min(created_at) as started_at,
    max(created_at) as ended_at,
    (extract(epoch from max(created_at) - min(created_at)))::integer as duration_seconds,
    count(*)::integer as reading_count
  from islands
  group by status, grp
  order by min(created_at);
$$;

-- 4d. Per-day rollup so the PDF's "Daily Summary" table can be filled
-- in one query. Bucketed by local calendar day (Asia/Manila) so the
-- report aligns with the user's wall clock rather than UTC.
create or replace function public.sensor_readings_daily_summary(
  p_device_id   text,
  p_window_start timestamptz,
  p_window_end   timestamptz
)
returns table (
  day             date,
  co2_avg         double precision,
  co2_max         double precision,
  lpg_avg         double precision,
  lpg_max         double precision,
  temp_avg        double precision,
  temp_max        double precision,
  humidity_avg    double precision,
  humidity_max    double precision,
  dominant_status text
)
language sql
stable
as $$
  with bucketed as (
    select
      (created_at at time zone 'Asia/Manila')::date as day,
      co2, lpg, temp, humidity,
      greatest(
        case when co2    is not null and co2    >= 3500 then 2
             when co2    is not null and co2    >= 1000 then 1 else 0 end,
        case when lpg    is not null and lpg    >= 5000 then 2
             when lpg    is not null and lpg    >= 1000 then 1 else 0 end,
        case when temp   is not null and (temp < 5 or temp > 35) then 2
             when temp   is not null and (temp < 18 or temp > 33) then 1 else 0 end,
        case when humidity is not null and (humidity < 20 or humidity > 80) then 2
             when humidity is not null and (humidity < 30 or humidity > 70) then 1 else 0 end
      ) as worst_severity
    from public.readings
    where device_id = p_device_id
      and created_at >= p_window_start
      and created_at <  p_window_end
  )
  select
    day,
    avg(co2)::double precision,    max(co2)::double precision,
    avg(lpg)::double precision,    max(lpg)::double precision,
    avg(temp)::double precision,   max(temp)::double precision,
    avg(humidity)::double precision, max(humidity)::double precision,
    case max(worst_severity)
      when 2 then 'DANGER'
      when 1 then 'WARNING'
      else 'SAFE'
    end
  from bucketed
  group by day
  order by day;
$$;

-- 4e. Linear regression slope on a metric over the window. Returns the
-- slope per second (so we can compare metrics on different scales by
-- normalizing). Used for trend classification.
create or replace function public.sensor_trend_slope(
  p_device_id   text,
  p_window_start timestamptz,
  p_window_end   timestamptz,
  p_metric       text
)
returns double precision
language sql
stable
as $$
  with pts as (
    select
      extract(epoch from created_at - p_window_start) as x,
      case
        when p_metric = 'co2'      then co2
        when p_metric = 'lpg'      then lpg
        when p_metric = 'temp'     then temp
        when p_metric = 'humidity' then humidity
      end as y
    from public.readings
    where device_id = p_device_id
      and created_at >= p_window_start
      and created_at <  p_window_end
  ),
  stats as (
    -- Postgres forbids nesting aggregates (e.g. sum((x - avg(x)) ...)).
    -- Compute xbar/ybar in one pass, then the centered sums in a second.
    select
      count(*)::double precision as n,
      avg(x) as xbar,
      avg(y) as ybar
    from pts
    where y is not null
  ),
  centered as (
    select
      (p.x  - s.xbar) as dx,
      (p.y  - s.ybar) as dy,
      s.n as n
    from pts p cross join stats s
    where p.y is not null
  ),
  moments as (
    select
      sum(dx * dy)  as sxy,
      sum(dx * dx)  as sxx,
      max(n)        as n
    from centered
  )
  select case when n > 1 and sxx > 0 then sxy / sxx else 0 end from moments;
$$;

----------------------------------------------------------------------
-- 5. Orchestration entry point used by the Edge Function
--
-- archive_completed_reports() returns one row per device that has a
-- *completed* 7-day reporting period (i.e. report_end <= now() - grace).
-- The Edge Function iterates over this set; the unique constraint on
-- (device_id, report_start, report_end) prevents duplicate work if the
-- cron fires twice or if a previous run was interrupted mid-flight.
--
-- grace_minutes lets us delay archival slightly so a device that sends
-- a few late stragglers right at midnight doesn't get split across two
-- reports.
----------------------------------------------------------------------
create or replace function public.archive_completed_reports(
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
  with rooms as (
    select id from public.rooms
  ),
  candidates as (
    select
      r.id as device_id,
      -- Snap to ISO-week boundaries anchored at Manila midnight.
      -- Report boundaries are Mon 00:00 Manila -> next Mon 00:00 Manila.
      date_trunc('week', now() at time zone 'Asia/Manila')
        at time zone 'Asia/Manila' as this_week_start,
      date_trunc('week', (now() - interval '7 days') at time zone 'Asia/Manila')
        at time zone 'Asia/Manila' as last_week_start
    from rooms r
  ),
  already_done as (
    select device_id, report_start, report_end
    from public.sensor_reports
    where readings_deleted = true
  )
  select
    c.device_id,
    c.last_week_start as report_start,
    c.this_week_start as report_end,
    (select count(*) from public.readings rx
       where rx.device_id = c.device_id
         and rx.created_at >= c.last_week_start
         and rx.created_at <  c.this_week_start
    ) as reading_count
  from candidates c
  where now() >= c.this_week_start + make_interval(mins => grace_minutes)
    and not exists (
      select 1 from already_done a
      where a.device_id = c.device_id
        and a.report_start = c.last_week_start
        and a.report_end   = c.this_week_start
    );
$$;

-- Used by the Edge Function to safely delete raw readings for one
-- archived report. The WHERE clause pins to the exact (device_id,
-- report_start, report_end) tuple and requires the report row to be
-- in 'succeeded' status AND readings_deleted = false - so this can
-- never run prematurely or twice.
create or replace function public.delete_archived_readings(
  p_device_id   text,
  p_report_start timestamptz,
  p_report_end   timestamptz
)
returns integer
language plpgsql
as $$
declare
  v_deleted integer;
begin
  -- Fail-closed guard: refuse if the report isn't in a safe state.
  if not exists (
    select 1 from public.sensor_reports
    where device_id    = p_device_id
      and report_start = p_report_start
      and report_end   = p_report_end
      and generation_status = 'succeeded'
      and pdf_path is not null
      and readings_deleted = false
  ) then
    raise exception 'Refusing to delete: sensor_reports row not in succeeded state';
  end if;

  with deleted as (
    delete from public.readings
    where device_id  = p_device_id
      and created_at >= p_report_start
      and created_at <  p_report_end
    returning 1
  )
  select count(*) into v_deleted from deleted;

  update public.sensor_reports
     set readings_deleted = true
   where device_id    = p_device_id
     and report_start = p_report_start
     and report_end   = p_report_end;

  return v_deleted;
end;
$$;

-- Safety net: if the storage upload is verified, mark the report succeeded.
-- Called by the Edge Function right after the Storage HEAD returns 200.
create or replace function public.mark_report_succeeded(
  p_device_id   text,
  p_report_start timestamptz,
  p_report_end   timestamptz,
  p_pdf_path     text,
  p_reading_count integer,
  p_co2_min double precision, p_co2_max double precision, p_co2_avg double precision, p_co2_danger_events integer,
  p_lpg_min double precision, p_lpg_max double precision, p_lpg_avg double precision, p_lpg_danger_events integer,
  p_temp_min double precision, p_temp_max double precision, p_temp_avg double precision,
  p_humidity_min double precision, p_humidity_max double precision, p_humidity_avg double precision,
  p_dominant_status text,
  p_data_coverage_pct double precision
)
returns void
language sql
as $$
  insert into public.sensor_reports (
    device_id, report_start, report_end, pdf_path, pdf_bucket,
    reading_count, generation_status, readings_deleted,
    co2_min, co2_max, co2_avg, co2_danger_events,
    lpg_min, lpg_max, lpg_avg, lpg_danger_events,
    temp_min, temp_max, temp_avg,
    humidity_min, humidity_max, humidity_avg,
    dominant_status, data_coverage_pct,
    generated_at
  )
  values (
    p_device_id, p_report_start, p_report_end, p_pdf_path, 'sensor-reports',
    p_reading_count, 'succeeded', false,
    p_co2_min, p_co2_max, p_co2_avg, p_co2_danger_events,
    p_lpg_min, p_lpg_max, p_lpg_avg, p_lpg_danger_events,
    p_temp_min, p_temp_max, p_temp_avg,
    p_humidity_min, p_humidity_max, p_humidity_avg,
    p_dominant_status, p_data_coverage_pct,
    now()
  )
  on conflict (device_id, report_start, report_end) do update set
    pdf_path = excluded.pdf_path,
    reading_count = excluded.reading_count,
    generation_status = 'succeeded',
    co2_min = excluded.co2_min, co2_max = excluded.co2_max, co2_avg = excluded.co2_avg,
    co2_danger_events = excluded.co2_danger_events,
    lpg_min = excluded.lpg_min, lpg_max = excluded.lpg_max, lpg_avg = excluded.lpg_avg,
    lpg_danger_events = excluded.lpg_danger_events,
    temp_min = excluded.temp_min, temp_max = excluded.temp_max, temp_avg = excluded.temp_avg,
    humidity_min = excluded.humidity_min, humidity_max = excluded.humidity_max, humidity_avg = excluded.humidity_avg,
    dominant_status = excluded.dominant_status,
    data_coverage_pct = excluded.data_coverage_pct,
    generated_at = now(),
    error_reason = null;
$$;

-- Used by the Edge Function on failure so a future cron tick can retry.
-- generation_status='failed' rows are visible to the orchestrator and do
-- NOT block the unique constraint (so a retry inserts via the upsert in
-- mark_report_succeeded once it finally succeeds).
create or replace function public.mark_report_failed(
  p_device_id   text,
  p_report_start timestamptz,
  p_report_end   timestamptz,
  p_error_reason text
)
returns void
language sql
as $$
  insert into public.sensor_reports (
    device_id, report_start, report_end, generation_status, error_reason
  )
  values (
    p_device_id, p_report_start, p_report_end, 'failed', p_error_reason
  )
  on conflict (device_id, report_start, report_end) do update set
    generation_status = 'failed',
    error_reason = excluded.error_reason,
    generated_at = null;
$$;

----------------------------------------------------------------------
-- 6. Schedule (cron or self-tick)
--
-- Two ways to fire the weekly archive:
--
-- (a) pg_cron (paid Supabase plans only). Enable the extension first:
--       Database > Extensions > pg_cron
--     Then uncomment the block at the bottom of this file. The schedule
--     is Monday 00:10 Manila = Sunday 16:10 UTC.
--
-- (b) Self-tick via the Edge Function. The Edge Function accepts an
--     optional `tick=1` query param: if a successful full archive
--     already ran in the past 6 days, the tick is a no-op; otherwise
--     the function runs the archive and replies. We then wire a thin
--     client-side heartbeat from the admin dashboard that pings this
--     endpoint roughly once per day. No pg_cron required - works on
--     the free tier.
--
-- For (b) you also need the archive_runs table (below) so the
-- self-tick can answer "when did we last archive?".
----------------------------------------------------------------------

create table if not exists public.archive_runs (
  id              bigserial primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz null,
  devices_total   integer     null,
  devices_ok      integer     null,
  devices_failed  integer     null,
  triggered_by    text        null,        -- 'cron' | 'self-tick' | 'manual'
  error_summary   text        null
);

create index if not exists archive_runs_started_idx
  on public.archive_runs (started_at desc);

alter table public.archive_runs enable row level security;
drop policy if exists "authenticated can read archive_runs" on public.archive_runs;
create policy "authenticated can read archive_runs"
  on public.archive_runs for select to authenticated using (true);
drop policy if exists "service role writes archive_runs" on public.archive_runs;
create policy "service role writes archive_runs"
  on public.archive_runs for all to service_role using (true) with check (true);

-- Returns true if it's time to run another archive (no successful run in
-- the last 6 days). Used by the self-tick path to avoid running twice
-- within the same reporting period.
create or replace function public.should_run_archive()
returns boolean
language sql
stable
as $$
  select not exists (
    select 1 from public.archive_runs
    where finished_at is not null
      and finished_at > now() - interval '6 days'
  );
$$;

----------------------------------------------------------------------
-- 7. OPTIONAL pg_cron block (paid plan only - DO NOT enable on free)
----------------------------------------------------------------------
-- begin_optional_pg_cron
-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'weekly-sensor-report-archive',
--   '10 16 * * 1',                              -- Mon 00:10 Manila
--   $$
--   select net.http_post(
--     url    := current_setting('app.reporting_edge_function_url', true),
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || current_setting('app.reporting_cron_secret', true)
--     ),
--     body   := '{}'::jsonb
--   );
--   $$
-- );
-- end_optional_pg_cron