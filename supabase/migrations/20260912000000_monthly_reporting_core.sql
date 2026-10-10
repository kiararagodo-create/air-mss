-- ============================================================================
-- 20260912000000_monthly_reporting_core.sql
--
-- Replaces the 7-day / weekly retention model with calendar-month reporting.
--
-- Design notes
-- ------------
-- * Everything is keyed on Asia/Manila calendar boundaries. `day` columns are
--   `date` holding a MANILA calendar date (not UTC). Timestamps stay timestamptz.
-- * `readings` and `rooms` are pre-existing tables (created outside this repo),
--   so this migration only ADDS indexes to them - it never recreates them.
-- * Aggregates (daily_summaries, graph_buckets) are the durable record. They
--   are computed from raw readings BEFORE those readings are eligible for
--   deletion, so a calendar date stays useful forever after its raw rows go.
--
-- Idempotency: safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shared constants
-- ---------------------------------------------------------------------------

create schema if not exists extensions;

-- Report timezone, in one place.
create or replace function public.report_tz()
returns text
language sql
immutable
parallel safe
as $$
  select 'Asia/Manila';
$$;

comment on function public.report_tz() is
  'Single source of truth for the reporting timezone. Used by every month/day boundary computation.';


-- ---------------------------------------------------------------------------
-- 1. threshold_history
-- ---------------------------------------------------------------------------
-- The admin-editable thresholds live in platform_thresholds (single row, id=1)
-- but that only records the CURRENT values. Reports for a past date need to
-- know what the thresholds actually were when those readings were recorded,
-- otherwise we would silently re-evaluate history against today's settings.
--
-- Every Settings-page save appends a row here (see RoomsContext.tsx).
-- Dates BEFORE the first row existed are reported as "evaluated against the
-- thresholds in effect at report generation time" - we do not guess.

create table if not exists public.threshold_history (
  id                 bigserial primary key,
  -- The Manila-time instant from which these values apply.
  effective_from     timestamptz     not null default now(),
  co2_warning        numeric(10, 2)  not null,
  co2_high           numeric(10, 2)  not null,
  co2_danger         numeric(10, 2)  not null,
  lpg_warning        numeric(10, 2)  not null,
  lpg_high           numeric(10, 2)  not null,
  lpg_danger         numeric(10, 2)  not null,
  temp_freeze_below  numeric(10, 2)  not null,
  temp_cool_below    numeric(10, 2)  not null,
  temp_heat_above    numeric(10, 2)  not null,
  humidity_dry_below numeric(10, 2)  not null,
  humidity_low_below numeric(10, 2)  not null,
  humidity_mold_above numeric(10, 2) not null,
  changed_by         text,
  change_note        text,
  created_at         timestamptz     not null default now()
);

comment on table public.threshold_history is
  'Append-only log of platform threshold changes. Reports resolve the row with the greatest effective_from <= period end.';

create index if not exists threshold_history_effective_idx
  on public.threshold_history (effective_from desc);

alter table public.threshold_history enable row level security;

-- Reports are admin-only (mirrors RoleRoute allow=["admin"] in App.tsx).
drop policy if exists threshold_history_admin_read on public.threshold_history;
create policy threshold_history_admin_read
  on public.threshold_history for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

drop policy if exists threshold_history_admin_write on public.threshold_history;
create policy threshold_history_admin_write
  on public.threshold_history for all
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );


-- ---------------------------------------------------------------------------
-- 2. daily_summaries  (durable - survives raw reading deletion)
-- ---------------------------------------------------------------------------

create table if not exists public.daily_summaries (
  device_id            text        not null,
  -- Manila calendar date. NOT a UTC timestamp.
  day                  date        not null,

  reading_count        integer     not null default 0,
  first_reading_at     timestamptz,
  last_reading_at      timestamptz,
  -- What a continuously-online device at the firmware cadence would have sent.
  expected_count       integer     not null default 0,
  -- reading_count / expected_count, capped at 100. Describes DATA COVERAGE,
  -- not safety. A low value means we cannot say what happened in the gaps.
  coverage_pct         numeric(5, 2) not null default 0,
  -- Gaps longer than this are recorded as an offline period (seconds).
  -- 0 means "no gap at or above the threshold".
  longest_gap_seconds  integer     not null default 0,
  gap_count            integer     not null default 0,

  -- Per-metric aggregates. *_count is the number of NON-NULL readings for that
  -- metric, which is why it can be lower than reading_count. NULL values are
  -- excluded from min/max/avg - they are never coerced to zero.
  co2_min              numeric(12, 3),
  co2_max              numeric(12, 3),
  co2_avg              numeric(12, 3),
  co2_count            integer     not null default 0,
  co2_warning_count    integer     not null default 0,
  co2_danger_count     integer     not null default 0,
  co2_min_at           timestamptz,
  co2_max_at           timestamptz,

  lpg_min              numeric(12, 3),
  lpg_max              numeric(12, 3),
  lpg_avg              numeric(12, 3),
  lpg_count            integer     not null default 0,
  lpg_warning_count    integer     not null default 0,
  lpg_danger_count     integer     not null default 0,
  lpg_min_at           timestamptz,
  lpg_max_at           timestamptz,

  temp_min             numeric(12, 3),
  temp_max             numeric(12, 3),
  temp_avg             numeric(12, 3),
  temp_count           integer     not null default 0,
  temp_danger_count    integer     not null default 0,
  temp_min_at          timestamptz,
  temp_max_at          timestamptz,

  humidity_min         numeric(12, 3),
  humidity_max         numeric(12, 3),
  humidity_avg         numeric(12, 3),
  humidity_count       integer     not null default 0,
  humidity_danger_count integer    not null default 0,
  humidity_min_at      timestamptz,
  humidity_max_at      timestamptz,

  -- NUMBER OF READINGS (rows) where at least one metric was in the danger
  -- band. A reading that breached two metrics counts ONCE here.
  -- This is NOT an incident count and NOT a duration. See the analysis text
  -- generated by the Edge Function for why.
  danger_readings      integer     not null default 0,
  -- Per-reading breakdown of which metrics breached, so we never have to guess.
  danger_by_metric     jsonb       not null default '{}'::jsonb,
  -- Highest `severity` value the firmware itself stamped on a row that day.
  -- This is the device's own classification, kept separate from our threshold
  -- evaluation so the two are never conflated. NULL when the firmware wrote
  -- no severity at all.
  max_recorded_severity integer,

  -- The thresholds actually used to compute the counts above.
  thresholds_used      jsonb,
  threshold_source     text,   -- 'historical' | 'current'

  source               text        not null default 'live'
                         check (source in ('live', 'archived')),
  updated_at           timestamptz not null default now(),

  primary key (device_id, day)
);

comment on table public.daily_summaries is
  'Per-device, per-Manila-day aggregates. This is what keeps a calendar date useful after raw readings are deleted.';

comment on column public.daily_summaries.danger_readings is
  'Count of reading ROWS with >=1 metric in the danger band. Not an incident count, not a duration, and gaps are never counted as danger.';

create index if not exists daily_summaries_day_idx
  on public.daily_summaries (day desc);
create index if not exists daily_summaries_device_day_idx
  on public.daily_summaries (device_id, day desc);

alter table public.daily_summaries enable row level security;

drop policy if exists daily_summaries_admin_read on public.daily_summaries;
create policy daily_summaries_admin_read
  on public.daily_summaries for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

-- Only the service role (Edge Functions via the cron job) writes this table.
drop policy if exists daily_summaries_service_write on public.daily_summaries;
create policy daily_summaries_service_write
  on public.daily_summaries for all
  to service_role
  using (true)
  with check (true);


-- ---------------------------------------------------------------------------
-- 3. graph_buckets  (durable - aggregated graph points)
-- ---------------------------------------------------------------------------
-- Time-bucketed averages. After raw readings are deleted these are what the
-- graphs are drawn from, so every graph in the UI is labelled
-- "aggregated data" rather than "raw readings".

create table if not exists public.graph_buckets (
  device_id        text        not null,
  bucket_start     timestamptz not null,
  bucket_seconds   integer     not null,
  reading_count    integer     not null default 0,

  co2_avg          numeric(12, 3),
  co2_min          numeric(12, 3),
  co2_max          numeric(12, 3),
  lpg_avg          numeric(12, 3),
  lpg_min          numeric(12, 3),
  lpg_max          numeric(12, 3),
  temp_avg         numeric(12, 3),
  temp_min         numeric(12, 3),
  temp_max         numeric(12, 3),
  humidity_avg     numeric(12, 3),
  humidity_min     numeric(12, 3),
  humidity_max     numeric(12, 3),

  danger_readings  integer     not null default 0,

  updated_at       timestamptz not null default now(),

  primary key (device_id, bucket_start, bucket_seconds)
);

comment on table public.graph_buckets is
  'Time-bucketed aggregates backing report graphs. Rows here are averages/min/max per bucket, never raw samples.';

create index if not exists graph_buckets_device_start_idx
  on public.graph_buckets (device_id, bucket_seconds, bucket_start desc);
create index if not exists graph_buckets_start_idx
  on public.graph_buckets (bucket_start desc);

alter table public.graph_buckets enable row level security;

drop policy if exists graph_buckets_admin_read on public.graph_buckets;
create policy graph_buckets_admin_read
  on public.graph_buckets for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

drop policy if exists graph_buckets_service_write on public.graph_buckets;
create policy graph_buckets_service_write
  on public.graph_buckets for all
  to service_role
  using (true)
  with check (true);


-- ---------------------------------------------------------------------------
-- 4. monthly_reports  (one row per device per calendar month)
-- ---------------------------------------------------------------------------

create table if not exists public.monthly_reports (
  id                 bigserial primary key,
  device_id          text        not null,
  -- First day of the calendar month (Manila).
  month_start        date        not null,
  -- Last day of the calendar month (Manila). Inclusive.
  month_end          date        not null,
  month_label        text        not null,

  generation_status  text        not null default 'pending'
                       check (generation_status in ('pending', 'generating', 'succeeded', 'failed')),
  -- Set only after every part has been uploaded AND re-verified via a
  -- storage.list() round trip. The retention delete requires this to be true.
  verified           boolean     not null default false,
  verified_at        timestamptz,

  part_count         integer     not null default 0,
  pdf_paths          text[]      not null default '{}'::text[],
  csv_path           text,
  csv_row_count      bigint,

  reading_count            bigint not null default 0,
  danger_reading_count     bigint not null default 0,
  -- Metric rollups, daily rows, coverage and analysis narrative.
  stats            jsonb       not null default '{}'::jsonb,
  daily_rows       jsonb       not null default '[]'::jsonb,
  analysis         jsonb       not null default '{}'::jsonb,

  thresholds_used  jsonb,
  threshold_source text,

  -- Raw readings are only removed once generation_status='succeeded'
  -- AND verified=true. Both columns are updated in the same guarded function.
  readings_deleted boolean     not null default false,
  readings_deleted_at timestamptz,
  deleted_reading_count bigint,

  device_name       text,
  device_floor      text,

  error_reason      text,
  attempts          integer     not null default 0,
  last_attempt_at   timestamptz,

  generated_at      timestamptz,
  created_at        timestamptz not null default now(),

  -- THE idempotency guarantee. Two concurrent runs for the same device-month
  -- collide here; the archive job uses ON CONFLICT DO UPDATE.
  constraint monthly_reports_device_month_uniq unique (device_id, month_start),

  constraint monthly_reports_month_order check (month_end >= month_start)
);

comment on table public.monthly_reports is
  'Monthly report index. One row per device per Manila calendar month. Part paths in pdf_paths are ordered.';

comment on column public.monthly_reports.verified is
  'True only after all parts + CSV were uploaded and re-listed from Storage. Required before raw readings may be deleted.';

create index if not exists monthly_reports_device_month_idx
  on public.monthly_reports (device_id, month_start desc);
create index if not exists monthly_reports_month_idx
  on public.monthly_reports (month_start desc);
create index if not exists monthly_reports_status_idx
  on public.monthly_reports (generation_status, month_start desc);

alter table public.monthly_reports enable row level security;

drop policy if exists monthly_reports_admin_read on public.monthly_reports;
create policy monthly_reports_admin_read
  on public.monthly_reports for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

drop policy if exists monthly_reports_service_write on public.monthly_reports;
create policy monthly_reports_service_write
  on public.monthly_reports for all
  to service_role
  using (true)
  with check (true);


-- ---------------------------------------------------------------------------
-- 5. Storage bucket for monthly artefacts (PRIVATE)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'monthly-reports',
  'monthly-reports',
  false,                 -- private: never publicly readable
  262144000,             -- 250 MB ceiling, covers a full raw CSV
  array['application/pdf', 'text/csv']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Admin-only reads. The previous 'sensor-reports' policy allowed ANY
-- authenticated user; reports are admin-only in this app, so match that.
drop policy if exists monthly_reports_objects_admin_read on storage.objects;
create policy monthly_reports_objects_admin_read
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'monthly-reports'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()::text
        and p.role = 'admin'
        and p.account_status = 'approved'
    )
  );

drop policy if exists monthly_reports_objects_service_all on storage.objects;
create policy monthly_reports_objects_service_all
  on storage.objects for all
  to service_role
  using (bucket_id = 'monthly-reports')
  with check (bucket_id = 'monthly-reports');


-- ---------------------------------------------------------------------------
-- 6. Indexes on the pre-existing readings table
-- ---------------------------------------------------------------------------
-- The archive job and the daily refresh both scan by (device_id, created_at).
-- created alone is needed for the global retention sweep.

create index if not exists readings_device_created_idx
  on public.readings (device_id, created_at);

create index if not exists readings_created_idx
  on public.readings (created_at);


-- ---------------------------------------------------------------------------
-- 7. Month-boundary helpers
-- ---------------------------------------------------------------------------

-- First day of the Manila calendar month containing p_instant.
create or replace function public.manila_month_start(p_instant timestamptz default now())
returns date
language sql
immutable
parallel safe
as $$
  select date_trunc('month', p_instant at time zone public.report_tz())::date;
$$;

-- Last day of the Manila calendar month containing p_instant.
create or replace function public.manila_month_end(p_instant timestamptz default now())
returns date
language sql
immutable
parallel safe
as $$
  select (date_trunc('month', p_instant at time zone public.report_tz()) + interval '1 month - 1 day')::date;
$$;

-- The complete calendar month immediately BEFORE the one containing p_instant.
-- Returns (month_start, month_end) as Manila dates.
create or replace function public.manila_previous_month(p_instant timestamptz default now())
returns table (month_start date, month_end date)
language sql
immutable
parallel safe
as $$
  select
    (date_trunc('month', p_instant at time zone public.report_tz()) - interval '1 month')::date,
    (date_trunc('month', p_instant at time zone public.report_tz()) - interval '1 day')::date;
$$;

-- Exclusive upper bound instant for a Manila calendar date range.
-- p_day is a Manila date; the result is a timestamptz that is
-- (p_day + 1 day) at 00:00 Manila, expressed in UTC.
create or replace function public.manila_day_end(p_day date)
returns timestamptz
language sql
immutable
parallel safe
as $$
  select (p_day::timestamp + interval '1 day') at time zone public.report_tz();
$$;

create or replace function public.manila_day_start(p_day date)
returns timestamptz
language sql
immutable
parallel safe
as $$
  select p_day::timestamp at time zone public.report_tz();
$$;

comment on function public.manila_day_start(date) is
  '00:00 Asia/Manila on p_day, returned as a timestamptz. Use with manila_day_end() for half-open ranges [start, end).';