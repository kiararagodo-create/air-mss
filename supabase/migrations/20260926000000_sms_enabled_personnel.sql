-- Add per-person SMS toggle to profiles (personnel).
alter table public.profiles
  add column if not exists sms_enabled boolean not null default true;

update public.profiles
  set sms_enabled = true
  where sms_enabled is null;

-- Widen sms_logs.status so all skip reasons (incl. invalid numbers) can be logged.
alter table public.sms_logs drop constraint if exists sms_logs_status_check;
alter table public.sms_logs add constraint sms_logs_status_check
  check (status in (
    'submitted','in_progress','failed','skipped_no_number',
    'skipped_low_credits','skipped_dry_run','invalid_number'
  ));
