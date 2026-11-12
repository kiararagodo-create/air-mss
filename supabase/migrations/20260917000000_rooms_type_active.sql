-- Migration: add type and active columns to rooms table
--
-- The rooms table already exists (created outside this repo). This migration
-- adds two new columns so rooms can be classified and toggled on/off.

-- Add room type (e.g. classroom, kitchen, lab, offices, storage)
alter table public.rooms
  add column if not exists type text;

-- Active flag: true when the room/device is currently monitored
alter table public.rooms
  add column if not exists active boolean not null default true;

-- Update RLS: authenticated (approved) users can read; admins can write
drop policy if exists "authenticated can read rooms" on public.rooms;
create policy "authenticated can read rooms"
  on public.rooms
  for select
  to authenticated
  using (public.is_approved_account());

drop policy if exists "admins can insert rooms" on public.rooms;
create policy "admins can insert rooms"
  on public.rooms
  for insert
  to authenticated
  with check (public.is_active_admin());

drop policy if exists "admins can update rooms" on public.rooms;
create policy "admins can update rooms"
  on public.rooms
  for update
  to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

drop policy if exists "admins can delete rooms" on public.rooms;
create policy "admins can delete rooms"
  on public.rooms
  for delete
  to authenticated
  using (public.is_active_admin());