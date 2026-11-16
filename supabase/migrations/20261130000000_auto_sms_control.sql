-- 20261130000000_auto_sms_control.sql
-- Add automatic SMS control columns and extend sms_logs status check
-- Idempotent: safe to run multiple times.
-- Notify pgrst to reload schema after running.

begin;

-- ---------------------------------------------------------------------------
-- sms_alert_settings: add automatic SMS control columns (if missing)
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'auto_sms_enabled') then
        alter table public.sms_alert_settings add column auto_sms_enabled boolean not null default true;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'auto_sms_paused_until') then
        alter table public.sms_alert_settings add column auto_sms_paused_until timestamptz;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'always_send_danger') then
        alter table public.sms_alert_settings add column always_send_danger boolean not null default true;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'auto_sms_co2') then
        alter table public.sms_alert_settings add column auto_sms_co2 boolean not null default true;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'auto_sms_lpg') then
        alter table public.sms_alert_settings add column auto_sms_lpg boolean not null default true;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'auto_sms_temp') then
        alter table public.sms_alert_settings add column auto_sms_temp boolean not null default true;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'auto_sms_humidity') then
        alter table public.sms_alert_settings add column auto_sms_humidity boolean not null default true;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'auto_sms_offline') then
        alter table public.sms_alert_settings add column auto_sms_offline boolean not null default true;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'updated_by') then
        alter table public.sms_alert_settings add column updated_by uuid;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sms_alert_settings' and column_name = 'updated_at') then
        alter table public.sms_alert_settings add column updated_at timestamptz not null default now();
    end if;
end
$$;

-- Update existing row with defaults (idempotent)
update public.sms_alert_settings
set
    auto_sms_enabled = coalesce(auto_sms_enabled, true),
    auto_sms_paused_until = coalesce(auto_sms_paused_until, null::timestamptz),
    always_send_danger = coalesce(always_send_danger, true),
    auto_sms_co2 = coalesce(auto_sms_co2, true),
    auto_sms_lpg = coalesce(auto_sms_lpg, true),
    auto_sms_temp = coalesce(auto_sms_temp, true),
    auto_sms_humidity = coalesce(auto_sms_humidity, true),
    auto_sms_offline = coalesce(auto_sms_offline, true),
    updated_by = coalesce(updated_by, auth.uid()),
    updated_at = now()
where id = 1;

-- Idempotent insert if row missing
insert into public.sms_alert_settings (id, automatic_sms, auto_sms_enabled, always_send_danger, auto_sms_co2, auto_sms_lpg, auto_sms_temp, auto_sms_humidity, auto_sms_offline, updated_by, updated_at)
values (1, true, true, true, true, true, true, true, true, null, now())
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS policies for sms_alert_settings
-- ---------------------------------------------------------------------------
drop policy if exists "admins manage sms_alert_settings" on public.sms_alert_settings;
create policy "admins manage sms_alert_settings"
  on public.sms_alert_settings for all to authenticated
  using (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.role='admin' and p.account_status='approved' and p.is_active))
  with check (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.role='admin' and p.account_status='approved' and p.is_active));

drop policy if exists "approved read sms_alert_settings" on public.sms_alert_settings;
create policy "approved read sms_alert_settings"
  on public.sms_alert_settings for select to authenticated
  using (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.is_active and (p.role='admin' or p.account_status='approved')));

-- Grant service role full access (already exists, but ensure it)
drop policy if exists "service role full sms_alert_settings" on public.sms_alert_settings;
create policy "service role full sms_alert_settings"
  on public.sms_alert_settings for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Audit table for automatic SMS setting changes
-- ---------------------------------------------------------------------------
create table if not exists public.sms_auto_settings_audit (
    id bigserial primary key,
    setting_key text not null,
    old_value text,
    new_value text,
    changed_by uuid not null references public.profiles(id),
    changed_at timestamptz not null default now()
);

grant ALL on public.sms_auto_settings_audit to service_role;
grant SELECT on public.sms_auto_settings_audit to authenticated;

-- ---------------------------------------------------------------------------
-- Extend sms_logs.status CHECK constraint to allow 'skipped_auto_off'
-- ---------------------------------------------------------------------------
do $$
declare
    v_constraint text;
    v_has_skipped_auto_off boolean;
begin
    -- Check if constraint already includes skipped_auto_off
    select true into v_has_skipped_auto_off
    from pg_constraint c,
         pg_namespace n,
         jsonb_each_text(c.ccheck) k(k, v)
    where c.conname = 'sms_logs_status_check'
      and c.conrelid = 'sms_logs'::regclass
      and k.v = 'skipped_auto_off';

    if not v_has_skipped_auto_off then
        -- Drop and recreate the constraint to add 'skipped_auto_off'
        alter table public.sms_logs drop constraint sms_logs_status_check;

        alter table public.sms_logs add constraint sms_logs_status_check
          check (status in (
            'submitted','in_progress','failed','invalid_number',
            'skipped_no_number','skipped_dry_run','skipped_low_credits','skipped_rate_limited',
            'skipped_no_recipients','skipped_open_incident','skipped_quality',
            'skipped_acknowledged','skipped_invalid_number','skipped_disabled',
            'skipped_cooldown','sent','skipped_auto_off'
          ));
    end if;
end
$$;

notify pgrst, 'reload schema';
commit;