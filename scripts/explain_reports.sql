-- ---------------------------------------------------------------------------
-- scripts/explain_reports.sql
--
-- Reproducible EXPLAIN (ANALYZE, BUFFERS) harness for every query the Reports
-- page runs. Run it, read the plans, then run it again after the RLS /
-- daily_summaries migrations to compare.
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> paste this file -> Run.
--   (or)  psql "$DATABASE_URL" -f scripts/explain_reports.sql
--
--   Everything is wrapped in one transaction that ROLLS BACK at the end, so it
--   writes nothing. Plans come back as rows in the result set (column: line).
--   The helper function is created inside that transaction and rolled back
--   with it.
--
-- WHY A HELPER IS NEEDED
--   `EXPLAIN SELECT * FROM report_calendar_month(...)` only prints
--   "Function Scan on report_calendar_month" and hides the plan that actually
--   costs time. public.air_explain_body() pulls the function body out with
--   pg_get_functiondef(), substitutes your parameters, and EXPLAINs the body
--   itself - so you see the real Seq Scan / Sort / Filter.
--
-- HOW IT IS RUN AS A REAL USER
--   Section 0 runs as the superuser (inventory only).
--   Sections 1-3 run as `authenticated` with a real approved profile's JWT
--   claims, so row level security is applied exactly as in production. That is
--   the only way to see `Filter: is_approved_account()` in a plan.
--   Section 4 runs as the superuser, standing in for the service_role that
--   the Edge Functions use (service_role has BYPASSRLS, so no RLS quals).
--
-- WHAT TO LOOK FOR (and what each query is expected to be doing)
--   * report_calendar_month - the calendar AND the monthly list (the monthly
--     grid calls it once per elapsed month, in parallel). Expected slow step:
--     Seq Scan on public.readings for the month + per-row
--     `Filter: (is_approved_account())` + per-row report_is_danger().
--     After the daily_summaries rewrite this should become an index scan on
--     daily_summaries_day_idx over <=31 rows.
--   * report_month_stats - month totals + the per-day list for the PDF.
--     Expected slow step: one Seq Scan on readings for the month, with
--     report_is_danger() evaluated twice per row (once in `stats`, once in
--     `daily`).
--   * report_month_danger_rows / _events - window functions over the whole
--     month. Expected slow step: the Sort feeding row_number() over (), not
--     the scan itself.
--   * fetchDayReadings / fetchMonthReadings - the raw PostgREST reads behind
--     the per-day table and the monthly PDF. Expected slow step: the RLS qual
--     evaluated once per row *per page*, plus OFFSET paging that re-scans and
--     discards everything before the page.
--   * Is the RLS qual per row or per query?  Per row:
--       Filter: (is_approved_account())
--         -> InitPlan 1 (returns $0)
--     Per query (what the initplan migration produces):
--       InitPlan 1 (returns $0)
--         ->  Function Scan on is_approved_account
--     Also compare "rows removed by filter" - it should collapse to 0.
--   * Index direction: device_latest_reading needs
--     `ORDER BY device_id, created_at DESC`. If the plan shows
--     "Sort Method: quicksort" or "Incremental Sort" over readings instead of
--     a plain Index Scan using readings_device_created_desc_idx, the desc
--     index is missing or not being used.
--   * rows= vs actual rows: a 100x estimate error means ANALYZE is stale on
--     public.readings (autovacuum not keeping up) - re-run ANALYZE manually
--     before believing any of these numbers.
--
-- NOT INCLUDED: report_day_detail / report_day_danger_rows are exported by
-- src/lib/reportQueries.ts but no page calls them (DailyReportPanel reads raw
-- rows through fetchDayReadings instead). They are included anyway under
-- "not called by the UI" so you can compare.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- Section 0 - inventory (superuser). Row counts, sizes and index usage tell
-- you whether a plan is expensive because of the data or because of the plan.
-- ---------------------------------------------------------------------------
select 'readings rows' as metric, count(*)::text as value
from public.readings
union all
select 'est. live rows', (select n_live_tup::text from pg_stat_user_tables where relname = 'readings')
union all
select 'total size', pg_size_pretty(pg_total_relation_size('public.readings'))
union all
select 'heap size', pg_size_pretty(pg_relation_size('public.readings'))
union all
select 'oldest reading', coalesce(min(created_at)::text, 'empty')
from public.readings
union all
select 'newest reading', coalesce(max(created_at)::text, 'empty')
from public.readings;

select indexname, indexdef
from pg_indexes
where tablename = 'readings'
order by indexname;

select indexrelname as index,
       idx_scan as scans,
       idx_tup_read as tuples_read,
       pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where relname = 'readings'
order by idx_scan desc;

-- Helper: extract a `language sql` function body and EXPLAIN it with the
-- given parameters substituted. Values in p_params MUST be complete SQL
-- literals (quote_literal(...) or a bare number or the word null).
create or replace function public.air_explain_body(
  p_proc   text,
  p_params jsonb default '{}'::jsonb
)
returns table (line text)
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_oid  regprocedure;
  v_def  text;
  v_body text;
  v_key  text;
  v_val  text;
begin
  v_oid := to_regprocedure(p_proc);
  if v_oid is null then
    line := 'SKIPPED  ' || p_proc || '  (not installed in this database)';
    return next;
    return;
  end if;

  v_def := pg_get_functiondef(v_oid);

  if v_def ~* 'LANGUAGE\s+plpgsql' then
    line := 'PLPGSQL  ' || p_proc ||
            '  - procedural body, cannot be inlined; EXPLAIN the call instead.';
    return next;
    return;
  end if;

  -- Everything after the opening dollar-quote, whatever tag it uses.
  v_body := substring(v_def from '(?is)\bAS\s*\$[A-Za-z_0-9]*\$(.*)$');
  if v_body is null then
    line := 'SKIPPED  ' || p_proc || '  (body is not dollar-quoted)';
    return next;
    return;
  end if;

  -- Drop the closing delimiter (with or without a trailing semicolon).
  v_body := regexp_replace(v_body, '\s*\$[A-Za-z_0-9]*\$;?\s*$', '');

  if v_body is null or position('$$' in v_body) > 0 then
    line := 'SKIPPED  ' || p_proc || '  (could not isolate the function body)';
    return next;
    return;
  end if;

  -- Substitute parameters, longest name first so p_month_start is not
  -- clobbered by p_month.
  for v_key in
    select k from (select jsonb_object_keys(p_params) as k) keys
    order by length(k) desc
  loop
    v_val := p_params ->> v_key;
    if v_val is null then
      continue;
    end if;
    v_body := replace(v_body, v_key, v_val);
  end loop;

  v_body := regexp_replace(v_body, ';\s*$', '');

  if v_body is null or btrim(v_body) = '' then
    line := 'NODATA   ' || p_proc || '  (a parameter resolved to NULL - no readings?)';
    return next;
    return;
  end if;

  line := '=== ' || p_proc || ' ===';
  return next;

  return query execute 'explain (analyze, buffers) ' || v_body;
end;
$fn$;

grant execute on function public.air_explain_body(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Section 1 - Edge Function / cron side, run as the owner (service_role has
-- BYPASSRLS, so this matches how they run in production).
-- ---------------------------------------------------------------------------
select * from public.air_explain_body(
  'public.calendar_day_index(date,date,text)',
  (select jsonb_build_object(
            'p_from',      quote_literal(to_char(d - 30, 'YYYY-MM-DD')),
            'p_to',        quote_literal(to_char(d, 'YYYY-MM-DD')),
            'p_device_id', 'null')
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

select * from public.air_explain_body(
  'public.daily_report_bundle(text,date)',
  (select jsonb_build_object(
            'p_device_id', 'null',
            'p_day',       quote_literal(to_char(d, 'YYYY-MM-DD')))
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

select * from public.air_explain_body(
  'public.monthly_stats(text,date)',
  (select jsonb_build_object(
            'p_device_id',   'null',
            'p_month_start', quote_literal(to_char(date_trunc('month', d)::date, 'YYYY-MM-DD')))
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

-- Only present if the annual reporting migration has been applied.
select * from public.air_explain_body('public.month_activity_index(integer)',
  jsonb_build_object('p_year',
    (select extract(year from d)::int::text
     from (select max((created_at at time zone 'Asia/Manila')::date) as d
           from public.readings) s)));

select * from public.air_explain_body('public.annual_report_bundle(integer)',
  jsonb_build_object('p_year',
    (select extract(year from d)::int::text
     from (select max((created_at at time zone 'Asia/Manila')::date) as d
           from public.readings) s)));

-- ---------------------------------------------------------------------------
-- Section 2 - switch to a real approved user so RLS applies.
-- ---------------------------------------------------------------------------
do $setup$
declare
  v_uid text;
begin
  select id::text into v_uid
  from public.profiles
  where account_status = 'approved' and is_active
  order by (role = 'admin') desc, created_at
  limit 1;

  if v_uid is null then
    raise exception 'no approved + active profile found; this harness needs a real user';
  end if;

  raise notice 'running EXPLAIN as profile %', v_uid;

  execute format('set local request.jwt.claims to %L',
                 json_build_object('sub', v_uid, 'role', 'authenticated')::text);
  execute 'set local role authenticated';
end;
$setup$;

-- ---------------------------------------------------------------------------
-- Section 3a - RLS probe. This is the before/after comparison that matters:
-- the SAME query with and without the initplan policy rewrite.
-- ---------------------------------------------------------------------------
explain (analyze, buffers)
with ctx as (
  select max((created_at at time zone 'Asia/Manila')::date) as d
  from public.readings
)
select count(*)
from public.readings r
cross join ctx
where r.created_at >= (ctx.d::timestamp at time zone 'Asia/Manila')
  and r.created_at <  ((ctx.d + 1)::timestamp at time zone 'Asia/Manila');

-- ---------------------------------------------------------------------------
-- Section 3b - the Queries the Reports page actually issues.
-- ---------------------------------------------------------------------------

-- (1) Calendar dots - and the monthly list, which calls this once per elapsed
-- month of the selected year, in parallel.
select * from public.air_explain_body(
  'public.report_calendar_month(date,text,jsonb)',
  (select jsonb_build_object(
            'p_month_start', quote_literal(to_char(date_trunc('month', d)::date, 'YYYY-MM-DD')),
            'p_device_id',    'null',
            'p_thresholds',   quote_literal('{}'))
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

-- (2) Month totals + per-day list (MonthlyReportGrid download, month select).
select * from public.air_explain_body(
  'public.report_month_stats(integer,integer,text,jsonb)',
  (select jsonb_build_object(
            'p_year',       (extract(year from d)::int)::text,
            'p_month',      (extract(month from d)::int)::text,
            'p_device_id',  'null',
            'p_thresholds', quote_literal('{}'))
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

-- The plpgsql approval wrapper the UI prefers (falls back to the above on
-- PGRST202). Its body cannot be inlined, so EXPLAIN the call.
explain (analyze, buffers)
select public.report_month_stats_approved(
  (select extract(year from d)::int from (select max((created_at at time zone 'Asia/Manila')::date) as d from public.readings) s),
  (select extract(month from d)::int from (select max((created_at at time zone 'Asia/Manila')::date) as d from public.readings) s),
  null, '{}'::jsonb);

-- (3) Danger table for one month (ReportsPage paging).
select * from public.air_explain_body(
  'public.report_month_danger_rows(integer,integer,text,jsonb,integer,integer)',
  (select jsonb_build_object(
            'p_year',       (extract(year from d)::int)::text,
            'p_month',      (extract(month from d)::int)::text,
            'p_device_id',  'null',
            'p_thresholds', quote_literal('{}'),
            'p_limit',      '250',
            'p_offset',     '0')
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

-- (4) Grouped danger events for one month (monthly PDF).
select * from public.air_explain_body(
  'public.report_month_danger_events(integer,integer,text,jsonb)',
  (select jsonb_build_object(
            'p_year',       (extract(year from d)::int)::text,
            'p_month',      (extract(month from d)::int)::text,
            'p_device_id',  'null',
            'p_thresholds', quote_literal('{}'))
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

-- (5) Per-day table: the first page of fetchDayReadings(). Supabase runs
--     `order by created_at asc` + `range(0, 999)`; the loop repeats with a
--     growing OFFSET until a page returns < 1000 rows.
explain (analyze, buffers)
with ctx as (
  select max((created_at at time zone 'Asia/Manila')::date) as d
  from public.readings
)
select r.created_at, r.device_id, r.co2, r.lpg, r.temp, r.humidity, r.status
from public.readings r
cross join ctx
where r.created_at >= (ctx.d::timestamp at time zone 'Asia/Manila')
  and r.created_at <  ((ctx.d + 1)::timestamp at time zone 'Asia/Manila')
order by r.created_at asc
limit 1000 offset 0;

-- (6) fetchMonthReadings(): same shape, whole month. This is the one that
--     pages through ~N thousand rows, re-running the range scan for every
--     page, so look at both the per-row RLS filter and the OFFSET cost.
explain (analyze, buffers)
with ctx as (
  select max((created_at at time zone 'Asia/Manila')::date) as d
  from public.readings
),
bounds as (
  select date_trunc('month', d)::date as lo,
         (date_trunc('month', d) + interval '1 month')::date as hi
  from ctx
)
select r.created_at, r.device_id, r.co2, r.lpg, r.temp, r.humidity, r.status
from public.readings r
cross join bounds b
where r.created_at >= (b.lo::timestamp at time zone 'Asia/Manila')
  and r.created_at <  (b.hi::timestamp at time zone 'Asia/Manila')
order by r.created_at asc
limit 1000 offset 0;

-- (7) Index probe for the device "latest reading" view (offline indicator).
--     Must be an Index Scan using readings_device_created_desc_idx, not a
--     Sort over the whole table.
explain (analyze, buffers)
select * from public.device_latest_reading;

-- ---------------------------------------------------------------------------
-- Section 4 - queries the UI exports but does not currently call.
-- ---------------------------------------------------------------------------
select * from public.air_explain_body(
  'public.report_day_detail(date,text,jsonb,integer)',
  (select jsonb_build_object(
            'p_day',           quote_literal(to_char(d, 'YYYY-MM-DD')),
            'p_device_id',     'null',
            'p_thresholds',    quote_literal('{}'),
            'p_bucket_seconds', '300')
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

select * from public.air_explain_body(
  'public.report_day_danger_rows(date,text,jsonb,integer,integer)',
  (select jsonb_build_object(
            'p_day',        quote_literal(to_char(d, 'YYYY-MM-DD')),
            'p_device_id',  'null',
            'p_thresholds', quote_literal('{}'),
            'p_limit',      '250',
            'p_offset',     '0')
   from (select max((created_at at time zone 'Asia/Manila')::date) as d
         from public.readings) s)
);

-- Everything above was read-only; roll the helper function back.
rollback;
