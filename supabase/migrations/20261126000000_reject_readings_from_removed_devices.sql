-- Migration: reject readings inserted from removed (inactive) devices.
--
-- The readings table has no FK constraint linking device_id to devices.active,
-- and the RLS insert policy is `with check (true)`, so a removed ESP32 can
-- still POST readings that are stored in the database and picked up by the
-- readings_air_alerts_webhook trigger (which fires the air-alerts edge function
-- on every INSERT). This migration adds a BEFORE INSERT guard that raises an
-- exception when the source device has active = false, so removed devices can
-- no longer submit accepted readings or trigger new alerts.
--
-- Historical readings already in the table are untouched (requirement 4).
-- The guard only affects NEW inserts after this migration is applied.

create or replace function public.reject_readings_from_removed_devices()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.devices
    where device_id = new.device_id
      and active = false
  ) then
    raise exception 'Device % is removed and cannot submit readings', new.device_id;
  end if;
  return new;
end;
$$;

drop trigger if exists readings_reject_removed_devices on public.readings;
create trigger readings_reject_removed_devices
  before insert on public.readings
  for each row
  execute function public.reject_readings_from_removed_devices();

notify pgrst, 'reload schema';
