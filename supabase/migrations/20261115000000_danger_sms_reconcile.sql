-- Migration: danger SMS automatic sending + reconcile step
-- Updates report_metric_is_valid to plausible ranges, recomputes daily_summaries,
-- adds reconcile_danger_sms() function, and upgrades sms_logs tracking.

-- ---------------------------------------------------------------------------
-- 1. Update report_metric_is_valid to use plausible room-condition ranges
--    (temperature 10..50, humidity 5..100, CO2 300..10000, LPG 0..10000)
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
--    statement can time out or roll back everything. The function
--    refresh_daily_summaries() already uses report_metric_is_valid, so re-running
--    it will pick up the new plausible ranges.
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

-- ---------------------------------------------------------------------------
-- 3. Upgrade sms_logs table: add notification_id column (if missing) with index,
--    and add a check constraint for valid status values.
--    The notification_id links sms_logs to the air_notifications row that
--    generated the log entry.
-- ---------------------------------------------------------------------------
-- Add notification_id column if it doesn't exist (Postgres: add column, then index)
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'sms_logs' and column_name = 'notification_id') then
    alter table public.sms_logs add column notification_id integer;
    create index idx_sms_logs_notification_id on public.sms_logs (notification_id);
    raise notice 'sms_logs: added notification_id column and index';
  else
    raise notice 'sms_logs: notification_id column already exists';
  end if;
end $$;

-- Add check constraint for valid status values (idempotent drop/add pattern)
alter table public.sms_logs drop constraint if exists sms_logs_status_check;
alter table public.sms_logs add constraint sms_logs_status_check
  check (status in (
    'submitted',
    'failed',
    'skipped_quality',
    'skipped_open_incident',
    'skipped_rate_limited',
    'skipped_no_recipients',
    'skipped_no_number',
    'skipped_low_credits',
    'skipped_dry_run',
    'in_progress',
    'invalid_number'
  ));

-- ---------------------------------------------------------------------------
-- 4. Create reconcile_danger_sms() function
--    Returns notifications from the last 60 minutes that have NO sms_logs row
--    (any status) and a valid reading, grouped by notification id and why they're pending.
--    This function does NOT send any SMS; it only reports what is pending.
--    Callers can then manually invoke sendSmsForNotification for each pending entry.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_danger_sms()
returns table (
  notification_id integer,
  device_id text,
  severity text,
  level_label text,
  days_since_created integer,
  reason text
) language plpgsql stable set search_path = public
as $$
declare
  cutoff timestamptz := now() - interval '60 minutes';
  max_failed_attempts constant integer := 2;
  min_wait_seconds constant integer := 300;
begin
  return query
  select
    n.id as notification_id,
    n.device_id,
    n.severity,
    n.level_label,
    extract(epoch from (now() - n.created_at)) / 86400 as days_since_created,
    case
      when f.failed_count >= max_failed_attempts then 'max_failed_attempts_reached'
      when s.id is null then 'no_sms_logs'
      when s.status = 'submitted' then 'already_submitted'
      when s.status like 'skipped_%' then
        case
          when s.status in ('skipped_low_credits', 'skipped_rate_limited') then 'retry_possible'
          else 'skipped_never_retry'
        end
      else 'sms_failed_' || s.status
    end as reason,
    f.last_failed_at,
    f.failed_count
  from public.air_notifications n
  left join lateral (
    select count(*)::integer as failed_count,
           max(sent_at) as last_failed_at
    from public.sms_logs
    where notification_id = n.id and status = 'failed'
    group by notification_id
  ) f on true
  left join lateral (
    select id, status, sent_at, received_at
    from public.sms_logs
    where notification_id = n.id
    order by sent_at desc
    limit 1
  ) s on true
  where n.severity in ('danger', 'critical', 'high')
    and n.status = 'open'
    and n.created_at >= cutoff
    and (
      f.failed_count < max_failed_attempts
      or s.id is null
      or s.status != 'submitted'
    )
  order by n.severity desc, n.created_at asc;
end
$$;

comment on function public.reconcile_danger_sms() is
  'List air_notifications (danger/critical/high, open, last 60 min) that have < 2 failed sms_logs rows and either no attempt yet or last attempt not submitted. Includes retry_possible for skipped_low_credits/skipped_rate_limited. Does NOT send SMS. Use with sendSmsForNotification to retry.';

-- ---------------------------------------------------------------------------
-- 5. Notify pgrst to reload schema
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';