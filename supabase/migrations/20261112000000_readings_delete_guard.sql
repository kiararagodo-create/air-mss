create table if not exists public.retention_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into public.retention_config (key, value, updated_at)
values
  ('readings_delete_enabled', 'false', now()),
  ('retention_days', '365', now())
on conflict (key) do update
set value = excluded.value,
    updated_at = excluded.updated_at;

create or replace function public.readings_deletion_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select lower(value) in ('true', 't', '1', 'yes', 'on')
      from public.retention_config
      where key = 'readings_delete_enabled'
    ),
    false
  );
$$;

create or replace function public.readings_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.readings_deletion_enabled() then
    raise exception
      'READINGS DELETE DISABLED: set retention_config.readings_delete_enabled = true to allow deleting public.readings';
  end if;

  return null;
end;
$$;

drop trigger if exists readings_guard_delete on public.readings;
create trigger readings_guard_delete
  before delete on public.readings
  for each statement
  execute function public.readings_guard_delete();

drop trigger if exists readings_guard_truncate on public.readings;
create trigger readings_guard_truncate
  before truncate on public.readings
  for each statement
  execute function public.readings_guard_delete();

create or replace function public.cleanup_old_readings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer;
  v_cutoff timestamptz;
  v_deleted integer;
begin
  if not public.readings_deletion_enabled() then
    raise notice 'cleanup_old_readings skipped: retention_config.readings_delete_enabled is false';
    return 0;
  end if;

  select greatest(
    coalesce(
      (select value::integer from public.retention_config where key = 'retention_days'),
      365
    ),
    365
  )
  into v_days;

  v_cutoff := now() - make_interval(days => v_days);

  delete from public.readings where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;

  return v_deleted;
end;
$$;

revoke all on function public.cleanup_old_readings() from public, anon, authenticated;
grant execute on function public.cleanup_old_readings() to service_role;

do $$
declare
  r record;
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; no cron jobs to unschedule';
    return;
  end if;

  for r in
    select jobid, jobname
    from cron.job
    where jobname in (
      'cleanup-old-readings',
      'weekly-sensor-report-archive',
      'daily-sensor-report-archive'
    )
    or command ilike '%cleanup_old_readings%'
    or command ilike '%delete_readings_for_archived_month%'
    or command ilike '%delete_archived_readings%'
  loop
    perform cron.unschedule(r.jobid);
    raise notice 'Unscheduled readings-deletion cron job % (%)', r.jobname, r.jobid;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
