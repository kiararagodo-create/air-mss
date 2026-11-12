-- Migration: widen public.daily_summaries metric columns to numeric(14,3)
-- and make refresh_daily_summaries() overflow-proof.
--
-- Why
--   20261003000000 now computes every min/max/avg from physically valid
--   readings only, which keeps real values inside the sensor ranges. This
--   migration is the second line of defence: public.readings has demonstrated
--   glitch values as large as 3.6e26, and a future aggregate or a new sensor
--   must never be able to abort a refresh with SQLSTATE 22003 ("numeric field
--   overflow").
--
-- What changes
--   1. The 12 metric columns (co2/lpg/temp/humidity min/max/avg) are widened
--      from numeric(12,3) to numeric(14,3). There are no sum columns.
--   2. report_summary_value(), used by refresh_daily_summaries() for all 12
--      assignments, is replaced with the wider clamp. It wraps each value in
--      least()/greatest() so even a value that somehow escapes the validity
--      filter is stored as a saturated number instead of raising.
--
-- This migration does not touch public.readings and does not change the
-- valid-only filtering rule from 20261003000000.

alter table public.daily_summaries
  alter column co2_min      type numeric(14, 3),
  alter column co2_max      type numeric(14, 3),
  alter column co2_avg      type numeric(14, 3),
  alter column lpg_min      type numeric(14, 3),
  alter column lpg_max      type numeric(14, 3),
  alter column lpg_avg      type numeric(14, 3),
  alter column temp_min     type numeric(14, 3),
  alter column temp_max     type numeric(14, 3),
  alter column temp_avg     type numeric(14, 3),
  alter column humidity_min type numeric(14, 3),
  alter column humidity_max type numeric(14, 3),
  alter column humidity_avg type numeric(14, 3);

create or replace function public.report_summary_value(p_value numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_value is null then null
    else least(99999999999.999, greatest(-99999999999.999, p_value))
  end;
$$;

comment on function public.report_summary_value(numeric) is
  'Clamp a daily_summaries metric to numeric(14,3) so one bad value cannot abort a refresh.';

analyze public.daily_summaries;

notify pgrst, 'reload schema';
