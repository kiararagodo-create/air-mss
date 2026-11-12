-- Migration: one query for the newest reading per device.
--
-- The dashboard previously fetched the latest row for each device with one
-- `order by created_at desc limit 1` query PER DEVICE on every poll. That is
-- bounded but still N round trips. This view collapses it to a single query:
--
--   select * from public.device_latest_reading where device_id in (...)
--
-- backed by the (device_id, created_at desc) index so Postgres walks the index
-- backwards once per device instead of sorting the table. There is no unbounded
-- scan anywhere in the dashboard's live path.
--
-- security_invoker = true (PostgreSQL 15+) makes the view run with the caller's
-- privileges, so the "authenticated can read readings" row-level security policy
-- still applies to every row it returns. Without it the view would be owned by
-- its creator and would hand any signed-in user the whole readings table.
--
-- If this migration has not been applied yet the client falls back to the
-- per-device limit(1) query, so the dashboard keeps working either way.

create index if not exists readings_device_created_desc_idx
  on public.readings (device_id, created_at desc);

drop view if exists public.device_latest_reading;

create view public.device_latest_reading
with (security_invoker = true) as
select distinct on (device_id)
       device_id,
       co2,
       lpg,
       temp,
       humidity,
       severity,
       status,
       created_at
from public.readings
order by device_id, created_at desc;

grant select on public.device_latest_reading to authenticated;

comment on view public.device_latest_reading is
  'Newest reading per device_id, used by the dashboard for live values and the online/offline indicator.';

notify pgrst, 'reload schema';
