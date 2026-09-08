-- Change cron from weekly (Monday) to daily at 00:10 Manila time
select cron.unschedule('weekly-sensor-report-archive');
select cron.schedule('daily-sensor-report-archive', '10 0 * * *', $$
  select net.http_post(
    url=>'https://zxoeqazpatujesgotswd.supabase.co/functions/v1/run-weekly-archive',
    headers=>'{"Content-Type":"application/json","Authorization":"Bearer my-secret-123"}',
    body=>'{}'
  );
$$);
