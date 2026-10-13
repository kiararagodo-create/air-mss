# A.I.R. - Panel Defense Guide

**Audience:** Thesis / Capstone panel
**System:** A.I.R. - IoT Environmental Safety Monitoring Dashboard
**Stack:** ESP32 firmware -> React + TypeScript -> Supabase (PostgreSQL, RLS, Realtime, Edge Functions)

> Written in plain ASCII on purpose. The previous two guides were saved in a
> non-UTF-8 encoding and rendered as mojibake in every editor and browser,
> including during a defense.

---

## Contents

1. [The one-paragraph summary](#1-the-one-paragraph-summary)
2. [Before you demo - checklist](#2-before-you-demo--checklist)
3. [How a reading becomes a colour](#3-how-a-reading-becomes-a-colour)
4. [The four sensor reports](#4-the-four-sensor-reports)
5. [Data flow end to end](#5-data-flow-end-to-end)
6. [Security model](#6-security-model)
7. [Known limitations - say these before they are asked](#7-known-limitations--say-these-before-they-are-asked)
8. [Panel questions with guided answers](#8-panel-questions-with-guided-answers)
9. [3-minute walkthrough script](#9-3-minute-walkthrough-script)

---

## 1. The one-paragraph summary

A.I.R. reads CO2, LPG, temperature and humidity from four sensors on an ESP32
that posts to a Supabase database roughly every 3 seconds. A React dashboard
fetches the latest reading per device and grades each one against safety limits
stored in the database - not against limits compiled into the code, and not
against a severity value supplied by the device. Reports aggregate the same raw
readings into a calendar, a per-day view and a downloadable monthly PDF. Every
grade on screen comes from one function, `overallSeverity()` in
`src/lib/thresholdConfig.ts`, so the live badge, the calendar dot and the PDF
cannot disagree about the same reading.

---

## 2. Before you demo - checklist

Run these in order. Each step is verifiable.

```bash
npm install
npm run build                 # must print "built in Xs" with no TS errors
npx tsx scripts/verify-thresholds.ts   # must print "All checks passed."
```

`verify-thresholds.ts` is a real test suite, not a demo script. It imports the
same module the UI renders from, so a passing run is evidence that the guide
text, the badges and the report grading agree. It covers boundary semantics,
the "no data is not safe" invariant, and unknown-role handling.

### Apply the migrations

```bash
supabase db push
```

Verify in the SQL editor:

```sql
-- The saved limits must match the reference values
select * from public.platform_thresholds where id = 1;
-- co2 1000/2000/3500, lpg 1000/2100/4200, temp 5/18/35, humidity 20/30/80

-- The two tables that were previously unprotected
select relname, relrowsecurity
from pg_class
where relname in ('rooms','readings');
-- both must say true
```

### Rotate the cron secret (do this once, before the defense)

```bash
npx supabase secrets set CRON_SECRET="$(python -c 'import secrets;print(secrets.token_urlsafe(32))')"
```

The value `my-secret-123` is hardcoded in `supabase/migrations/20260907160000_daily_cron.sql`
and is therefore in git history. See limitation L1.

---

## 3. How a reading becomes a colour

### 3.1 The sentence to memorise

> "A colour is not a hardware output. It is a **grade the dashboard computes** by
> comparing a raw sensor reading against the safety limits saved in the database.
> Green means the reading is inside every limit. Red means it is outside at
> least one."

That sentence answers the most likely first question: *why does the light
disagree with the ESP32?* The firmware has its own severity tiers; the app
deliberately ignores them.

### 3.2 The grades

Every badge, dot, gauge segment, row tint and number colour comes from one map,
`SEVERITY_TONE` in `src/lib/thresholdConfig.ts`. There is no second colour
table.

| Colour | Grade | Badge text | Meaning |
|---|---|---|---|
| Green (teal `#0d9488`) | `ok` | `OK` | Inside every configured limit |
| Amber (`#d97706`) | `warning` | `Monitor` | Crossed the warning limit |
| Orange (`#ea6c2e`) | `high` | `High` | Crossed the high limit |
| Red (`#dc2626`) | `danger` | `DANGER` | Crossed a danger limit |
| Grey (`#64748b`) | - | `No sensor data recorded` | **Nothing was measured** |

> **Say this out loud:** "Grey is not a fifth grade. Grey means *we do not know*.
> The system refuses to paint a device green that has never reported, because a
> silent device and a safe device are indistinguishable if you colour them the
> same."

This is enforced, not aspirational. `overallSeverity()` returns `ok` for a
null reading - it has to, to combine metrics - so the dashboard gates every
safe-looking output on `hasAnyReading()`. Until this audit that gate was
computed and then thrown away when bucketing the KPI cards, so a registered
device that had never sent a reading was counted under **SAFE ROOMS**. That is
fixed, and there is now a separate **NO SENSOR DATA** KPI card so the four
counts still reconcile against the device list. See bug B1.

### 3.3 The grading rules

Reference limits, stored in `platform_thresholds` and editable by an admin:

| Metric | Warning | High | Danger | Unit |
|---|---|---|---|---|
| CO2 | 1000 | 2000 | 3500 | ppm |
| LPG | 1000 | 2100 | 4200 | ppm |
| Temperature | cool below 18 | - | freeze below 5 / heat above 35 | degC |
| Humidity | low below 30 | - | dry below 20 / mold above 80 | % RH |

**CO2 and LPG** - one-sided, ascending:

```
reading >= danger  ->  DANGER  (red)
reading >= high    ->  High    (orange)
reading >= warning ->  Monitor (amber)
otherwise          ->  OK      (green)
```

**Temperature and humidity** - two-sided, so there are only two danger limits
and one advisory each:

```
temperature <  5   ->  DANGER  (freeze / pipe risk)
temperature <= 18  ->  Monitor (too cool)
temperature >  35  ->  DANGER  (heat stress)
otherwise          ->  OK      (comfortable band)

humidity <  20  ->  DANGER  (too dry: irritation, static, wood damage)
humidity <= 30  ->  Monitor (low)
humidity >  80  ->  DANGER  (mold / condensation)
otherwise       ->  OK
```

### 3.4 Boundary semantics - the answer if they ask about exact values

> **"We made a deliberate choice: inclusive on the gas limits, exclusive on the
> lower bounds of temperature and humidity. And critically, the *same* choice is
> implemented in the TypeScript and in the SQL, so a reading sitting exactly on
> a limit is graded identically by the dashboard and by the PDF."**

`public.report_is_danger()` in PostgreSQL is the single source of truth:

```sql
co2      >= co2_danger
lpg      >= lpg_danger
temp     <  temp_freeze_below  or  temp > temp_heat_above
humidity <  humidity_dry_below or  humidity > humidity_mold_above
```

Before this audit the live dashboard used `<=` at the two lower bounds while the
reports used `<`. A reading of exactly 5.0 degC was therefore flagged DANGER on
the dashboard and not counted as danger on the same day's report. Fixed on both
sides; the test suite pins it.

### 3.5 Threshold validation is not just an ordering check

An admin typing `40` into the freeze field produces a config that is perfectly
*ordered* (40 < 45 < 50) and passes every database CHECK constraint - and which
grades a normal 24 degC room as DANGER, turning the whole building red and
starting the audible alarm on every open client. A false alarm indistinguishable
from a real one is itself a safety failure.

So `validateThresholds()` enforces ordering **and** plausibility bounds around
what a DHT22 can measure indoors:

| Field | Allowed range |
|---|---|
| `temp.freezeBelow` | -20 to 15 degC |
| `temp.coolBelow` | -20 to 28 degC |
| `temp.heatAbove` | 25 to 60 degC |
| `humidity.dryBelow` / `moldAbove` | 0 to 100 % RH |

Validation exists in the UI, in the database (CHECK constraints) and is covered
by the test suite. No SQL is built by string concatenation anywhere in the
migrations.

---

## 4. The four sensor reports

The day view renders **one chart per metric that recorded data** - CO2, LPG,
temperature and humidity, each with its own danger and warning lines, each
bucketed to 5-minute averages so a full day is at most 288 points. Metrics with
no readings for the day are omitted rather than drawn as a flat line at zero,
because a zero would assert a measured value of zero.

Before this audit the day view was hardcoded to a single CO2 chart
(`const CHART_METRIC: MetricKey = "co2"`) even though the database already
returned all four series. The monthly PDF already rendered all four, which is
why the PDF looked right and the page did not.

### The aggregation hierarchy

| Granularity | Bucket | Where |
|---|---|---|
| Raw reading | ~3 s | `readings` table |
| Day view chart | 5 min (`p_bucket_seconds: 300`) | `report_day_detail` |
| Monthly PDF chart | 1 day | `report_month_stats` |

Note the asymmetry: **`reading_count`, min, avg and max are computed over raw
rows, not over buckets.** Only the chart series is downsampled. If someone asks
why the reading count on a day is much larger than the number of points on the
chart, that is the answer.

### Timezone

Everything is computed on Manila calendar days. The SQL does
`(x::timestamp at time zone 'Asia/Manila')` rather than casting a `timestamptz`
straight to `date`, because the latter uses the *session* TimeZone and would
shift every label by a day on a database not configured for Manila. The
Philippines has had no DST since 1978, so a fixed +480 minute offset is
correct for every date the system can display.

---

## 5. Data flow end to end

```
ESP32 (CO2 / LPG / DHT22)
   |  POST ~every 3s, anon key, INSERT only
   v
public.readings          append-only, RLS: anon INSERT, authenticated SELECT
   |
   +--> Realtime "readings" channel  ---> dashboard updates between polls
   |
   +--> 2s polling fallback           ---> catches missed realtime events
   |
   v
Dashboard (RoomsContext)
   |  grade each metric vs saved thresholds
   v
overallSeverity() -> SEVERITY_TONE -> badge / gauge / KPI

Reports RPCs (PostgreSQL)
   report_calendar_month      -> calendar dots
   report_day_detail          -> min/avg/max + 5-minute series
   report_day_danger_rows     -> paged danger log (250/page)
   report_month_stats         -> monthly summary + per-day series
   |
   v
monthlyPdf.ts (jsPDF, in the browser) -> downloaded PDF
```

### The polling fallback exists on purpose

Realtime is a convenience, not a guarantee. If the socket drops, the dashboard
keeps updating from a 2-second poll. Both paths write the same room state, so
the merge is **monotonic**: a response is only applied if its `created_at` is
newer than what is already displayed. Without that, whichever request happened
to resolve last would win, and the dashboard would visibly roll backwards a
reading. See bug B3.

---

## 6. Security model

### Layers

1. **PostgreSQL Row Level Security is the real boundary.** Every protected table
   has RLS enabled with explicit policies.
2. **RLS-enabled tables** - `profiles`, `platform_thresholds`, `rooms`,
   `readings`, `notifications`, `sensor_reports`, `daily_summaries`,
   `monthly_reports`, `annual_reports`, `graph_buckets`, `threshold_history`,
   `archive_runs`, `reporting_config`, `bootstrap_admins`.
3. **Function grants.** PostgreSQL grants `EXECUTE` to the pseudo-role `PUBLIC`
   by default, and `anon` is an implicit member of `PUBLIC`. `revoke ... from
   anon` therefore removes a grant that was never made. Every report RPC
   revokes from `public` first, then re-grants to `authenticated` only.
4. **Server-side approval.** `is_approved_account()` and `is_active_admin()`
   are the only two predicates that grant anything, and both re-check
   `role`, `account_status = 'approved'` and `is_active`.
5. **Edge Functions re-verify the caller.** `admin-create-personnel` and
   `manage-account-approval` build a client carrying the *caller's own* JWT,
   read `profiles` through RLS, and only escalate to the service role after.

### Device access is INSERT-only

`public.readings` grants `anon` **INSERT and nothing else**. The firmware holds
only the publishable anon key, which by design appears in the browser bundle.
No UPDATE or DELETE policy exists, so RLS denies both to every non-service role:
**a safety record is append-only.** Only the archive job removes rows, and it
runs as the service role, which bypasses RLS.

### Admin promotion is blocked server-side

A database trigger raises unconditionally if any update tries to set
`role = 'admin'`. Only the service role (SQL editor, Edge Functions) can grant
it. Hiding the option in a dropdown would be cosmetic.

### The device registry is admin-writable only

`rooms` is readable by any approved account (the dashboard needs it) but
insert / update / delete require `is_active_admin()`. Previously the *only*
thing preventing a monitoring-role user from running
`supabase.from("rooms").update({ siren_muted: true })` - silencing a physical
gas alarm - was a `user.role === "admin"` check in a React component. RLS
policy now exists. See bug S1.

---

## 7. Known limitations - say these before they are asked

Volunteering limitations reads as command of the material. Each of these is
real and none of them are hidden.

**L1 - A cron secret is in git history.** `20260907160000_daily_cron.sql`
contains a literal bearer token. It was replaced by a `reporting_config`
table plus `set_reporting_cron_secret()` in a later migration, but the literal
remains in the old file and in history. *Action: rotate the secret (the command
is in section 2), then scrub history.*

**L2 - There is no UI to approve a self-registered account.** Registration via
`self-register` creates the account as `pending`, and `manage-account-approval`
exists as a server function but nothing in the product calls it. Until the
Personnel page grows Approve / Reject controls, a self-registered user cannot be
promoted through the app. The *security* half of this is now closed - a
`pending` account is rejected by RLS, not only by the UI - but the workflow is
still half-built. *This is the most likely thing to be found in review.*

**L3 - Deleting a personnel record does not delete the auth account.**
`profiles.id` is text with no FK to `auth.users`, so the delete removes the app
row while the login credentials and refresh tokens survive. The UI then shows
"No account profile was found". *Action: add an admin-only Edge Function that
calls `auth.admin.deleteUser()`.*

**L4 - There is no alarm de-duplication.** `send-alert-email` re-sends on every
invocation for every breaching device, with no cooldown and no escalation
tracking. A persistently dangerous room produces the same email repeatedly.

**L5 - `send-alert-email` has no scheduler.** The function is complete but no
`pg_cron` entry or external trigger calls it. *Do not claim to the panel that
email alerts are running.*

**L6 - No deduplication on `readings`.** The table has no uniqueness
constraint. A device retrying a POST after a flaky WiFi link inserts a second
identical row, and every `count(*)`-based figure - reading counts, averages,
coverage - counts it.

**L7 - Device readings contain firmware-clamped values.** CO2 `max 5000` matches
the firmware's top severity tier, and CO2 `min 0` violates the system's own
"missing is NULL, never zero" invariant - some device is posting literal zeros,
most likely a sensor that has not warmed up. Those zeros drag the daily average
down. *This is a device-side issue; the app handles it correctly by never
substituting a value, but it cannot fix bad input.*

**L8 - The SQL was not executed in a test database.** The migration changes in
this release were verified by inspection, not by running them, because no local
PostgreSQL was available in the development environment. Run
`supabase db push` against a staging project first.

**L9 - The main JS bundle is ~950 kB.** Vite warns about it. Code-splitting the
PDF and chart libraries with dynamic imports would cut the initial payload; it
has not been done.

---

## 8. Panel questions with guided answers

**Q: What stops a student from changing the safety limits to disable the
alarms?**
RLS. `platform_thresholds` writes require `is_active_admin()`, which re-checks
role, approval and active status in the database. A monitoring-role account
gets a permission-denied error from PostgREST. The Settings form validates
client-side, but the form is not the protection - the policy is. Ordering and
plausibility are additionally enforced by database CHECK constraints.

**Q: Why don't you just store the severity on the device?**
Because then the threshold logic would live in firmware, could not be changed
without reflashing every device, and would be unverifiable from the database. The
firmware's own `severity` column is deliberately ignored by the dashboard. Grade
is computed centrally from raw values plus saved limits, so a limit change takes
effect immediately and is auditable.

**Q: Your dashboard says a room is fine. How do you know it is actually
measuring?**
That is precisely the `hasAnyReading()` invariant, and the **NO SENSOR DATA** KPI
card exists to make it auditable. A room with zero measurements is counted in
neither SAFE, WARNING/HIGH, nor DANGER - it has its own count. The four numbers
always reconcile to the device list.

**Q: What if the network drops?**
Two independent paths. Realtime pushes updates between polls, and a 2-second
polling query runs as a fallback. If a device posts nothing for 30 seconds it
is marked offline and its `lastReadingAt` is shown, so the UI keeps telling you
*how old* the displayed number is rather than silently freezing it.

**Q: How do you know the PDF matches the screen?**
They are computed from the same raw readings against the same thresholds, and
the boundary comparison was verified to be identical in both
(`verify-thresholds.ts`, section 12). The test suite also pins the values that
generate the reference guides, so the on-screen guide cannot drift from the
saved configuration.

**Q: What is the sampling rate?**
The firmware is declared at a 3-second cadence (`EXPECTED_SAMPLE_SECONDS`).
Note the reading count on a report sums across **all** devices when the room
filter is "All rooms". At 3 s a single device produces ~28,800 readings per day.

**Q: What happens on a public WiFi / shared network?**
The publishable anon key is in the browser bundle by design, which is why the
only thing it can do is INSERT a reading. It cannot read, update or delete
anything. There is no unique constraint on the readings table, so a hostile
client could inject rows - acknowledged in L6.

**Q: What is the weakest part of the system?**
Honestly: the approval workflow is half-built (L2). Registration exists and the
server-side enforcement is now correct, but the product has no Approve button,
so an administrator cannot promote a self-registered user through the UI. The
fix is small and identified; the enforcement half - the part that matters for
security - is done.

**Q: How did you validate it?**
`scripts/verify-thresholds.ts` runs 33 assertions against the same module the UI
renders from: reference-guide generation, ordering and plausibility validation,
boundary semantics against the SQL rule, the no-data invariant, and
fail-closed permission lookup. `npm run build` runs TypeScript in strict mode
with unused-symbol checks.

---

## 9. 3-minute walkthrough script

**0:00 - Dashboard.** "This is live. Devices are posting about every 3 seconds.
Every badge is computed here, in the browser, from the raw reading and the limits
in the database - not from a number the device supplied."

**0:45 - Show a NO SENSOR DATA card.** "One device has never reported. It is not
counted as safe. Grey means we do not know; a silent device and a safe device
look identical if you colour them the same."

**1:15 - Show a danger badge and the alarm.** "Red is computed, not reported. The
audible alarm fires when a *computed* grade is danger, on every open client."

**1:45 - Reports.** "Same raw readings, aggregated. All four sensors get their own
chart with their own limit lines, at 5-minute resolution - about 288 points for
the day. A sensor that recorded nothing is omitted rather than drawn as zero."

**2:15 - Select a day, show the danger log.** "The counts, the per-metric min /
avg / max and this danger log all come from the same rows. The log is paged, not
loaded whole."

**2:30 - Download the monthly PDF.** "Generated in the browser from the same
queries. All four metrics, the threshold lines, and a plain-language
interpretation whose numbers are derived from the data - not written by hand."

**2:50 - Settings.** "These are the safety limits. They are validated for
ordering *and* for physical plausibility, stored in the database, and enforced
by RLS plus CHECK constraints - not just by this form."

---

## Appendix: where to look in the code

| Topic | File |
|---|---|
| Grading rules | `src/lib/thresholdConfig.ts` |
| Threshold validation | `src/lib/thresholdConfig.ts` (`validateThresholds`) |
| Colour mapping | `src/lib/thresholdConfig.ts` (`SEVERITY_TONE`) |
| Live data, polling, realtime | `src/context/RoomsContext.tsx` |
| Dashboard | `src/pages/DashboardPage.tsx` |
| Day report + 4 charts | `src/components/DailyReportPanel.tsx` |
| Chart rendering | `src/components/ReportChart.tsx` |
| Report queries | `src/lib/reportQueries.ts` |
| Monthly PDF | `src/lib/monthlyPdf.ts` |
| PDF chart rasteriser | `src/lib/chartCanvas.ts` |
| Plain-language report text | `src/lib/interpretation.ts` |
| Permissions | `src/lib/permissions.ts` |
| The danger rule (source of truth) | `supabase/migrations/20260914000000_reports_simplified.sql` |
| RLS and grants | `supabase/migrations/20260916000000_production_hardening.sql` |
| Alert email | `supabase/functions/send-alert-email/index.ts` |
| Test suite | `scripts/verify-thresholds.ts` |