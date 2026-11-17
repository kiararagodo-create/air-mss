-- Migration: add ventilation configuration columns to public.rooms
-- Idempotent: safe to run multiple times.
-- Notify pgrst to reload schema after running.

begin;

-- ---------------------------------------------------------------------------
-- ventilation_type: type of ventilation (required, with CHECK)
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rooms' and column_name = 'ventilation_type') then
        alter table public.rooms add column ventilation_type text not null default 'unknown';
    end if;
end
$$;

drop policy if exists "rooms ventilation_type check" on public.rooms;
create policy "rooms ventilation_type check" on public.rooms for all to authenticated using ((ventilation_type = any (array['window_ac'::text, 'split_ac'::text, 'central_ac_outdoor_air'::text, 'natural'::text, 'mechanical'::text, 'unknown'::text])));

-- ---------------------------------------------------------------------------
-- ventilation_ach: outdoor air changes per hour (optional, constrained)
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rooms' and column_name = 'ventilation_ach') then
        alter table public.rooms add column ventilation_ach numeric;
    end if;
end
$$;

drop policy if exists "rooms ventilation_ach check" on public.rooms;
create policy "rooms ventilation_ach check" on public.rooms for all to authenticated using (ventilation_ach is null or (ventilation_ach >= 0 and ventilation_ach <= 60));

-- ---------------------------------------------------------------------------
-- occupancy_duration_h: duration in hours for CO2 estimation (required)
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rooms' and column_name = 'occupancy_duration_h') then
        alter table public.rooms add column occupancy_duration_h numeric not null default 2;
    end if;
end
$$;

drop policy if exists "rooms occupancy_duration_h check" on public.rooms;
create policy "rooms occupancy_duration_h check" on public.rooms for all to authenticated using (occupancy_duration_h > 0 and occupancy_duration_h <= 12);

-- Update existing rows with defaults (idempotent)
update public.rooms
set
    ventilation_type = coalesce(ventilation_type, 'unknown'),
    ventilation_ach = coalesce(ventilation_ach, null::numeric),
    occupancy_duration_h = coalesce(occupancy_duration_h, 2);

-- Idempotent insert if row missing (for seed/initial setups)
insert into public.rooms (id, ventilation_type, ventilation_ach, occupancy_duration_h, active, removed_at)
values (gen_random_uuid(), 'unknown', null, 2, true, null)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
commit;

-- Rollback (manually run if needed):
-- drop policy if exists "rooms ventilation_type check" on public.rooms;
-- drop policy if exists "rooms ventilation_ach check" on public.rooms;
-- drop policy if exists "rooms occupancy_duration_h check" on public.rooms;
-- alter table public.rooms drop column if exists ventilation_type;
-- alter table public.rooms drop column if exists ventilation_ach;
-- alter table public.rooms drop column if exists occupancy_duration_h;