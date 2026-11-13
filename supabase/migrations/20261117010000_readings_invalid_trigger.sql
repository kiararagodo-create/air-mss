-- Flag obvious sensor faults on insert (additive; does not block ingestion).
-- Alerts/SMS logic in edge functions still validates and will not send from invalid readings.

alter table public.readings
  add column if not exists is_invalid boolean;

create or replace function public.mark_readings_invalid()
returns trigger
language plpgsql
as $$
declare
  all_zero boolean;
  bad boolean := false;
begin
  all_zero := coalesce(new.co2, 0) = 0 and coalesce(new.lpg, 0) = 0 and coalesce(new.temp, 0) = 0 and coalesce(new.humidity, 0) = 0;

  if new.co2 is null or new.lpg is null or new.temp is null or new.humidity is null then
    bad := true;
  end if;
  if all_zero then bad := true; end if;

  if new.co2 is not null and (new.co2 <> new.co2 or new.co2 < 0 or new.co2 > 10000) then bad := true; end if;
  if new.lpg is not null and (new.lpg <> new.lpg or new.lpg < 0 or new.lpg > 10000) then bad := true; end if;
  if new.temp is not null and (new.temp <> new.temp or new.temp < -40 or new.temp > 80) then bad := true; end if;
  if new.humidity is not null and (new.humidity <> new.humidity or new.humidity < 0 or new.humidity > 100) then bad := true; end if;
  if new.temp is not null and new.humidity is not null and new.temp = 0 and new.humidity = 0 then bad := true; end if;

  new.is_invalid := coalesce(new.is_invalid, false) or bad;
  return new;
end;
$$;

drop trigger if exists readings_mark_invalid_before_insert on public.readings;
create trigger readings_mark_invalid_before_insert
before insert on public.readings
for each row
execute function public.mark_readings_invalid();

notify pgrst, 'reload schema';
