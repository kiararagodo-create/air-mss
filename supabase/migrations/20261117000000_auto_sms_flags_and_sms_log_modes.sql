-- Add auto/manual SMS markers and widen statuses for automatic alert SMS logging.
-- Safe to run multiple times.

alter table public.sms_logs
  add column if not exists send_mode text,
  add column if not exists is_auto boolean;

alter table public.sms_logs
  drop constraint if exists sms_logs_status_check;

alter table public.sms_logs
  add constraint sms_logs_status_check
  check (status in (
    'submitted',
    'in_progress',
    'failed',
    'invalid_number',
    'skipped_no_number',
    'skipped_dry_run',
    'skipped_low_credits',
    'skipped_rate_limited',
    'skipped_no_recipients',
    'skipped_open_incident',
    'skipped_quality',
    'skipped_acknowledged',
    'skipped_invalid_number',
    'skipped_disabled'
  ));

update public.sms_logs
set
  send_mode = coalesce(send_mode, case when coalesce(is_auto, false) then 'auto' else 'manual' end),
  is_auto = coalesce(is_auto, send_mode = 'auto')
where send_mode is null or is_auto is null;

alter table public.sms_logs
  alter column send_mode set default 'manual',
  alter column is_auto set default false;

create index if not exists sms_logs_send_mode_idx on public.sms_logs (send_mode);
create index if not exists sms_logs_is_auto_idx on public.sms_logs (is_auto);

notify pgrst, 'reload schema';
