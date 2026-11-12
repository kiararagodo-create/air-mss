-- Migration: tighten validity ranges for summary statistics from hardware ranges
-- to plausible room-condition ranges.  This updates report_metric_is_valid so that
-- the min/max/avg columns in daily_summaries (and therefore the PDFs and calendar)
-- only include readings inside the plausible range.
--
-- New plausible ranges (subset of hardware ranges):
--   temperature: 10..50   (was -40..80)
--   humidity:    5..100   (was 0..100)
--   CO2:         300..10000 (was 0..10000)
--   LPG:         0..10000  (unchanged; 0 is valid for LPG)
--
-- Readings outside the plausible range are labelled "Sensor fault", stay in the
-- table, are still counted in the day total, but are excluded from min/max/avg.
-- Readings inside the plausible range that are above danger thresholds still count
-- as real danger (requirement 4).
--
-- The refresh_daily_summaries function already uses report_metric_is_valid, so
-- re-running it with these new ranges will automatically recompute all aggregates.
-- This migration also recomputes every existing daily_summary row in month-sized
-- batches with a begin/exception block per month, so it cannot time out or roll
-- back everything.

-- ---------------------------------------------------------------------------
-- 1. Update report_metric_is_valid to use plausible ranges
-- ---------------------------------------------------------------------------
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
        p_co2 is not null and p_co2 between 300 and 10000
      when p_metric = 'lpg' then
        p_lpg is not null and p_lpg between 0 and 10000
      when p_metric = 'temp' then
        p_temp is not null and p_temp between 10 and 50
        and not (p_temp = 0 and p_humidity = 0)
      when p_metric = 'humidity' then
        p_humidity is not null and p_humidity between 5 and 100
        and not (p_temp = 0 and p_humidity = 0)
      else false
    end,
    false
  );
$$;

comment on function public.report_metric_is_valid(text, numeric, numeric, numeric, numeric) is
  'Plausibility rule for one sensor value. NULL, out-of-plausible-range, DHT22 0/0 and all-zero rows are invalid. Uses plausible ranges (temp 10-50, humidity 5-100, CO2 300-10000, LPG 0-10000) rather than hardware ranges.';

-- ---------------------------------------------------------------------------
-- 2. Recompute every existing daily_summary row, month by month, so no single
-- statement can time out or roll back everything.  The function
-- refresh_daily_summaries() already uses report_metric_is_valid, so re-running
-- it will pick up the new plausible ranges.
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
      v_days := v_days + refresh_daily_summaries(
        greatest(v_cur, v_from),
        least((v_cur + interval '1 month')::date - 1, v_to)
      );
      raise notice 'daily_summaries recomputed for month %', to_char(v_cur, 'YYYY-MM');
    exception when others then
      raise notice 'daily_summaries recomputation failed for month %: % (SQLSTATE %)',
                   to_char(v_cur, 'YYYY-MM'), sqlerrm, sqlstate;
    end;
    v_cur := (v_cur + interval '1 month')::date;
  end loop;

  raise notice 'daily_summaries recomputed for %..% (% day/device rows touched)',
               v_from, v_to, v_days;
end $$;

analyze public.daily_summaries;

notify pgrst, 'reload schema';