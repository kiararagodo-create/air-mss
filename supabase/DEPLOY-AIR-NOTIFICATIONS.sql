-- =============================================================================
-- DEPLOY THIS FILE — fixes: "Could not find the table 'public.air_notifications'
-- in the schema cache" on the Notifications page / bell.
-- =============================================================================
-- HOW TO RUN (once, ~1 minute):
--   1. Supabase Dashboard -> SQL Editor -> New query
--   2. Paste this ENTIRE file, click Run. Wait for "Success".
--   3. Back in the app, click Refresh on the Notifications page (or reload).
-- Safe to re-run: every statement is CREATE IF NOT EXISTS / DROP IF EXISTS.
-- This file is migrations/20260918000000_air_notifications.sql copied verbatim
-- (plus this header) because DEPLOY-ALL.sql / PASTE-IN-SUPABASE.sql predate it
-- and do NOT include it — that is why the table was missing in the live DB.
-- It creates: air_notifications, notification_recipients, sms_logs,
-- notification_actions, notification_reads (+ RLS + realtime).
-- NOTE: after running, the bell badge + this page work. SMS + auto rows still
-- need the air-alerts Edge Function + readings webhook (see
-- docs/AIR-NOTIFICATIONS-TEST-PLAN.md) — until then the bell shows LIVE alerts
-- derived from the dashboard readings.
-- =============================================================================

-- Migration: air_notifications — sensor-driven alert notifications.
--
-- WHY A NEW TABLE INSTEAD OF public.notifications
--   public.notifications already exists (20260911010000_account_approval.sql).
--   It is the per-user mailbox for account events (approved / rejected /
--   disabled / report_ready): user_id, kind, title, body, read. Re-using it for
--   sensor alerts would mix two unrelated lifecycles and break the bell's
--   mark-read semantics. Sensor alerts therefore live in air_notifications
--   and are UNIONed into the bell feed in the client (NotificationContext).
--   The brief's "notifications" columns map 1:1 onto air_notifications.
--
-- Columns map to the brief:
--   id, device_id, room_name, floor, sensor_type, level_label + severity,
--   reading_value + reading_unit, message, status, handled_by_*,
--   created_at, resolved_at.
--
-- Dedup rule (brief §1): ONE open notification per device + sensor + level.
-- Enforced with a partial unique index. On level change the Edge Function
-- resolves the old row and inserts a new one (escalation_of points back).
-- When the reading returns to Safe/Comfortable the open row is resolved.
--
-- RLS: Admin sees everything. Maintenance / Security see only notifications
-- addressed to them (a row exists in notification_recipients for their
-- profiles.id). The public /action/<token> page never reads these tables
-- directly — it goes through the air-action Edge Function (service role).

-- ---------------------------------------------------------------------------
-- 1. Core alert table
-- ---------------------------------------------------------------------------

create table if not exists public.air_notifications (
  id            bigserial primary key,
  device_id     text        not null,
  room_name     text        not null default '',
  floor         text        not null default '',
  sensor_type   text        not null
                check (sensor_type in ('co2','lpg','temp','humidity','device')),
  level_label   text        not null,
                -- Warning, High, Danger, Low Leak, Alarm, Critical,
                -- Freeze, Cool, Heat, Dry, Low, Mold Risk, Offline, Online
  severity      text        not null default 'warning'
                check (severity in ('info','warning','high','danger','critical')),
  reading_value numeric,
  reading_unit  text        not null default '',
  message       text        not null default '',
  status        text        not null default 'open'
                check (status in ('open','acknowledged','resolved')),
  handled_by_name text,
  handled_by_role text,
  handled_at    timestamptz,
  escalation_of bigint references public.air_notifications(id) on delete set null,
  resolution_note text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- Dedup: one open row per device + sensor + level_label.
create unique index if not exists air_notifications_one_open_per_device_sensor_level
  on public.air_notifications (device_id, sensor_type, level_label)
  where status = 'open';

-- Fast paths for the list page filters and the bell poll.
create index if not exists air_notifications_status_idx
  on public.air_notifications (status);
create index if not exists air_notifications_severity_idx
  on public.air_notifications (severity);
create index if not exists air_notifications_created_at_idx
  on public.air_notifications (created_at desc);
create index if not exists air_notifications_device_idx
  on public.air_notifications (device_id);
create index if not exists air_notifications_sensor_idx
  on public.air_notifications (sensor_type);

-- ---------------------------------------------------------------------------
-- 2. Recipients: one row per notification x personnel, holds the action token.
-- ---------------------------------------------------------------------------

create table if not exists public.notification_recipients (
  id            bigserial primary key,
  notification_id bigint not null
                  references public.air_notifications(id) on delete cascade,
  personnel_id  uuid references public.profiles(id) on delete set null,
  personnel_name text not null default '',
  personnel_role text not null default '',
  phone         text,
  action_token  text not null,
  expires_at    timestamptz not null default (now() + interval '7 days'),
  created_at    timestamptz not null default now(),
  unique (notification_id, personnel_id)
);

create unique index if not exists notification_recipients_token_idx
  on public.notification_recipients (action_token);
create index if not exists notification_recipients_notification_idx
  on public.notification_recipients (notification_id);
create index if not exists notification_recipients_personnel_idx
  on public.notification_recipients (personnel_id);

-- ---------------------------------------------------------------------------
-- 3. SMS log: one row per send attempt (matches IPROG "SMS Messages" history).
-- ---------------------------------------------------------------------------

create table if not exists public.sms_logs (
  id              bigserial primary key,
  notification_id bigint references public.air_notifications(id) on delete set null,
  personnel_id    uuid references public.profiles(id) on delete set null,
  recipient_name  text not null default '',
  recipient_role  text not null default '',
  phone           text,
  message         text not null default '',
  status          text not null default 'submitted'
                  check (status in ('submitted','in_progress','failed','skipped_no_number')),
  provider_response text,
  sent_at         timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists sms_logs_notification_idx
  on public.sms_logs (notification_id, sent_at desc);
create index if not exists sms_logs_status_idx
  on public.sms_logs (status);
create index if not exists sms_logs_sent_at_idx
  on public.sms_logs (sent_at desc);

-- ---------------------------------------------------------------------------
-- 4. Actions taken via the SMS link (or the Notifications page).
-- ---------------------------------------------------------------------------

create table if not exists public.notification_actions (
  id              bigserial primary key,
  notification_id bigint not null
                    references public.air_notifications(id) on delete cascade,
  personnel_id    uuid references public.profiles(id) on delete set null,
  personnel_name  text not null default '',
  personnel_role  text not null default '',
  action          text not null
                    check (action in ('acknowledge','on_my_way','resolved','false_alarm','repaired','sms_sent')),
  note            text,
  taken_at        timestamptz not null default now()
);

create index if not exists notification_actions_notification_idx
  on public.notification_actions (notification_id, taken_at desc);
create index if not exists notification_actions_personnel_idx
  on public.notification_actions (personnel_id);

-- ---------------------------------------------------------------------------
-- 5. Read-status per user for the bell badge (air_notifications are shared,
--    so a single boolean on the row would mark it read for everyone).
-- ---------------------------------------------------------------------------

create table if not exists public.notification_reads (
  notification_id bigint not null
                    references public.air_notifications(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

create index if not exists notification_reads_user_idx
  on public.notification_reads (user_id);

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------

alter table public.air_notifications enable row level security;
alter table public.notification_recipients enable row level security;
alter table public.sms_logs enable row level security;
alter table public.notification_actions enable row level security;
alter table public.notification_reads enable row level security;

-- is_active_admin() exists since 20260915000000. Re-create defensively so this
-- file applies standalone on a fresh project.
create or replace function public.is_active_admin()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id::text = auth.uid()::text
      and p.role = 'admin'
      and p.account_status = 'approved'
      and p.is_active
  );
$$;

-- air_notifications: admin all; staff read own-addressed.
drop policy if exists "admins full air_notifications" on public.air_notifications;
create policy "admins full air_notifications"
  on public.air_notifications for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

drop policy if exists "staff read addressed air_notifications" on public.air_notifications;
create policy "staff read addressed air_notifications"
  on public.air_notifications for select to authenticated
  using (
    exists (
      select 1 from public.notification_recipients r
      where r.notification_id = public.air_notifications.id
        and r.personnel_id::text = auth.uid()::text
    )
  );

-- Staff may acknowledge/resolve notifications addressed to them (Notifications
-- page action buttons). Status changes still go through the same columns the
-- token flow uses, so the timeline stays consistent.
drop policy if exists "staff update addressed air_notifications" on public.air_notifications;
create policy "staff update addressed air_notifications"
  on public.air_notifications for update to authenticated
  using (
    exists (
      select 1 from public.notification_recipients r
      where r.notification_id = public.air_notifications.id
        and r.personnel_id::text = auth.uid()::text
    )
  )
  with check (
    exists (
      select 1 from public.notification_recipients r
      where r.notification_id = public.air_notifications.id
        and r.personnel_id::text = auth.uid()::text
    )
  );

drop policy if exists "service role full air_notifications" on public.air_notifications;
create policy "service role full air_notifications"
  on public.air_notifications for all to service_role using (true) with check (true);

-- notification_recipients: admin all; staff read own rows.
drop policy if exists "admins full notification_recipients" on public.notification_recipients;
create policy "admins full notification_recipients"
  on public.notification_recipients for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

drop policy if exists "staff read own recipients" on public.notification_recipients;
create policy "staff read own recipients"
  on public.notification_recipients for select to authenticated
  using (personnel_id::text = auth.uid()::text);

drop policy if exists "service role full notification_recipients" on public.notification_recipients;
create policy "service role full notification_recipients"
  on public.notification_recipients for all to service_role using (true) with check (true);

-- sms_logs: admin all; staff read entries for themselves.
drop policy if exists "admins full sms_logs" on public.sms_logs;
create policy "admins full sms_logs"
  on public.sms_logs for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

drop policy if exists "staff read own sms_logs" on public.sms_logs;
create policy "staff read own sms_logs"
  on public.sms_logs for select to authenticated
  using (personnel_id::text = auth.uid()::text);

drop policy if exists "service role full sms_logs" on public.sms_logs;
create policy "service role full sms_logs"
  on public.sms_logs for all to service_role using (true) with check (true);

-- notification_actions: admin all; staff read addressed notifications' actions.
drop policy if exists "admins full notification_actions" on public.notification_actions;
create policy "admins full notification_actions"
  on public.notification_actions for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

drop policy if exists "staff read addressed actions" on public.notification_actions;
create policy "staff read addressed actions"
  on public.notification_actions for select to authenticated
  using (
    exists (
      select 1 from public.notification_recipients r
      where r.notification_id = public.notification_actions.notification_id
        and r.personnel_id::text = auth.uid()::text
    )
  );

drop policy if exists "service role full notification_actions" on public.notification_actions;
create policy "service role full notification_actions"
  on public.notification_actions for all to service_role using (true) with check (true);

-- notification_reads: each user manages only their own rows.
drop policy if exists "users manage own reads" on public.notification_reads;
create policy "users manage own reads"
  on public.notification_reads for all to authenticated
  using (user_id::text = auth.uid()::text)
  with check (user_id::text = auth.uid()::text);

drop policy if exists "service role full notification_reads" on public.notification_reads;
create policy "service role full notification_reads"
  on public.notification_reads for all to service_role using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 7. Realtime publication (bell badge + timeline update live).
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='air_notifications') then
    alter publication supabase_realtime add table public.air_notifications;
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='notification_actions') then
    alter publication supabase_realtime add table public.notification_actions;
  end if;
exception when others then
  raise notice 'Could not add air notification tables to realtime publication: %', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 8. Optional pg_cron offline sweep (skipped safely when unavailable).
--    Requires the pg_cron extension. Runs the check-offline Edge Function
--    every 30s. If pg_cron is not enabled, call the function on a schedule
--    from Supabase Dashboard (Edge Functions > Schedules) instead.
-- ---------------------------------------------------------------------------
-- do $$
-- begin
--   if exists (select 1 from pg_extension where extname = 'pg_cron') then
--     delete from cron.job where jobname = 'air-check-offline';
--     perform cron.schedule(
--       'air-check-offline',
--       '*/30 * * * * *',
--       $$ select net.http_post(
--         url := current_setting('app.settings.supabase_url', true) || '/functions/v1/check-offline',
--         headers := jsonb_build_object(
--           'Content-Type', 'application/json',
--           'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
--         )
--       ) $$
--     );
--   end if;
-- exception when others then raise notice 'pg_cron schedule skipped: %', sqlerrm;
-- end $$;

-- ---------------------------------------------------------------------------
-- Verification (optional): should list 5 tables. If this errors with
-- "relation does not exist", the create above did not run — re-run the file.
-- ---------------------------------------------------------------------------
select tablename from pg_tables
where schemaname = 'public'
  and tablename in ('air_notifications','notification_recipients','sms_logs','notification_actions','notification_reads')
order by tablename;
