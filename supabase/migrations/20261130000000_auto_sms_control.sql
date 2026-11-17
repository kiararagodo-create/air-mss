-- 20261130000000_auto_sms_control.sql
--
-- Automatic SMS on/off controls (AIR-MSS).
--
-- Adds the settings columns that let an admin pause or disable *automatic*
-- (server-side) SMS from the Notifications page, a per-sensor allow list, the
-- "always text DANGER alerts" lock, an audit trail of who changed what, and the
-- 'skipped_auto_off' status used when a send is intentionally suppressed.
--
-- Reuses the existing single-row table public.sms_alert_settings (id = 1) that
-- the air-alerts Edge Function already reads - no duplicate settings table.
-- Every default matches today's behaviour, so nothing changes until an admin
-- flips a switch.
--
-- Idempotent: safe to run multiple times. Ends with NOTIFY pgrst so PostgREST
-- picks up the new columns / constraint without a manual schema reload.
--
-- ROLLBACK (run manually if you need to undo this migration):
-- ---------------------------------------------------------------------------
-- begin;
--   drop trigger if exists trg_sms_auto_settings_audit on public.sms_alert_settings;
--   drop function if exists public.log_sms_auto_settings_change();
--   drop table if exists public.sms_auto_settings_audit;
--   alter table public.sms_alert_settings
--     drop column if exists auto_sms_enabled,
--     drop column if exists auto_sms_paused_until,
--     drop column if exists always_send_danger,
--     drop column if exists auto_sms_co2,
--     drop column if exists auto_sms_lpg,
--     drop column if exists auto_sms_temp,
--     drop column if exists auto_sms_humidity,
--     drop column if exists auto_sms_offline,
--     drop column if exists updated_by;
--   -- Re-tighten sms_logs.status (drops 'skipped_auto_off').
--   alter table public.sms_logs drop constraint if exists sms_logs_status_check;
--   alter table public.sms_logs add constraint sms_logs_status_check
--     check (status in (
--       'submitted','in_progress','failed','invalid_number','skipped_no_number',
--       'skipped_dry_run','skipped_low_credits','skipped_rate_limited',
--       'skipped_no_recipients','skipped_open_incident','skipped_quality',
--       'skipped_email_only','skipped_channel','skipped_already_notified'
--     ));
--   notify pgrst, 'reload schema';
-- commit;
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. sms_alert_settings: automatic SMS control columns (ADD COLUMN IF NOT EXISTS)
-- ---------------------------------------------------------------------------
alter table public.sms_alert_settings add column if not exists auto_sms_enabled boolean not null default true;
alter table public.sms_alert_settings add column if not exists auto_sms_paused_until timestamptz;
alter table public.sms_alert_settings add column if not exists always_send_danger boolean not null default true;
alter table public.sms_alert_settings add column if not exists auto_sms_co2 boolean not null default true;
alter table public.sms_alert_settings add column if not exists auto_sms_lpg boolean not null default true;
alter table public.sms_alert_settings add column if not exists auto_sms_temp boolean not null default true;
alter table public.sms_alert_settings add column if not exists auto_sms_humidity boolean not null default true;
alter table public.sms_alert_settings add column if not exists auto_sms_offline boolean not null default true;
alter table public.sms_alert_settings add column if not exists updated_by uuid;
alter table public.sms_alert_settings add column if not exists updated_at timestamptz not null default now();

-- Make sure the canonical single row exists and every new column is filled.
insert into public.sms_alert_settings (id) values (1) on conflict (id) do nothing;
update public.sms_alert_settings
set
  auto_sms_enabled       = coalesce(auto_sms_enabled, true),
  auto_sms_paused_until  = coalesce(auto_sms_paused_until, null::timestamptz),
  always_send_danger     = coalesce(always_send_danger, true),
  auto_sms_co2           = coalesce(auto_sms_co2, true),
  auto_sms_lpg           = coalesce(auto_sms_lpg, true),
  auto_sms_temp          = coalesce(auto_sms_temp, true),
  auto_sms_humidity      = coalesce(auto_sms_humidity, true),
  auto_sms_offline       = coalesce(auto_sms_offline, true),
  updated_at             = coalesce(updated_at, now())
where id = 1;

-- ---------------------------------------------------------------------------
-- 2. RLS: everyone signed-in reads; only an active admin writes.
-- ---------------------------------------------------------------------------
alter table public.sms_alert_settings enable row level security;

drop policy if exists "sms_auto_settings_select" on public.sms_alert_settings;
create policy "sms_auto_settings_select"
  on public.sms_alert_settings for select to authenticated
  using (true);

drop policy if exists "sms_auto_settings_insert_admin" on public.sms_alert_settings;
create policy "sms_auto_settings_insert_admin"
  on public.sms_alert_settings for insert to authenticated
  with check (public.is_active_admin());

drop policy if exists "sms_auto_settings_update_admin" on public.sms_alert_settings;
create policy "sms_auto_settings_update_admin"
  on public.sms_alert_settings for update to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

drop policy if exists "service role full sms_alert_settings" on public.sms_alert_settings;
create policy "service role full sms_alert_settings"
  on public.sms_alert_settings for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 3. Audit: who / when / what changed.
-- ---------------------------------------------------------------------------
create table if not exists public.sms_auto_settings_audit (
  id          bigserial primary key,
  setting_key text not null,
  old_value   text,
  new_value   text,
  changed_by  uuid references public.profiles(id) on delete set null,
  changed_at  timestamptz not null default now()
);

-- Older copies created changed_by as NOT NULL; service-role writes have no
-- auth.uid(), so relax it (idempotent).
alter table public.sms_auto_settings_audit alter column changed_by drop not null;

create index if not exists sms_auto_settings_audit_changed_at_idx
  on public.sms_auto_settings_audit (changed_at desc);

alter table public.sms_auto_settings_audit enable row level security;
drop policy if exists "sms_auto_settings_audit_select" on public.sms_auto_settings_audit;
create policy "sms_auto_settings_audit_select"
  on public.sms_auto_settings_audit for select to authenticated
  using (true);
drop policy if exists "service role full sms_auto_settings_audit" on public.sms_auto_settings_audit;
create policy "service role full sms_auto_settings_audit"
  on public.sms_auto_settings_audit for all to service_role using (true) with check (true);

create or replace function public.log_sms_auto_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by uuid := auth.uid();
begin
  if new.auto_sms_enabled is distinct from old.auto_sms_enabled then
    insert into public.sms_auto_settings_audit (setting_key, old_value, new_value, changed_by)
    values ('auto_sms_enabled', old.auto_sms_enabled::text, new.auto_sms_enabled::text, v_by);
  end if;
  if new.auto_sms_paused_until is distinct from old.auto_sms_paused_until then
    insert into public.sms_auto_settings_audit (setting_key, old_value, new_value, changed_by)
    values ('auto_sms_paused_until', old.auto_sms_paused_until::text, new.auto_sms_paused_until::text, v_by);
  end if;
  if new.always_send_danger is distinct from old.always_send_danger then
    insert into public.sms_auto_settings_audit (setting_key, old_value, new_value, changed_by)
    values ('always_send_danger', old.always_send_danger::text, new.always_send_danger::text, v_by);
  end if;
  if new.auto_sms_co2 is distinct from old.auto_sms_co2 then
    insert into public.sms_auto_settings_audit (setting_key, old_value, new_value, changed_by)
    values ('auto_sms_co2', old.auto_sms_co2::text, new.auto_sms_co2::text, v_by);
  end if;
  if new.auto_sms_lpg is distinct from old.auto_sms_lpg then
    insert into public.sms_auto_settings_audit (setting_key, old_value, new_value, changed_by)
    values ('auto_sms_lpg', old.auto_sms_lpg::text, new.auto_sms_lpg::text, v_by);
  end if;
  if new.auto_sms_temp is distinct from old.auto_sms_temp then
    insert into public.sms_auto_settings_audit (setting_key, old_value, new_value, changed_by)
    values ('auto_sms_temp', old.auto_sms_temp::text, new.auto_sms_temp::text, v_by);
  end if;
  if new.auto_sms_humidity is distinct from old.auto_sms_humidity then
    insert into public.sms_auto_settings_audit (setting_key, old_value, new_value, changed_by)
    values ('auto_sms_humidity', old.auto_sms_humidity::text, new.auto_sms_humidity::text, v_by);
  end if;
  if new.auto_sms_offline is distinct from old.auto_sms_offline then
    insert into public.sms_auto_settings_audit (setting_key, old_value, new_value, changed_by)
    values ('auto_sms_offline', old.auto_sms_offline::text, new.auto_sms_offline::text, v_by);
  end if;
  return new;
end $$;

drop trigger if exists trg_sms_auto_settings_audit on public.sms_alert_settings;
create trigger trg_sms_auto_settings_audit
  after update on public.sms_alert_settings
  for each row execute function public.log_sms_auto_settings_change();

-- ---------------------------------------------------------------------------
-- 4. sms_logs.status: allow 'skipped_auto_off' (and the other statuses the
--    Edge Function writes). Reads the current definition with
--    pg_get_constraintdef (text) - never pg_constraint.ccheck, which is a
--    pg_node_tree and cannot be fed to jsonb_each_text.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid)
    into v_def
  from pg_constraint
  where conname = 'sms_logs_status_check'
    and conrelid = 'public.sms_logs'::regclass;

  if v_def is null or position('skipped_auto_off' in v_def) = 0 then
    alter table public.sms_logs drop constraint if exists sms_logs_status_check;
    alter table public.sms_logs add constraint sms_logs_status_check
      check (status in (
        'submitted','in_progress','failed','invalid_number','skipped_no_number',
        'skipped_dry_run','skipped_low_credits','skipped_rate_limited',
        'skipped_no_recipients','skipped_open_incident','skipped_quality',
        'skipped_acknowledged','skipped_invalid_number','skipped_disabled',
        'skipped_cooldown','sent','skipped_email_only','skipped_channel',
        'skipped_already_notified','skipped_auto_off'
      ));
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
