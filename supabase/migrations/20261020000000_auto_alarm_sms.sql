-- Migration: automatic alarm SMS + read-only SMS simulation.
--
-- 1. Widen sms_logs.status so every automatic-SMS decision can be logged
--    (quality faults, open-incident dedupe, no recipients, caps, credits).
-- 2. Add public.test_alarm_sms(p_device): simulates a valid danger reading and
--    reports whether it would alert, who would be texted, and which safety rule
--    would skip it. It only reads; it never inserts into public.readings and
--    never calls an SMS provider.

alter table public.sms_logs drop constraint if exists sms_logs_status_check;
alter table public.sms_logs add constraint sms_logs_status_check
  check (status in (
    'submitted',
    'in_progress',
    'failed',
    'invalid_number',
    'skipped_no_number',
    'skipped_dry_run',
    'skipped_low_credits',
    'skipped_rate_limited',
    'skipped_no_recipients',
    'skipped_open_incident',
    'skipped_quality'
  ));

create or replace function public.test_alarm_sms(p_device text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room record;
  v_th jsonb;
  v_co2 numeric := 400;
  v_lpg numeric := 0;
  v_temp numeric := 25;
  v_humidity numeric := 50;
  v_level text := null;
  v_severity text := null;
  v_sensor text := null;
  v_rank int := 0;
  v_tmp_level text;
  v_tmp_sev text;
  v_tmp_rank int;
  v_recipients jsonb := '[]'::jsonb;
  v_open_incident jsonb := null;
  v_settings jsonb := null;
  v_hourly int := 0;
  v_daily int := 0;
  v_skip text := null;
  v_roles text[] := array[]::text[];
  v_quality boolean := true;
begin
  if p_device is null or btrim(p_device) = '' then
    return jsonb_build_object('error', 'p_device is required');
  end if;

  select * into v_room from public.rooms where id = p_device;
  if not found then
    return jsonb_build_object('device_id', p_device, 'error', 'device not found in public.rooms');
  end if;

  v_th := public.resolve_thresholds(null);

  -- Simulate a valid danger reading: CO2 just above the danger threshold.
  v_co2 := coalesce((v_th->>'co2_danger')::numeric, 3500) + 100;
  if v_co2 > 10000 then
    v_co2 := 400;
    v_temp := coalesce((v_th->>'temp_heat_above')::numeric, 35) + 5;
  end if;

  -- Quality filter, mirroring isQualityReading() in _shared/air_alerts.ts.
  if v_temp is null or v_temp < -40 or v_temp > 80 or (v_temp = 0 and v_humidity = 0) then
    v_quality := false;
  end if;
  if v_humidity is null or v_humidity < 0 or v_humidity > 100 then
    v_quality := false;
  end if;
  if v_co2 is null or v_co2 < 0 or v_co2 > 10000 then
    v_quality := false;
  end if;
  if v_lpg is null or v_lpg < 0 or v_lpg > 10000 then
    v_quality := false;
  end if;

  if v_quality then
    -- CO2
    if v_co2 >= coalesce((v_th->>'co2_danger')::numeric, 3500) then
      v_tmp_level := 'Danger'; v_tmp_sev := 'danger'; v_tmp_rank := 3;
    elsif v_co2 >= coalesce((v_th->>'co2_high')::numeric, 2000) then
      v_tmp_level := 'High'; v_tmp_sev := 'high'; v_tmp_rank := 2;
    elsif v_co2 >= coalesce((v_th->>'co2_warning')::numeric, 1000) then
      v_tmp_level := 'Warning'; v_tmp_sev := 'warning'; v_tmp_rank := 1;
    else
      v_tmp_level := null; v_tmp_sev := null; v_tmp_rank := 0;
    end if;
    if v_tmp_rank > v_rank then
      v_rank := v_tmp_rank; v_level := v_tmp_level; v_severity := v_tmp_sev; v_sensor := 'co2';
    end if;

    -- LPG
    if v_lpg >= coalesce((v_th->>'lpg_danger')::numeric, 4200) then
      v_tmp_level := 'Critical'; v_tmp_sev := 'critical'; v_tmp_rank := 4;
    elsif v_lpg >= coalesce((v_th->>'lpg_high')::numeric, 2100) then
      v_tmp_level := 'Alarm'; v_tmp_sev := 'high'; v_tmp_rank := 2;
    elsif v_lpg >= coalesce((v_th->>'lpg_warning')::numeric, 1000) then
      v_tmp_level := 'Low Leak'; v_tmp_sev := 'warning'; v_tmp_rank := 1;
    else
      v_tmp_level := null; v_tmp_sev := null; v_tmp_rank := 0;
    end if;
    if v_tmp_rank > v_rank then
      v_rank := v_tmp_rank; v_level := v_tmp_level; v_severity := v_tmp_sev; v_sensor := 'lpg';
    end if;

    -- Temperature
    if v_temp < coalesce((v_th->>'temp_freeze_below')::numeric, 5) then
      v_tmp_level := 'Freeze'; v_tmp_sev := 'danger'; v_tmp_rank := 3;
    elsif v_temp <= coalesce((v_th->>'temp_cool_below')::numeric, 18) then
      v_tmp_level := 'Cool'; v_tmp_sev := 'warning'; v_tmp_rank := 1;
    elsif v_temp > coalesce((v_th->>'temp_heat_above')::numeric, 35) then
      v_tmp_level := 'Heat'; v_tmp_sev := 'danger'; v_tmp_rank := 3;
    else
      v_tmp_level := null; v_tmp_sev := null; v_tmp_rank := 0;
    end if;
    if v_tmp_rank > v_rank then
      v_rank := v_tmp_rank; v_level := v_tmp_level; v_severity := v_tmp_sev; v_sensor := 'temp';
    end if;

    -- Humidity
    if v_humidity < coalesce((v_th->>'humidity_dry_below')::numeric, 20) then
      v_tmp_level := 'Dry'; v_tmp_sev := 'danger'; v_tmp_rank := 3;
    elsif v_humidity <= coalesce((v_th->>'humidity_low_below')::numeric, 30) then
      v_tmp_level := 'Low'; v_tmp_sev := 'warning'; v_tmp_rank := 1;
    elsif v_humidity > coalesce((v_th->>'humidity_mold_above')::numeric, 80) then
      v_tmp_level := 'Mold Risk'; v_tmp_sev := 'danger'; v_tmp_rank := 3;
    else
      v_tmp_level := null; v_tmp_sev := null; v_tmp_rank := 0;
    end if;
    if v_tmp_rank > v_rank then
      v_rank := v_tmp_rank; v_level := v_tmp_level; v_severity := v_tmp_sev; v_sensor := 'humidity';
    end if;
  end if;

  -- Recipients, mirroring rolesForSeverity() + loadRecipients().
  if v_severity in ('danger', 'critical') then
    v_roles := array['maintenance', 'security', 'admin'];
  elsif v_severity in ('warning', 'high') then
    v_roles := array['maintenance'];
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'role', p.role,
      'phone', p.contact_number,
      'valid_phone', (regexp_replace(p.contact_number, '[^0-9]', '', 'g') ~ '^(09[0-9]{9}|639[0-9]{9}|9[0-9]{9})$')
    ) order by p.role, p.name),
    '[]'::jsonb
  )
  into v_recipients
  from public.profiles p
  where p.is_active
    and p.sms_enabled
    and p.role = any(v_roles);

  select to_jsonb(s) into v_settings
  from public.sms_alert_settings s
  where s.id = 1;

  select to_jsonb(i) into v_open_incident
  from public.air_sms_incidents i
  where i.device_id = p_device and i.status = 'open';

  select count(*) into v_hourly
  from public.sms_logs
  where status = 'submitted' and sent_at >= now() - interval '1 hour';

  select count(*) into v_daily
  from public.sms_logs
  where status = 'submitted' and sent_at >= now() - interval '24 hours';

  if not v_quality then
    v_skip := 'skipped_quality';
  elsif coalesce((v_settings->>'automatic_sms')::boolean, true) = false then
    v_skip := 'automatic_sms disabled';
  elsif jsonb_array_length(v_recipients) = 0 then
    v_skip := 'skipped_no_recipients';
  elsif v_open_incident is not null then
    if v_rank > case v_open_incident->>'severity'
                 when 'warning' then 1
                 when 'high' then 2
                 when 'danger' then 3
                 when 'critical' then 4
                 else 0
               end then
      v_skip := null;  -- escalation sends
    elsif (v_open_incident->>'reminder_sent_at') is null
      and now() - coalesce(
            (v_open_incident->>'last_sms_at')::timestamptz,
            (v_open_incident->>'started_at')::timestamptz
          ) >= make_interval(mins => coalesce((v_settings->>'reminder_minutes')::int, 60)) then
      v_skip := null;  -- reminder due sends
    else
      v_skip := 'skipped_open_incident';
    end if;
  elsif v_hourly >= coalesce((v_settings->>'max_sms_per_hour')::int, 5)
     or v_daily >= coalesce((v_settings->>'max_sms_per_day')::int, 20) then
    v_skip := 'skipped_rate_limited';
  else
    v_skip := null;
  end if;

  return jsonb_build_object(
    'device_id', p_device,
    'room', v_room.name,
    'simulated_reading', jsonb_build_object('co2', v_co2, 'lpg', v_lpg, 'temp', v_temp, 'humidity', v_humidity),
    'quality_ok', v_quality,
    'would_alert', v_level is not null,
    'sensor', v_sensor,
    'level_label', v_level,
    'severity', v_severity,
    'recipients', v_recipients,
    'open_incident', v_open_incident,
    'automatic_sms', coalesce((v_settings->>'automatic_sms')::boolean, true),
    'hourly_sms', v_hourly,
    'daily_sms', v_daily,
    'max_sms_per_hour', coalesce((v_settings->>'max_sms_per_hour')::int, 5),
    'max_sms_per_day', coalesce((v_settings->>'max_sms_per_day')::int, 20),
    'low_credit_check', 'not available in SQL; the Edge Function checks iProg credits before sending',
    'skip_reason', v_skip,
    'would_send_sms', (v_level is not null and v_skip is null),
    'sms_log_status_if_sent', case when v_level is not null and v_skip is null then 'submitted' else v_skip end
  );
end;
$$;

revoke all on function public.test_alarm_sms(text) from public, anon, authenticated;
grant execute on function public.test_alarm_sms(text) to service_role;

notify pgrst, 'reload schema';
