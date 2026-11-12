# A.I.R. Notifications — Test Plan

## Deploy once
1. Apply `supabase/migrations/20260918000000_air_notifications.sql` in Supabase SQL editor, then `supabase/migrations/20260919000000_alert_actions_sms.sql` (paste-ready copies: `supabase/DEPLOY-AIR-NOTIFICATIONS.sql`, `supabase/DEPLOY-ALERT-ACTIONS-SMS.sql`).
2. Deploy Edge Functions: `air-alerts`, `check-offline`, `action-by-token` (public, supersedes legacy `air-action`), `record-action`, `send-sms`:
   ```bash
   supabase functions deploy air-alerts check-offline action-by-token record-action send-sms
   ```
   See `docs/ALERT-ACTIONS-SMS-DEPLOY.md` for the full A/B/C deploy notes.
3. Set secrets (Dashboard > Edge Functions > Secrets): `IPROG_SMS_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_PUBLIC_URL`.
4. Disable JWT verification for `action-by-token` only (Dashboard > Edge Functions > action-by-token > Settings). Keep JWT ON for `record-action` and `send-sms`.
5. Point the `readings` INSERT Database Webhook at `air-alerts`; schedule `check-offline` every 30s (pg_cron or Dashboard Schedules).
6. Ensure at least one active `profiles` row per role has a `contact_number` (e.g. `09171234567`) — the SMS recipient source.

## Simulate readings (Kitchen = AIR-D03)
Run in Supabase SQL editor (adjust device id to the Kitchen room id):

```sql
-- CO2 danger: 3600 ppm (>= 3500 -> Danger)
insert into public.readings (device_id, co2, lpg, temp, humidity)
values ('AIR-D03', 3600, 500, 27, 55);

-- LPG alarm: 2200 ppm (>= 2100 and < 4200 -> Alarm / severity high)
insert into public.readings (device_id, co2, lpg, temp, humidity)
values ('AIR-D03', 600, 2200, 27, 55);
```

## Expected results
- [ ] Bell: red badge increments; dropdown shows both alerts with severity dot, room, sensor, reading, relative time, "No action yet".
- [ ] Bell: clicking an alert opens `/notifications?id=<id>` and marks it read (badge decrements).
- [ ] `/notifications`: two new rows, newest first; filter by severity/room/sensor works; clicking a row opens the drawer with action plan, timeline (Detected, SMS per personnel, Resolved).
- [ ] SMS log: `select * from public.sms_logs where notification_id = <id>` shows one row per addressed personnel (Maintenance only for Alarm; Maintenance+Security+Admin for Danger), status `submitted` (or `failed` with provider response), message contains `/action/<token>`.
- [ ] IPROG: messages appear in iprogsms.com > SMS Messages history for the same numbers.
- [ ] Action flow: open the SMS link `/action/<token>` in a phone browser (no login) → tap “Acknowledge / I'm on it” → confirmation shows; bell dropdown and Notifications timeline now show “Acknowledged by <name>” + time; “Handled by” column updates.
- [ ] Escalation: insert another reading for the same sensor at a higher level → old row becomes `resolved`, new row opens, new SMS sent immediately (bypasses cooldown).
- [ ] Recovery: insert a safe reading (CO2 700 ppm) → open row auto-resolves with `resolution_note = 'Reading returned to safe range'`.
- [ ] Dedup: re-insert same level 3× quickly → only one open row, only one SMS batch (cooldown).
- [ ] Offline: stop the ESP32, wait 60s + next `check-offline` run → `level_label = Offline` row + SMS to Maintenance + Admin. Resume readings → Offline row resolves.
- [ ] Role access: log in as Maintenance → `/notifications` shows only rows addressed to them; log in as Admin → all rows.
- [ ] Failed resend: tamper one `sms_logs.status` to `failed`, open the drawer → SMS Log tab → “Resend” button → new `sms_logs` row appears.

## Personnel actions + manual SMS (A/B) — acceptance

- [ ] **(1) Cross-user action:** click “On my way” on the Hallway Offline alert as Maintenance → Admin sees it in the bell (“[Name] took action: On my way - Hallway Offline”), the row label, the dashboard Action Plan, and the timeline; the Action Log tab lists it newest-first (filter by personnel/action).
- [ ] **(2) Manual SMS:** as Admin/Security, Send custom SMS to ONE number → result shows Sent, the SMS Log / `sms_logs` row appears, and the message shows in iprogsms.com → SMS Messages. A failed row shows Resend (new row for that recipient only).
- [ ] **(3) Token link:** open the `/action/<token>` link on a phone with no login → tap an action → it is logged under the right personnel name; after 24h (manual SMS tokens) it shows “Link expired”.
- [ ] In-app actions: Acknowledge / On my way / Resolved (note) / False alarm (note) buttons on Notifications rows, Live alerts, bell dropdown and dashboard Action Plan; spinners while saving, toast on success/error, multiple actions per alert all logged. Offline/sensor-fault rows also show “Mark as repaired”.
- [ ] Manual SMS dialog: severity preselect (Warning/High → Maintenance; Danger/Critical/Alarm → all roles), no-number personnel disabled, character/segment counter, credits preview (block at 0, warn below count), confirm step, 30-min cooldown warning with admin “Send anyway”.
- [ ] Resolved-but-still-present: mark a live danger alert Resolved while the reading is still high → it keeps showing as “Resolved by [name] - condition still present”, not hidden.
- [ ] Role rules: Maintenance cannot see “Send SMS” (server returns 403 too); Security can send SMS but cannot “Send anyway” on cooldown; everyone can view the Action Log; Admin sees unhandled Danger/Critical highlighted after 10 minutes.
