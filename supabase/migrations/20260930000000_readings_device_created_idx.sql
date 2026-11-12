-- Migration: index for fast latest-reading-per-device lookups.
create index if not exists readings_device_created_desc_idx
  on public.readings (device_id, created_at desc);

notify pgrst, 'reload schema';
