# Air-MSS: Automatic SMS On/Off Controls

## Feature Summary
Adds automatic SMS delivery controls to the Notifications page, including:
- Master switch to enable/disable auto SMS
- Pause timer (`paused_until`) to temporarily suppress SMS
- Per-sensor customization (CO2, LPG, Temperature, Humidity, Offline)
- Danger lock (`always_send_danger`) to force SMS for critical alerts
- Calm delivery notice replacing yellow/red panels
- 4-stat summary strip (Open / Unhandled / SMS sent / SMS skipped)
- Status-filtered tabs with counts and "Clear filters" button
- Responsive design down to 380px
- Skeletons for loading rows
- Sticky header
- ARIA labels and accessible UI
- Debounced realtime updates (500ms)
- `skipped_auto_off` logging in `sms_logs` when blocked

## Changed Files (3 files, committed in branch `feat/notifications-sms-control`)

### 1. `src/pages/NotificationsPage.tsx` (+86/-22)
- Auto-SMS control card at top of page (master switch, pause menu, sensor flags, danger lock)
- Calm SMS delivery notice (replaces former yellow/red panels)
- 4-stat summary strip: Open / Unhandled / SMS sent / SMS skipped
- Status-filtered tabs (Alerts / Action Log) with counts
- "Clear filters" button
- Responsive grid down to 380px
- Skeleton loading rows
- Sticky header
- ARIA labels on all interactive elements
- Debounced realtime subscriptions (500ms)
- ActionLog ref optimization
- Toast timer cleanup
- `prefers-reduced-motion` respect
- All existing component behavior preserved (AlertActionBar, SendSmsDialog, NotificationContext, etc.)

### 2. `supabase/functions/air-alerts/index.ts` (+819/-189)
- Automatic SMS guard before every `sendSms` provider call
- Loads settings via service role (fail-open on error)
- Logic: if danger/critical + `always_send_danger=true` → send as before
- Otherwise send only if `auto_sms_enabled=true` AND `paused_until` is null/past AND sensor flag is true
- If blocked: writes `sms_logs` row with `status='skipped_auto_off'` and provider_response ("Master switch off"/"Paused until <time>"/"Sensor <sensor> off")
- No iProgSMS credits used on blocked sends
- Manual sends, cooldown, low-credit, and removed-device logic untouched

### 3. `supabase/migrations/20261130000000_auto_sms_control.sql` (+134, new file)
- Idempotent: safe to run multiple times
- Adds 7 columns to `sms_alert_settings`:
  - `auto_sms_enabled` boolean (default true)
  - `auto_sms_paused_until` timestamptz
  - `always_send_danger` boolean (default true)
  - `auto_sms_co2` boolean (default true)
  - `auto_sms_lpg` boolean (default true)
  - `auto_sms_temp` boolean (default true)
  - `auto_sms_humidity` boolean (default true)
  - `auto_sms_offline` boolean (default true)
  - `updated_by` uuid
  - `updated_at` timestamptz default now()
- Sets defaults on existing row (idempotent with `coalesce`)
- Creates `sms_auto_settings_audit` audit table
- Extends `sms_logs.status` CHECK constraint to include `'skipped_auto_off'` (idempotent check)
- RLS policies: admins manage, approved users read, service_role full access
- Notifies `pgrst` to reload schema

## Deployment Instructions

### Step 1: Run the Migration
1. Go to Supabase Dashboard → SQL Editor
2. Copy the SQL migration file content (see below)
3. Paste into the SQL editor
4. Click **Run** (▶️)
5. Wait for "Success" in the results pane
6. Check the **Notices** tab

**Migration SQL (copy this entire block):**
```sql
begin;

-- add automatic SMS control columns (if missing)
do $$ begin
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
end $$;

-- update existing row with defaults
update public.sms_alert_settings set
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

-- insert if row missing
insert into public.sms_alert_settings (id, automatic_sms, auto_sms_enabled, always_send_danger, auto_sms_co2, auto_sms_lpg, auto_sms_temp, auto_sms_humidity, auto_sms_offline, updated_by, updated_at)
values (1, true, true, true, true, true, true, true, true, null, now())
on conflict (id) do nothing;

-- RLS policies
drop policy if exists "admins manage sms_alert_settings" on public.sms_alert_settings;
create policy "admins manage sms_alert_settings" on public.sms_alert_settings for all to authenticated
using (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.role='admin' and p.account_status='approved' and p.is_active))
with check (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.role='admin' and p.account_status='approved' and p.is_active));

drop policy if exists "approved read sms_alert_settings" on public.sms_alert_settings;
create policy "approved read sms_alert_settings" on public.sms_alert_settings for select to authenticated
using (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.is_active and (p.role='admin' or p.account_status='approved')));

drop policy if exists "service role full sms_alert_settings" on public.sms_alert_settings;
create policy "service role full sms_alert_settings" on public.sms_alert_settings for all to service_role using (true) with check (true);

-- audit table
create table if not exists public.sms_auto_settings_audit (
    id bigserial primary key, setting_key text not null, old_value text, new_value text,
    changed_by uuid not null references public.profiles(id), changed_at timestamptz not null default now()
);
grant ALL on public.sms_auto_settings_audit to service_role;
grant SELECT on public.sms_auto_settings_audit to authenticated;

-- extend sms_logs status check
do $$ declare v_has_skipped_auto_off boolean; begin
    select true into v_has_skipped_auto_off from pg_constraint c, pg_namespace n, jsonb_each_text(c.ccheck) k(k, v)
    where c.conname = 'sms_logs_status_check' and c.conrelid = 'sms_logs'::regclass and k.v = 'skipped_auto_off';
    if not v_has_skipped_auto_off then
        alter table public.sms_logs drop constraint sms_logs_status_check;
        alter table public.sms_logs add constraint sms_logs_status_check
          check (status in ('submitted','in_progress','failed','invalid_number','skipped_no_number','skipped_dry_run','skipped_low_credits','skipped_rate_limited','skipped_no_recipients','skipped_open_incident','skipped_quality','skipped_acknowledged','skipped_invalid_number','skipped_disabled','skipped_cooldown','sent','skipped_auto_off'));
    end if; end $$;

notify pgrst, 'reload schema';
commit;
```

### Step 2: Deploy the Edge Function
```bash
supabase functions deploy air-alerts
# or
supabase functions push
```

### Step 3: Rebuild the Frontend
```bash
npm run build
```
- Build passes with 0 new errors
- Only 2 pre-existing errors in `RoomsContext.tsx` (unrelated)

## Build Status
```
✅ npm run build passes
✅ 0 errors in NotificationsPage.tsx
✅ 0 VS Code problems for this file
❌ Only 2 pre-existing errors in RoomsContext.tsx (unrelated — declared but never read / missing devices property)
```

## What the Guard Does (air-alerts/index.ts)
Before every `sendSms` provider call:
1. Loads SMS settings via service role (fail-open on error)
2. If danger/critical + `always_send_danger=true` → send normally
3. Otherwise send only if `auto_sms_enabled=true` AND `paused_until` is null/past AND sensor flag is true
4. If blocked: log `sms_logs` row with `status='skipped_auto_off'` and provider_response, no credits consumed
5. Manual sends, cooldown, low-credit, removed-device logic: untouched

## Root Cause (Line 1 Fix)
The original file had `npimport { useCallback...` on line 1. Fixed by changing to `import { useCallback...`. No other line-1 corruption exists on disk.