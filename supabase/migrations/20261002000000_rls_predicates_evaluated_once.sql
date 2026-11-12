-- Migration: evaluate the RLS predicates on the reporting tables ONCE per
-- query instead of once per row.
--
-- Problem
--   A policy such as
--       using (public.is_approved_account())
--   calls a function directly in the USING clause. PostgreSQL has no way to
--   prove that call is constant for the statement, so it is re-evaluated for
--   EVERY candidate row the scan produces. Each call is a SECURITY DEFINER
--   lookup into public.profiles. On one month of readings that is tens of
--   thousands of extra function calls per report page - and the cost sits in
--   the plan as `Filter: (is_approved_account())` with "rows removed by
--   filter" in the thousands.
--
-- Fix
--   Wrap the predicate in a scalar sub-select with no outer references:
--       using ((select public.is_approved_account()))
--   Such a sub-select is flattened into an InitPlan, which PostgreSQL
--   evaluates exactly once and caches in a boolean Param for the rest of the
--   scan. The plan changes from
--       Filter: (is_approved_account())
--         -> Function Scan on is_approved_account
--   to
--       InitPlan 1 (returns $0)
--         -> Function Scan on is_approved_account
--
-- Nothing else changes: same roles, same access, same rows returned. The
-- helper functions are already STABLE + SECURITY DEFINER, so caching the
-- result for the duration of one statement is correct (they cannot see a
-- mid-statement change in profiles that matters).
--
-- Verify with scripts/explain_reports.sql section 3a before and after.

-- ---------------------------------------------------------------------------
-- 1. public.readings - the table every report RPC scans. This is the fix the
--    Reports page actually pays for.
-- ---------------------------------------------------------------------------
drop policy if exists "authenticated can read readings" on public.readings;
create policy "authenticated can read readings"
  on public.readings
  for select
  to authenticated
  using ((select public.is_approved_account()));

-- ---------------------------------------------------------------------------
-- 2. The other reporting tables whose SELECT policies call a function in the
--    USING clause. Same one-line change, no semantic change. Guarded like
--    20260929000000 does, so the migration still applies on a database where
--    an optional table is absent.
--    (public.daily_summaries is handled in the calendar migration, which also
--    has to change WHO can read it.)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.graph_buckets') is not null then
    drop policy if exists graph_buckets_admin_read on public.graph_buckets;
    create policy graph_buckets_admin_read
      on public.graph_buckets for select
      to authenticated
      using ((select public.is_approved_admin()));
  end if;

  if to_regclass('public.monthly_reports') is not null then
    drop policy if exists monthly_reports_admin_read on public.monthly_reports;
    create policy monthly_reports_admin_read
      on public.monthly_reports for select
      to authenticated
      using ((select public.is_approved_admin()));
  end if;

  if to_regclass('public.threshold_history') is not null then
    drop policy if exists threshold_history_admin_read on public.threshold_history;
    create policy threshold_history_admin_read
      on public.threshold_history for select
      to authenticated
      using ((select public.is_approved_admin()));
  end if;

  if to_regclass('public.reporting_config') is not null then
    drop policy if exists reporting_config_admin_read on public.reporting_config;
    create policy reporting_config_admin_read
      on public.reporting_config for select
      to authenticated
      using ((select public.is_approved_admin()));
  end if;
end $$;

-- Not changed here, same pattern available if a plan ever shows them hot:
--   public.rooms            -> using ((select public.is_approved_account()))
--   public.profiles         -> using ((select public.is_approved_admin()))
--   storage.objects         -> using (bucket_id = 'monthly-reports'
--                                     and (select public.is_approved_admin()))
-- All three of those tables hold a handful of rows, so they are not worth a
-- policy rewrite on their own.

notify pgrst, 'reload schema';
