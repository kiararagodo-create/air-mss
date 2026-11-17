-- Migration: SMS policy, credit monitoring and brownout grouping.
--
-- Adds:
--   * sms_credit_snapshots - history of iProgSMS balance checks (shown on the
--     Notifications page).
--   * Columns on sms_alert_settings for the SMS policy:
--       sms_for_warnings        - enable SMS for warning-level alerts (default false)
--       sms_reminder_minutes    - reminder interval minutes (default 30)
--       last_credit_balance     - last observed iProgSMS balance (messages)
--       last_credit_check_at    - when the balance was last checked
--       low_credit_warning_email_sent_at - once-only "below threshold" email sent at
--       empty_credit_email_sent_at         - once-only "empty" email sent at
-- Idempotent: safe to re-run.

do $$
begin
  if to_regclass('public.sms_alert_settings') is null then
    raise warning 'public.sms_alert_settings does not exist - run the SMS alert schema migration first';
    return;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'sms_for_warnings'
  ) then
    alter table public.sms_alert_settings
      add column sms_for_warnings boolean not null default false;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'sms_reminder_minutes'
  ) then
    alter table public.sms_alert_settings
      add column sms_reminder_minutes integer not null default 30
        check (sms_reminder_minutes between 5 and 1440);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'last_credit_balance'
  ) then
    alter table public.sms_alert_settings
      add column last_credit_balance integer;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'last_credit_check_at'
  ) then
    alter table public.sms_alert_settings
      add column last_credit_check_at timestamptz;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'low_credit_warning_email_sent_at'
  ) then
    alter table public.sms_alert_settings
      add column low_credit_warning_email_sent_at timestamptz;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'empty_credit_email_sent_at'
  ) then
    alter table public.sms_alert_settings
      add column empty_credit_email_sent_at timestamptz;
  end if;

  -- Default the reminder interval to 30 minutes and the low-credit threshold to
  -- 50 messages (the policy constant) for the canonical row.
  update public.sms_alert_settings
  set sms_reminder_minutes = coalesce(sms_reminder_minutes, 30),
      low_credit_threshold = coalesce(low_credit_threshold, 50),
      updated_at = now()
  where id = 1;
end $$;

-- History of iProgSMS balance checks. One row per check.
create table if not exists public.sms_credit_snapshots (
  id          bigserial primary key,
  checked_at  timestamptz not null default now(),
  balance     integer not null,
  source      text not null default 'iprog',
  note        text
);

create index if not exists sms_credit_snapshots_checked_at_idx
  on public.sms_credit_snapshots (checked_at desc);

alter table public.sms_credit_snapshots enable row level security;

drop policy if exists "admins read sms_credit_snapshots" on public.sms_credit_snapshots;
create policy "admins read sms_credit_snapshots"
  on public.sms_credit_snapshots for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id::text = auth.uid()::text
      and p.role = 'admin' and p.account_status = 'approved' and p.is_active
  ));

drop policy if exists "service role full sms_credit_snapshots" on public.sms_credit_snapshots;
create policy "service role full sms_credit_snapshots"
  on public.sms_credit_snapshots for all to service_role
  using (true) with check (true);

notify pgrst, 'reload schema';

-- Widen sms_logs.status so every SMS policy decision can be logged
-- (skipped_email_only, skipped_channel, skipped_already_notified).
do $$
begin
  alter table public.sms_logs drop constraint if exists sms_logs_status_check;
  alter table public.sms_logs
    add constraint sms_logs_status_check
    check (status in (
      'submitted','in_progress','failed','invalid_number','skipped_no_number',
      'skipped_dry_run','skipped_low_credits','skipped_rate_limited',
      'skipped_no_recipients','skipped_open_incident','skipped_quality',
      'skipped_email_only','skipped_channel','skipped_already_notified'
    ));
end $$;

-- Verification
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'sms_alert_settings'
  and column_name in (
    'sms_for_warnings','sms_reminder_minutes','last_credit_balance',
    'last_credit_check_at','low_credit_warning_email_sent_at','empty_credit_email_sent_at'
  )
order by ordinal_position;

select * from public.sms_alert_settings where id = 1;
