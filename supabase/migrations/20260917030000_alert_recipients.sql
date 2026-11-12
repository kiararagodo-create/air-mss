-- Migration: create alert_recipients table
--
-- Role-based SMS alert recipients.
-- role: admin | maintenance | security
-- room_ids: which rooms this person covers. NULL means all rooms.
-- Active recipients receive alerts; inactive ones are ignored.
-- RLS: only admins can manage (insert/update/delete).

create table if not exists public.alert_recipients (
  id bigserial primary key,
  name text not null,
  phone_number text not null,
  role text not null check (role in ('admin', 'maintenance', 'security')),
  active boolean not null default true,
  room_ids uuid[] null,
  created_at timestamptz not null default now()
);

-- Index for role-based queries
create index if not exists alert_recipients_role_idx on public.alert_recipients (role);
create index if not exists alert_recipients_active_idx on public.alert_recipients (active);

-- RLS: public read (for function lookups), admin-only write
drop policy if exists "authenticated can read alert_recipients" on public.alert_recipients;
create policy "authenticated can read alert_recipients"
  on public.alert_recipients
  for select
  to authenticated
  using (public.is_approved_account());

drop policy if exists "admins can manage alert_recipients" on public.alert_recipients;
create policy "admins can manage alert_recipients"
  on public.alert_recipients
  for all
  to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());