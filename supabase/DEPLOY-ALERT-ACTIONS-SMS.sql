-- Migration: alert personnel actions (visible to everyone) + manual SMS.
--
-- Fixes/gaps this closes vs 20260918000000_air_notifications.sql:
--   1. air_notifications.handled_by_id did not exist (only name/role/at).
--   2. notification_actions.action check had no 'sms_sent' / 'repaired'.
--   3. RLS let staff read only addressed alerts and staff-update only
--      addressed rows, so an in-app action by an unaddressed Maintenance /
--      Security user was rejected. Reads are now visible to every approved
--      user (need: handled-by lines, Action Log); writes still go through
--      the record-action Edge Function (service role), never direct client
--      inserts, so widening SELECT does not widen write access.
--   4. sms_logs was not in the realtime publication, so the SMS Log tab did
--      not refresh live after a manual send.
--
-- Idempotent: safe to re-run. Run in Supabase SQL Editor, or `supabase db push`.

-- is_approved_account() lives in 20260916000000_production_hardening.sql;
-- re-declare defensively so this file applies standalone.
create or replace function public.is_approved_account()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id::text = auth.uid()::text
      and p.account_status = 'approved' and p.is_active
  );
$$;
revoke all on function public.is_approved_account() from public, anon;
grant execute on function public.is_approved_account() to authenticated;

-- ---------------------------------------------------------------------------
-- 1. handled_by_id
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'air_notifications'
      and column_name = 'handled_by_id'
  ) then
    alter table public.air_notifications
      add column handled_by_id uuid references public.profiles(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Action check: add sms_sent + repaired
-- ---------------------------------------------------------------------------
alter table public.notification_actions
  drop constraint if exists notification_actions_action_check;
alter table public.notification_actions
  add constraint notification_actions_action_check
  check (action in ('acknowledge','on_my_way','resolved','false_alarm','repaired','sms_sent'));

-- ---------------------------------------------------------------------------
-- 3. Realtime: sms_logs (SMS Log tab + resend refresh live)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sms_logs'
     ) then
    alter publication supabase_realtime add table public.sms_logs;
  end if;
exception when others then
  raise notice 'Could not add sms_logs to realtime publication: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Everyone (approved) can READ alerts + actions (handled-by, Action Log).
--    Writes remain service-role only via record-action / send-sms functions.
-- ---------------------------------------------------------------------------
drop policy if exists "approved read air_notifications" on public.air_notifications;
create policy "approved read air_notifications"
  on public.air_notifications for select to authenticated
  using (public.is_approved_account());

drop policy if exists "approved read notification_actions" on public.notification_actions;
create policy "approved read notification_actions"
  on public.notification_actions for select to authenticated
  using (public.is_approved_account());

-- Admins may also read the full SMS log (manual sends by Security included).
drop policy if exists "admins full sms_logs" on public.sms_logs;
create policy "admins full sms_logs"
  on public.sms_logs for all to authenticated
  using (public.is_active_admin()) with check (public.is_active_admin());

-- Security (manual SMS sender) may read sms_logs rows needed for resend UI:
-- rows whose recipient is themselves or that they sent is not tracked, so
-- allow approved Security to read sms_logs (no write policy = read-only).
drop policy if exists "security read sms_logs" on public.sms_logs;
create policy "security read sms_logs"
  on public.sms_logs for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id::text = auth.uid()::text and p.role = 'security'
      and p.account_status = 'approved' and p.is_active
  ));

notify pgrst, 'reload schema';

-- Verification: should list handled_by_id + 2 new action values in check.
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'air_notifications'
  and column_name = 'handled_by_id';
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.notification_actions'::regclass and contype = 'c';
