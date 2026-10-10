-- Migration: account approval workflow + notifications table.
--
-- Adds:
--   * `profiles.account_status` - pending | approved | rejected | disabled
--   * `profiles.approved_at` / `approved_by` - audit trail for approvals
--   * `notifications` table - in-app messages for users (approval, rejection, etc.)
--
-- New self-registration sets account_status = 'pending'. Pending/rejected
-- accounts are blocked at login (AuthContext.login) and by ProtectedRoute.
-- Admins flip the status from the Personnel Management page.

alter table public.profiles
  add column if not exists account_status text not null default 'pending'
    check (account_status in ('pending', 'approved', 'rejected', 'disabled')),
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text;

-- Backfill existing rows: anyone already active is pre-approved.
update public.profiles
   set account_status = 'approved'
 where is_active = true
   and (account_status is null or account_status = 'pending');

-- Notifications: one-way messages addressed to a specific user.
create table if not exists public.notifications (
  id          bigserial primary key,
  user_id     text        not null references public.profiles (id) on delete cascade,
  kind        text        not null,                 -- 'approved' | 'rejected' | 'disabled' | 'info'
  title       text        not null,
  body        text        not null,
  read        boolean     not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

-- Users can read their own notifications and mark them read.
drop policy if exists "users can read own notifications" on public.notifications;
create policy "users can read own notifications"
  on public.notifications
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users can update own notifications" on public.notifications;
create policy "users can update own notifications"
  on public.notifications
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Only the service role (Edge Functions) writes notifications.
drop policy if exists "service role writes notifications" on public.notifications;
create policy "service role writes notifications"
  on public.notifications
  for all
  to service_role
  using (true)
  with check (true);