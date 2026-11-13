-- Per-personnel minimum SMS severity for automatic alert SMS.
-- 'warning' = Warning and up (default), 'danger' = Danger/Critical only.
alter table public.profiles
  add column if not exists sms_min_severity text;

update public.profiles
set sms_min_severity = coalesce(sms_min_severity, 'warning')
where sms_min_severity is null;

alter table public.profiles
  alter column sms_min_severity set default 'warning';

alter table public.profiles
  drop constraint if exists profiles_sms_min_severity_check;

alter table public.profiles
  add constraint profiles_sms_min_severity_check
  check (sms_min_severity in ('warning', 'danger'));

notify pgrst, 'reload schema';
