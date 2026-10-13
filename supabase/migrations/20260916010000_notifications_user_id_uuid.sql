-- Migration: converge public.notifications.user_id on uuid.
--
-- Why: 20260911010000 declares notifications.user_id as uuid, but that
-- migration used `create table if not exists`, so on any project where the
-- table already existed the declaration was a no-op and the live column stayed
-- `text`. There is no ALTER anywhere to change it, so the deployed schema and
-- the declared schema disagree.
--
-- The disagreement is what made the notification bell silently empty: the RLS
-- policies compared auth.uid() (uuid) against a text column and raised
-- `operator does not exist: uuid = text` on every read. The policies are now
-- written as `user_id::text = auth.uid()::text`, which is correct for both
-- types, but leaving the column as text keeps the uuid = text trap alive for
-- the next query someone writes against this table.
--
-- uuid is the correct end state: profiles.id is uuid, auth.users.id is uuid,
-- and every writer (self-register, manage-account-approval, run-monthly-archive)
-- passes a raw uuid value - none of them stringifies user_id.
--
-- Safe to run more than once, and safe on a fresh install where the column is
-- already uuid (it returns immediately). Skips with a warning if the table is
-- absent. Raises a named error rather than an opaque 22P02 if any stored value
-- is not a parseable uuid.

do $$
declare
  v_col_type      text;
  v_fk            text;
  v_bad           bigint;
  v_profiles_type text;
begin
  if to_regclass('public.notifications') is null then
    raise warning 'public.notifications does not exist - skipped';
    return;
  end if;

  select data_type into v_col_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'notifications'
     and column_name  = 'user_id';

  if v_col_type is distinct from 'text' then
    raise notice 'notifications.user_id is already % - no conversion needed', v_col_type;
    return;
  end if;

  -- Pre-flight the values. Without this the ALTER fails with a bare
  -- "invalid input syntax for type uuid" and the whole paste batch rolls back.
  select count(*) into v_bad
    from public.notifications
   where user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  if v_bad > 0 then
    raise exception
      'notifications.user_id: % row(s) are not valid uuid. Repair or delete them, then re-run.',
      v_bad;
  end if;

  -- Drop the FK first: the column type cannot change under a foreign key.
  select conname into v_fk
    from pg_constraint
   where conrelid = 'public.notifications'::regclass
     and contype  = 'f'
     and pg_get_constraintdef(oid) ~ 'FOREIGN KEY \(user_id\)'
   limit 1;

  if v_fk is not null then
    execute format('alter table public.notifications drop constraint %I', v_fk);
  end if;

  alter table public.notifications
    alter column user_id type uuid using user_id::uuid;

  -- Only re-add the FK when the referenced column is really uuid; otherwise
  -- this would recreate the incompatible-key-types error the column type
  -- change just fixed.
  select data_type into v_profiles_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'profiles'
     and column_name  = 'id';

  if v_profiles_type = 'uuid' then
    alter table public.notifications
      add constraint notifications_user_id_fkey
      foreign key (user_id) references public.profiles (id) on delete cascade;
  else
    raise warning
      'profiles.id is %, so the notifications -> profiles FK was not re-created', v_profiles_type;
  end if;

  raise notice 'notifications.user_id converted text -> uuid';
end $$;
