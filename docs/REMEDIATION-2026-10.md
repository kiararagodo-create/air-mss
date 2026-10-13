# Remediation log - production hardening pass

**Date:** 2026-10-13
**Scope:** Full-system audit and fix ahead of the panel defense and live deployment.

Every item below was verified by reading the actual code before and after the
change. Items marked **[unverified in a live DB]** were validated by inspection
only, because no local PostgreSQL was available. Run them against a staging
project first.

---

## A. Reporting was returning one day of data instead of one month

### A1. `report_calendar_month` and `report_month_stats` bounded a "month" with one day

**Severity: Critical**

`supabase/migrations/20260914000000_reports_simplified.sql`

In PostgreSQL, `date + integer` adds **days**, not months. Both functions used
`(p_month_start + 1)` where "the first of the next month" was intended - the
correct `p_day + 1` from the day function was copy-pasted into the month
functions without adjusting the unit.

```sql
-- before
((p_month_start + 1)::timestamp at time zone 'Asia/Manila') as hi
-- after
(((p_month_start + interval '1 month')::date)::timestamp at time zone 'Asia/Manila') as hi
```

**Effect:** `report_calendar_month` returned exactly one row (the 1st) and every
other day of the month rendered as "no readings recorded" and was unselectable.
`report_month_stats` reported `days_with_data: 1 of 31`, and every monthly PDF
titled "January 2026" contained one day of readings.

**Fix:** corrected in the original migration (so a fresh install is right) and
re-applied to any already-migrated database by
`20260916000000_production_hardening.sql`, which patches the deployed function
bodies from `pg_get_functiondef` and **raises** if the expected text is not
found, so a mismatch fails loudly instead of silently reporting success.

### A2. `report_day_detail` referenced a column that does not exist

**Severity: Critical**

```sql
-- the CTE aliases the column humidity_danger ...
)::bigint as humidity_danger
-- ... but the final SELECT asked for hum_danger
'humidity', coalesce((select hum_danger from stats), 0)
```

`language sql` function bodies are validated at `CREATE` time, so this is a
hard failure. **Fix:** renamed to `humidity_danger`, matching the sibling call
at the equivalent site in `report_month_stats`.

### A3. Humidity low-danger was never reported in the PDF

**Severity: High**

`src/lib/interpretation.ts`

```ts
humidity: { high: thresholds.humidity_mold_above, low: thresholds.humidity_dryBelow },
```

`humidity_dryBelow` is camelCase; the RPC returns snake_case
`humidity_dry_below`. It was the only camelCase key in `src/`, resolved to
`undefined` at runtime, and the `bands.low !== undefined` guard written to
protect against exactly this silently **disabled** the dry-air check
permanently. A month where humidity dropped to 8 % was reported as having
stayed within the safe range.

**Fix:** corrected the key, and introduced a real `ReportRpcThresholds` type
(see B5) so a misspelled key is now a compile error.

### A4. `fetchDayDetail` / `fetchMonthStats` cast `null` straight to the result type

**Severity: Medium**

PostgREST returns `null`, not an error, when an RPC yields no value or is
missing from the schema cache. `DailyReportPanel` guards `!detail`, so the real
failure mode was the day panel silently rendering nothing.

**Fix:** both now throw a named error when the RPC returns no data.

---

## B. Threshold logic

### B1. "SAFE ROOMS" counted devices that had never reported

**Severity: Critical - safety misreport**

`src/pages/DashboardPage.tsx`

```tsx
const safeRooms = rooms.filter((r) => getStatus(r, cfg).level === "ok");
```

`overallSeverity()` returns `ok` for a null reading by design (it has to, to
combine four metrics), and the KPI bucketing threw away the `hasData` flag that
had just been computed for the badge. A registered ESP32 that had never sent a
reading was therefore counted under **SAFE ROOMS** - the exact failure mode the
`hasAnyReading()` function exists to prevent.

**Fix:** `safeRooms` and `warningHighRooms` now both require `hasData`, and a
separate **NO SENSOR DATA** KPI card was added so the counts still reconcile
against the device list. `getStatus` also returns a neutral tone rather than
green when there is no data.

### B2. Live dashboard and reports disagreed at the lower threshold boundary

**Severity: High**

The dashboard used `<=` for the freeze and dry-air limits; the SQL
`report_is_danger()` and `reports.ts` used `<`. A reading of exactly 5.0 degC
was DANGER on the dashboard and was **not counted** as a danger reading on the
same day's report, the calendar dot, the monthly count and the PDF. The
codebase explicitly claimed this could never happen.

**Fix:** made the TypeScript grading strict (`<`) to match the SQL and the
reports, added the same guard to `send-alert-email`, and pinned all four
directions in `verify-thresholds.ts` section 12.

### B3. `getPermissions` returned `undefined` for any unrecognised role

**Severity: High - white screen**

`profiles.role` is free text and `UserRole` is typed as `... | string`, so a
legacy `"staff"` or a typo made `getPermissions()` return `undefined`;
`Sidebar.tsx` then threw on `permissions.canAccessReports`. There is no error
boundary, so the entire app blanked for that user.

**Fix:** fails closed to a least-privilege read-only permission set. Test added.

### B4. No plausibility bounds on the temperature tiers

**Severity: High - false mass alarm**

Ordering alone accepted `freezeBelow: 40, coolBelow: 45, heatAbove: 50` - which
passes every database CHECK constraint and grades a normal 24 degC room as
DANGER, turning every room red and starting the audible alarm on every open
client simultaneously. A false alarm indistinguishable from a real one is itself
a safety failure.

**Fix:** `validateThresholds()` now also bounds the temperature tiers to values
a DHT22 can produce indoors. Ordering errors still take precedence so the admin
sees the more useful message. Test added.

### B5. The RPC threshold payload was typed as the wrong shape

**Severity: Medium - root cause of A3**

`MonthStats.thresholds` was declared as the richer client `ReportThresholds`,
which has keys (`threshold_source`, `co2_warning`, ...) the RPC never returns.
Consumers had to cast to `Record<string, number>`, which is why a misspelled key
compiled clean.

**Fix:** added `ReportRpcThresholds` with exactly the six keys the RPC returns,
and removed both casts.

---

## C. Live dashboard data integrity

### C1. Any `rooms` UPDATE wiped the last-reading timestamp

**Severity: Critical - false "no data" claim**

`src/context/RoomsContext.tsx`

The realtime `rooms` UPDATE merge restored `temp`, `humidity`, `online`, `co2`
and `lpg` from the existing room but **not** `lastReadingAt`, because
`rowToRoom()` always sets it to `null`. Any unrelated write to a room row - most
visibly `toggleSiren`, i.e. every single mute/unmute click - reset a healthy
device's display to "no reading ever received".

**Fix:** `lastReadingAt` is now carried over explicitly.

### C2. Overlapping polls and stale-response overwrite

**Severity: Critical - live safety display**

The 2-second poller used `setInterval` with no in-flight guard, so a sweep
longer than 2 seconds overlapped the next one and requests multiplied without
bound. Worse, both the realtime handler and the poller wrote the same room, so
whichever response resolved last won - the dashboard visibly rolled backwards a
reading. The `!data` branch also blanked live values unconditionally, so a
request issued before a device's first reading could resolve after it and make
a healthy new device claim it has never reported.

**Fix:**
- In-flight guard so sweeps cannot overlap.
- The merge is now **monotonic**: a response is applied only if its
  `created_at` is newer than what is already displayed. This is
  order-independent and fixes realtime-vs-poll and poll-vs-poll alike.
- The `!data` branch only applies when the room has genuinely never had a
  reading.

### C3. Offline detection had no clock-skew tolerance

**Severity: Medium**

`Date.now() - created_at < OFFLINE_THRESHOLD_MS` was not lower-bounded, so a
device whose clock ran fast read as permanently online forever - including one
that died weeks ago.

**Fix:** added a 60-second future-skew tolerance.

### C4. `NULL` floor/name could white-screen the dashboard

**Severity: Medium**

`rowToRoom` asserted `floor: string` with no guard, but `DashboardPage` calls
`.toUpperCase()` on it. A row edited directly in the Supabase table editor with
a `NULL` floor threw during render.

**Fix:** coerced to `""`, consistent with how `co2_sensor` was already handled.

### C5. Device add / mute-all races

**Severity: Medium**

- `addRoom` appended unconditionally, so when the realtime INSERT arrived before
  the REST response the device was listed twice, polled twice, and only one
  copy was removed by `removeRoom`. **Fix:** upsert-by-id.
- `muteAll` rolled back a whole-array snapshot on failure, reverting every live
  `co2`/`temp`/`lastReadingAt` the poller had written while the request was in
  flight - a transient network error looked like the building stopped
  reporting. **Fix:** roll back only `sirenMuted`.

---

## D. Charts and PDF

### D1. The day view only ever charted CO2

**Severity: High - the reported bug**

`src/components/DailyReportPanel.tsx` had a module-level
`const CHART_METRIC: MetricKey = "co2"` and projected only that field out of a
four-metric series. The database already returned all four.

**Fix:** renders one chart per metric in `METRIC_ORDER`, each with its own
correctly-resolved thresholds, skipping metrics with no readings. Matches what
the monthly PDF already did.

### D2. Chart threshold labels rounded away the decimal for temperature

**Severity: Medium**

`ReportChart` passed `fmtNumber(v)` with the default 0 decimals for the danger
and low-danger labels, while correctly passing `metric === "temp" ? 1 : 0` for
the Y-axis and peak marker. A `temp_heat_above` of 35.5 displayed as
**"Danger 36"** on the chart while the PDF and reference guide said 35.5 -
rounding a heat-stress limit in the unsafe direction.

**Fix:** uses the already-existing `metricDigits()` helper.

### D3. PDF charts were vertically stretched ~10%

**Severity: Medium**

The canvas was rendered at 700x200 (aspect 3.50) and placed at 178x46 mm
(aspect 3.87). jsPDF stretches to the given box without preserving aspect, so
every chart in the PDF was distorted and the danger line no longer sat where
the Y-axis labels said it did.

**Fix:** the placement height is derived from the render aspect ratio.

### D4. One non-finite value silently deleted a whole PDF chart

**Severity: Medium**

`chartCanvas.ts` filtered with `v !== null` (letting `undefined` and `NaN`
through) but then tested `p.value === null` when drawing. A single non-finite
value poisoned `Math.min`/`Math.max` with `NaN`; canvas silently ignores
`moveTo(NaN, NaN)`, producing a blank chart with grid lines, no series and no
error anywhere.

**Fix:** both sites now require a finite number, matching what `ReportChart`
already did correctly. `toSeries` also coerces a missing aggregate to `null`.

### D5. The PDF date parse was correct only by coincidence

**Severity: Low**

`Number(d.day.slice(8, 10))` is right for a Postgres `date` rendering, but a
`NaN` key would blank the entire series for any other rendering.

**Fix:** parses the leading ISO date portion explicitly.

---

## E. Async races in the reports UI

### E1. Stale calendar rows under a new month header

**Severity: High - looks like data loss**

Changing month or device cleared the selected day but not `days`, so for one
round-trip the calendar rendered the **new** header with every day greyed out
as "no readings recorded".

**Fix:** `days` is cleared on year/month/device change.

### E2. Overlapping report RPCs could land out of order

**Severity: Medium**

Rapid month-arrow clicks fired concurrent `report_calendar_month` calls with no
cancellation, so a slower earlier response could leave one month's counts under
another's header. `DailyReportPanel.loadDetail` and `MonthlyReportGrid`'s
12-RPC `Promise.all` had the same exposure (and the latter also set state after
unmount).

**Fix:** cancellable effects in all three.

### E3. `MonthlyReportGrid` fetched all 12 months before discarding the future ones

**Severity: Medium**

Every page mount issued up to 12 concurrent PostgREST RPCs, of which those past
the current month were guaranteed empty.

**Fix:** the month list is computed before any request; future months are never
fetched.

### E4. Stacked PDF downloads

**Severity: Low**

Clicking Jan then Feb let Jan's `finally` clear `busyMonth` while Feb was still
generating, re-enabling the Jan button.

**Fix:** one PDF in flight at a time.

### E5. Duplicate React keys in the danger table

**Severity: Low**

`key={r.created_at}` with no uniqueness guarantee on `created_at`.

**Fix:** index-suffixed keys.

---

## F. Performance

### F1. `DailyReportPanel` recomputed all four charts on every render

**Severity: Low - visible jank**

`points` was rebuilt on each render, and `ReportChart`'s `useMemo` keys on array
identity, so the scale/segment/tick model was recomputed for every metric
whenever the danger table paginated.

**Fix:** memoised on `detail`; `formatX` hoisted to `useCallback`.

### F2. `RoomsProvider` re-rendered the whole tree every 2 seconds

Noted but **not changed**: the provider value is a fresh object literal and
`toggleSiren`/`muteAll` depend on `rooms`, so every consumer re-renders each
poll tick. Fixing this properly means holding `rooms` in a ref and memoising the
context value; it is a refactor rather than a bug fix and was left out of this
pass to keep the change set reviewable.

---

## G. Security

### G1. Account approval was enforced only in the browser

**Severity: Critical**

GoTrue has no knowledge of `profiles.account_status`, so `signInWithPassword`
succeeds for a `pending` self-registered account and returns a valid JWT. The
check that rejected it lived in `AuthContext.login()` - in the same tab as the
devtools the user could open. Every `to authenticated` policy then applied to
that account in full.

**Fix:** added `public.is_approved_account()` (role-independent: approved +
active) and applied it to the `rooms`, `readings` and `platform_thresholds`
read policies, plus approval-guarded wrappers for the two report RPCs the UI
calls.

**Still open (limitation L2 in the defense guide):** there is no UI to approve
an account. The enforcement half is done; the workflow half is not.

### G2. `revoke ... from anon` does not revoke anything

**Severity: Critical**

`CREATE FUNCTION` grants `EXECUTE` to the pseudo-role `PUBLIC`, and `anon` is an
implicit member of it. `REVOKE ... FROM anon` removes a grant that was never
made, leaving every report RPC callable by an unauthenticated caller with only
the public anon key - including `report_day_danger_rows`, which returns raw
per-reading rows with exact timestamps that the UI restricts to admins.

The repo already did this correctly elsewhere (`from public, anon, authenticated`);
this one migration did not.

**Fix:** revoke from `public` first, then re-grant to `authenticated` only, in
both the original migration and the hardening migration.

### G3. `rooms` and `readings` had no RLS at all

**Severity: Critical**

Neither table was ever given `alter table ... enable row level security` (both
were created outside this repository). The only thing preventing any
signed-in account from running
`supabase.from("rooms").update({ siren_muted: true }).in(...)` - silencing a
physical gas alarm - was `user.role === "admin"` in a React component.

**Fix:** RLS enabled with explicit policies.
- `rooms`: read for approved accounts; insert/update/delete admin-only.
- `readings`: `anon` may **INSERT only** (the firmware). Read for approved
  accounts. **No UPDATE or DELETE policy exists**, so RLS denies both to every
  non-service role - the table is append-only.

### G4. `notifications` RLS compared `uuid` to `text`

**Severity: High - feature 100% dead, silently**

```sql
using (auth.uid() = user_id)   -- auth.uid() is uuid, user_id is text
```

PostgreSQL has no `uuid = text` operator, so every read raised and the
notification bell silently showed nothing; `markRead` no-opped. The error was
swallowed into a `console.error`.

**Fix:** `auth.uid()::text = user_id` in both policies.

### G5. Realtime publication was missing three subscribed tables

**Severity: Medium**

Only `platform_thresholds` was added to `supabase_realtime`, yet the client
subscribed to `rooms`, `readings` and `notifications`. Subscriptions succeeded
and delivered nothing. `readings` is masked by the polling fallback, but `rooms`
has none - a device added in another tab never appeared.

**Fix:** `rooms` and `notifications` are now published, **after** G3 gave those
tables real RLS (a published table without RLS would hand every subscriber every
row). `readings` is deliberately **not** published - at a 3-second cadence that
would push every row of every device to every client, which the 2-second
latest-row poll already covers more cheaply.

---

## H. Alert email

### H1. A reporting device was reported as "never reported a reading"

**Severity: Critical - false statement from the safety system**

`supabase/functions/send-alert-email/index.ts` computed "newest reading per
device" from a single `.in(...).order(...).limit(n * 5)` window. At a 3-second
cadence one chatty device fills the entire window alone, so a second device
reporting perfectly well is pushed out and the safety email states it has never
reported.

**Fix:** queried per device with `.eq(...).order(...).limit(1)`.

### H2. A mail-provider failure returned 502, inviting retry storms

**Severity: Medium**

The grading succeeded but a Resend failure returned 5xx, so any retrying caller
or the platform itself re-ran the alert - turning one mail outage into a flood
of duplicate safety emails.

**Fix:** returns 200 with `email_sent: false` and the error in the body.

### H3. Boundary and NaN handling diverged from the app

**Severity: Medium**

The function's local `tempSeverity`/`humiditySeverity` used `<=` and had no
`Number.isFinite` guard, so the email could disagree with the dashboard and in
both directions.

**Fix:** aligned with `thresholdConfig.ts` and the SQL.

---

## Test suite

`scripts/verify-thresholds.ts` grew from 22 to 33 assertions. New sections:

- **11** - temperature plausibility bounds, and proof that the rejected tiers
  would otherwise have graded a normal room as danger.
- **12** - boundary semantics in all four directions, cross-checked against
  `isDanger()` from `reports.ts`.
- **13** - the no-data invariant: all-null grades `ok` internally but
  `hasAnyReading` is false, so the UI cannot paint it green.
- **14** - unknown roles fail closed.

```
$ npx tsx scripts/verify-thresholds.ts
All checks passed.
```

---

## Verification performed

| Check | Result |
|---|---|
| `npx tsc -b` (strict + noUnusedLocals) | clean |
| `npm run build` | clean, 1943 modules |
| `npx tsx scripts/verify-thresholds.ts` | 33/33 pass |
| SQL validated by execution | **not done** - no local PostgreSQL; inspect manually |

---

## Recommended order of operations before going live

1. `supabase db push` against a **staging** project first and confirm the
   `raise notice` lines from `20260916000000_production_hardening.sql` show the
   three function repairs were applied (or were already correct).
2. Verify in the SQL editor:
   ```sql
   select relname, relrowsecurity from pg_class
   where relname in ('rooms','readings','notifications');
   -- all true

   select proname, has_function_privilege('anon', oid, 'EXECUTE')
   from pg_proc where proname like 'report_%';
   -- all false

   select * from report_calendar_month('2026-01-01', null, '{}');
   -- must return 31 rows, not 1
   ```
3. Rotate `CRON_SECRET` (limitation L1).
4. Add Approve / Reject controls to the Personnel page (limitation L2).
5. Re-verify the reference limits in `platform_thresholds`.