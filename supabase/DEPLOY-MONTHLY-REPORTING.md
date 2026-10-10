# Reporting Deployment Guide

Covers the calendar-month reporting layer, its yearly archive, and the calendar
of daily summaries.

Replaces the 7-day / weekly retention scheme with calendar-month reporting,
server-generated PDFs, a calendar of daily summaries, and a per-year archive of
twelve monthly reports.

Everything here is written against project ref `zxoeqazpatujesgotswd`
(`air-project`). Adjust the URL if you use a different project.

---

## 0a. Yearly archive (added after the monthly layer)

Everything in this document applies unchanged. The annual layer adds:

| Area | File |
|---|---|
| `annual_reports` table, `annual_report_bundle()`, `month_activity_index()` | `supabase/migrations/20260913000000_annual_reporting.sql` |
| Annual summary PDF generator | `supabase/functions/annual-report/index.ts` |
| Year archive UI | `src/components/AnnualReportsPanel.tsx` |
| ZIP writer | `src/lib/zip.ts` |
| Shared annual analysis + `monthBars()` chart | `supabase/functions/_shared/reporting.ts` |

Deploy it like everything else (`db push`, then `functions deploy annual-report`).
It depends on the monthly migration only for the `monthly-reports` bucket and
the `daily_summaries` table, so apply the migrations in filename order.

```bash
npx supabase db push
npx supabase functions deploy annual-report --no-verify-jwt
```

`--no-verify-jwt` is required because the function also accepts the cron bearer
token so the yearly summary can be generated without anyone opening the app.
Browser-originated calls still go through the user-JWT + approved-admin check.

The annual cron job (`annual-report-summary`, 02:40 UTC on 1 January) is
created by the migration, same as the monthly jobs.

### Long-term retention

| Artefact | Retained forever | Deleted by retention? |
|---|---|---|
| `readings` (raw rows) | no | **yes** — the only table removed from |
| `monthly_reports` (+ `pdf_paths`, `csv_path`) | yes | no |
| `annual_reports` (+ `pdf_path`) | yes | no |
| `daily_summaries` | yes | no |
| `graph_buckets` | yes | no |
| `threshold_history` | yes | no |

`public.readings` is the only table any DELETE touches, and only inside
`delete_readings_for_archived_month()`. Because the annual summary is computed
from `daily_summaries` rather than `readings`, a 2024 annual report can still be
generated in 2027 after that year's raw rows are gone.

### ZIP behaviour

**No new dependency.** `src/lib/zip.ts` is a ~180-line STORE-method ZIP writer.
PDFs are already DEFLATE-compressed, so re-compressing them saves almost
nothing, and STORE lets the archive stream one file at a time instead of holding
a whole year in memory.

- `MAX_ZIP_FILES = 400` and `MAX_ZIP_BYTES = 500 MB`. If a year exceeds either,
  the button is disabled with a message pointing at per-month download. It never
  silently produces a partial archive.
- CRC32 is verified against the standard check vectors, and the generated
  archive was extracted with Windows `Expand-Archive` with all entries
  byte-for-byte intact.

---

## 1. What changed, and what still needs deploying

### Completed in the repo (code written and verified locally)

| Area | File | Status |
|---|---|---|
| Core tables + RLS + storage | `supabase/migrations/20260912000000_monthly_reporting_core.sql` | written, parses |
| Helper functions + retention delete | `supabase/migrations/20260912010000_monthly_reporting_functions.sql` | written, parses |
| Cron + grants + legacy disable | `supabase/migrations/20260912020000_monthly_reporting_cron.sql` | written, parses |
| Shared report library | `supabase/functions/_shared/reporting.ts` | written, `deno check` clean, PDF smoke-tested |
| Scheduled archive job | `supabase/functions/run-monthly-archive/index.ts` | written, `deno check` clean |
| On-demand daily PDF | `supabase/functions/daily-report/index.ts` | written, `deno check` clean |
| Manila calendar utilities | `src/lib/reports.ts` | written, 44 assertions pass |
| Calendar | `src/components/ReportCalendar.tsx` | written |
| Daily panel | `src/components/DailyReportPanel.tsx` | written |
| Monthly panel | `src/components/MonthlyReportsPanel.tsx` | written |
| Chart | `src/components/ReportChart.tsx` | written |
| Notification bell | `src/components/NotificationBell.tsx` | written |
| Reports page | `src/pages/admin/ReportsPage.tsx` | rewritten, existing features preserved |
| Threshold history write | `src/context/RoomsContext.tsx` | written |
| Register page (build was broken) | `src/pages/RegisterPage.tsx` | written |
| Restored personnel function | `supabase/functions/admin-create-personnel/index.ts` | written from stray `src/index.ts` |

### NOT YET DEPLOYED

Nothing in the table above is live. The three migrations have never been
applied, the two new Edge Functions have never been deployed, and the frontend
has never been rebuilt. Follow the steps below in order.

---

## 2. Apply the migrations

```bash
npx supabase link --project-ref zxoeqazpatujesgotswd
npx supabase db push
```

This creates `threshold_history`, `daily_summaries`, `graph_buckets`,
`monthly_reports`, the private `monthly-reports` bucket, all helper functions,
and adds indexes on `readings`.

It also:

- **unschedules** `weekly-sensor-report-archive` and `daily-sensor-report-archive`
- **replaces** `delete_archived_readings()` with a tombstone that always raises,
  so no stale deployment can still delete readings 7 days in
- **drops** the unused `archive_completed_reports()`

The new cron jobs are **not** scheduled yet, because the cron secret is not set.
The migration prints a `NOTICE` telling you the next command to run.

---

## 3. Set the cron secret

The old secret (`my-secret-123`) was committed in plaintext in a migration.
It is now a single row you can rotate.

```bash
# 1. Generate a strong secret (keep it somewhere safe)
#    PowerShell:
$secret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})

# 2. Store it in the database
#    Run this in the Supabase SQL editor:
#    select set_reporting_cron_secret('<paste the secret>');
#    select set_reporting_project_url('https://zxoeqazpatujesgotswd.supabase.co');

# 3. Match it on the Edge Function
npx supabase secrets set CRON_SECRET=<paste the same secret>
```

Optional tuning:

```bash
# Rows per appendix PDF part. Default 4000 (~864k rows per device-month at a
# 3s cadence => roughly 216 parts). Raise for fewer, larger files.
npx supabase secrets set APPENDIX_ROWS_PER_PART=4000
```

Then schedule the jobs (SQL editor):

```sql
select cron.unschedule(jobid) from cron.job
 where jobname in ('daily-sensor-report-aggregate','monthly-sensor-report-archive');
-- then simply re-run the 20260912020000 migration, which reschedules
```

Verify:

```sql
select jobname, schedule, command from cron.job order by jobid;
```

Expected: `daily-sensor-report-aggregate` at `10 2 * * *`,
`monthly-sensor-report-archive` at `20 2 1 * *`, and
`annual-report-summary` at `40 2 1 1 *`.

> These are **UTC**. 02:10 UTC = 10:10 Asia/Manila. The jobs compute "which
> period is complete" from Manila calendar dates, so they are correct regardless
> of when in the day they fire.

---

## 4. Deploy the Edge Functions

```bash
npx supabase functions deploy run-monthly-archive --no-verify-jwt
npx supabase functions deploy daily-report
npx supabase functions deploy annual-report --no-verify-jwt
```

`run-monthly-archive` and `annual-report` use `--no-verify-jwt` because they
also authenticate with a static cron bearer token rather than a user JWT.

`daily-report` keeps JWT verification **on** and additionally validates the
caller is an approved admin server-side.

Confirm the required secrets exist:

```bash
npx supabase secrets list
```

You need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Supabase provides
these automatically), plus `CRON_SECRET` which you just set. Privileged keys
stay server-side and are never exposed to the browser.

---

## 5. Deploy the frontend

```bash
npm run build
```

Netlify picks this up on push (`netlify.toml` runs `npm run build`, publishes
`dist`).

---

## 6. Backfill existing history (recommended)

Data that predates this change has no `daily_summaries` or `graph_buckets`
rows. The calendar will show those dates as empty, and archiving an old month
will still work (the archive refreshes aggregates itself first), but backfilling
makes the calendar useful immediately.

Run in the SQL editor, month by month, for the months you care about:

```sql
-- Adjust the dates. This scans one month at a time; do not run the whole
-- history in one statement on a large dataset.
select refresh_daily_summaries('2026-06-01', '2026-06-30');
select refresh_graph_buckets('2026-06-01', '2026-06-30', 3600);
```

Or let the archive job do it — trigger a run by hand:

```bash
curl -X POST \
  https://zxoeqazpatujesgotswd.supabase.co/functions/v1/run-monthly-archive \
  -H "Authorization: Bearer $secret" \
  -H "Content-Type: application/json" \
  -d '{"mode":"daily"}'
```

---

## 7. Verify after deploying

```sql
-- a. No job still points at the old 7-day function
select jobname, command from cron.job;

-- b. No old-style 7-day function can still delete anything
select delete_archived_readings('x', now(), now());
-- expected: ERROR ... retired by the monthly retention migration

-- c. Retention refuses when the archive is not verified
select delete_readings_for_archived_month('AIR-106', '2026-01-01');
-- expected: ERROR RETENTION BLOCKED ... (no archive row / not succeeded)

-- d. Retention refuses a month that is not yet a full month old
select delete_readings_for_archived_month('AIR-106', date_trunc('month', now())::date);
-- expected: ERROR RETENTION BLOCKED ... not yet one full calendar month old

-- e. Reporting tables exist and are admin-readable
select count(*) from daily_summaries;
select count(*) from monthly_reports;
select month_start, part_count, verified, readings_deleted from monthly_reports
 order by month_start desc limit 10;
```

Then in the app: open Reports, pick a past date, check the calendar highlights
it, and press **Download Daily PDF**.

---

## 8. How retention actually behaves

Raw readings are deleted **only** when all of these hold, enforced inside
`delete_readings_for_archived_month()`:

1. a `monthly_reports` row exists for that device-month
2. `generation_status = 'succeeded'`
3. `verified = true` (every PDF part and the CSV were re-read from Storage)
4. the month has fully elapsed in Manila time
5. **every** reading in the month is at least one full calendar month old
6. `daily_summaries` rows already exist for the month

Rule 5 is per-reading, not per-month. A month's readings are only eligible from
the 1st of the month **after next**, because the youngest reading in the month
falls on that month's last day at 23:59 Manila. Deleting on the 1st of the
following month would remove readings that were hours old.

In practice the database always holds the current partial month plus the
complete previous one — between one and two months of raw readings at any
instant.

If any check fails the function **raises and deletes nothing**. The archive job
catches the exception, records it, and the next daily run retries the same month
without producing a duplicate report.

---

## 9. Duplicate-report protection

`monthly_reports` has `unique (device_id, month_start)`.

`claim_monthly_report()` is a single atomic claim. It returns `false` when
another run already owns that device-month (including a run still in flight
within the last 30 minutes), and the caller skips it. Combined with
`monthly_report_candidates()` only returning months with no succeeded report,
there is no path that produces two reports for the same device-month.

---

## 10. Failure behaviour

| Failure | Result |
|---|---|
| PDF build throws | `fail_monthly_report()`, raw readings untouched, retried next day |
| Upload fails | same — nothing is marked verified, so no deletion |
| Storage verification fails | same — `verified` stays false, deletion refused |
| Delete refused | report still exists and downloads fine; readings retained, logged |
| Job missed entirely | daily schedule re-queues every overdue month next run |
| Cron secret missing | `401`, no data touched |

---

## 11. Access control

Reports remain **admin-only**, unchanged from before:

- `App.tsx` keeps `RoleRoute allow={["admin"]}` on `/reports`
- RLS on `monthly_reports`, `daily_summaries`, `graph_buckets`,
  `threshold_history` and the `monthly-reports` bucket requires
  `profiles.role = 'admin' AND account_status = 'approved'`
- `daily-report` re-checks the caller's role server-side before generating
  anything, so the browser guard is not the only control

Note this is a tightening: the old `sensor-reports` storage policy let *any*
authenticated user read every report PDF. Legacy weekly PDFs are still listed
and downloadable by admins.

All `EXECUTE` privileges on reporting functions are revoked from `public`,
`anon` and `authenticated` first, then re-granted. Only the read-only helpers
are reachable from the browser; archiving and retention are `service_role` only.

---

## 12. Local verification scripts

```bash
node scripts/verify-calendar.mjs   # 44 assertions: TZ, month boundaries, retention rule
node --experimental-strip-types scripts/verify-no-fabricated-data.ts  # 56 assertions: no mock data, no null->0 coercion
node scripts/verify-sql.mjs        # parses every migration with the real PG grammar
node --experimental-strip-types scripts/verify-zip.ts   # 12 assertions: CRC32 + ZIP structure
deno run --allow-env --allow-net scripts/verify-pdf.ts        # renders a real multi-page PDF
deno run --allow-env --allow-net scripts/verify-analysis.ts  # 32 assertions: narrative honesty
deno run --allow-env --allow-net scripts/verify-annual.ts    # 27 assertions: annual narrative + PDF
deno check supabase/functions/_shared/reporting.ts \
         supabase/functions/run-monthly-archive/index.ts \
         supabase/functions/daily-report/index.ts \
         supabase/functions/annual-report/index.ts
```

`verify-sql.mjs` needs `libpg-query` (`npm install --no-save libpg-query`).
None of these are dependencies of the app.

---

## 13. Things to be aware of

- **Report volume.** At a 3-second cadence one device-month is roughly 864,000
  readings, so the appendix splits into many numbered parts and the CSV is tens
  of MB. `APPENDIX_ROWS_PER_PART` controls the split; the `monthly-reports`
  bucket has a 250 MB per-object ceiling.
- **Memory.** The CSV is assembled in the function before upload. If a
  device-month grows past a few million rows, switch the CSV to numbered parts
  as well.
- **Historical thresholds.** `threshold_history` only exists from deployment
  onward. Reports for earlier periods are explicitly labelled as evaluated
  against the *current* thresholds, and say so in the PDF.
- **Temperature and humidity warning tiers.** The Settings page only exposes
  CO2 and LPG tiers, so temp/humidity have no intermediate warning band and
  only danger counts are reported for them. This matches the existing app model.
- **`severity`** is the firmware's own classification. It is shown as recorded,
  and left blank when the firmware wrote nothing rather than being inferred.