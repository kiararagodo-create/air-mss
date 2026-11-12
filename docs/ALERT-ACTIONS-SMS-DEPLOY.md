# A.I.R. — Personnel actions + manual SMS: deploy notes (A/B/C)

## What was added

- **(A) Actions on alerts** — Acknowledge / On my way / Resolved / False alarm
  (+ Mark as repaired for offline/sensor-fault) on every alert surface:
  Notifications page (saved rows, Live alerts list, detail drawer), bell
  dropdown, dashboard Action Plan. Every action is logged in
  `notification_actions` with personnel name/role/time/note, and
  `air_notifications` gets `status`, `handled_by_id`, `handled_by_name`,
  `handled_by_role`, `handled_at` (plus `resolved_at`/`resolution_note` for
  Resolved/False alarm/Repaired). Everyone sees it in real time (realtime
  subscriptions + 10s polling fallback): "Handled by" lines, the detail
  timeline (Detected → SMS → every action → Resolved), the bell
  "[Name] took action: Acknowledged - Kitchen CO2" items, and the dashboard
  Action Plan handler line. Unhandled Danger/Critical shows "No action yet"
  in warning style after 10 minutes. The **Action Log** tab lists all
  actions across alerts, newest first, filterable by personnel and action.
  Roles: admin, maintenance, security can act; everyone can view the log;
  admin sees unhandled highlights. Live alerts (no DB row yet) are upserted
  into `air_notifications` first by the server function, reusing the open
  row for the same device+sensor (partial unique index), so no duplicates.
  If a condition is still present after "Resolved", it keeps showing as
  "Resolved by [name] - condition still present".
- **(B) Manual SMS** — "Send SMS alert" (row + drawer) and "Send custom SMS"
  (page top), Administrator + Security only. Recipient checklist of active
  personnel with a contact number (masked, no-number rows disabled),
  severity preselect (Warning/High → Maintenance; Danger/Critical/Alarm →
  Maintenance + Security + Admin), editable prefilled message or empty
  custom text, character/segment counter, IPROG credits preview
  (`GET /api/v1/account/sms_credits`, block at 0, warn below count),
  confirm step, 30-minute cooldown with admin "Send anyway", per-recipient
  results, SMS Log tab with Resend on failed rows, and "SMS sent by [name]"
  recorded on the timeline. Sending happens **only** in the `send-sms`
  Edge Function; the browser never sees `IPROG_SMS_API_TOKEN`, and no SMS
  is sent from page load or any browser code. Recipients get a unique
  `action_token` (24h expiry) so `/action/<token>` works without login.
- **(C) `/action/<token>`** — public route (already in `src/App.tsx`:
  `/action/:token` outside ProtectedRoute) + `action-by-token` Edge
  Function (public, token-gated, service role server-side). It only ever
  operates on the token's own recipient row and records under that
  personnel's identity.

## 1. Database (once)

```bash
# Supabase Dashboard -> SQL Editor -> paste ALL of it -> Run
#   supabase/DEPLOY-ALERT-ACTIONS-SMS.sql
# (identical to supabase/migrations/20260919000000_alert_actions_sms.sql)
```

Or, with the Supabase CLI linked:

```bash
supabase db push
```

Also run `supabase/DEPLOY-AIR-NOTIFICATIONS.sql` first if the
`air_notifications` table does not exist yet (schema-cache error on the
Notifications page).

## 2. Edge Functions

No SMS is sent automatically from the browser. Auto SMS on new readings
still comes from `air-alerts` (readings webhook). The three functions
below must be deployed from this repo (`supabase/functions/`):

```bash
supabase functions deploy record-action
supabase functions deploy send-sms
supabase functions deploy action-by-token
```

| Function | Verify JWT | Purpose |
|---|---|---|
| `record-action` | **ON** (default) | Authenticated in-app actions. Validates the caller's JWT + profile, ensures the alert row, inserts the action, updates handled_by_*, notifies other personnel. |
| `send-sms` | **ON** (default) | Manual SMS. Validates admin/security, credits, cooldown; calls IPROG; writes `sms_logs` + `notification_recipients` (24h tokens). Body `{action:"credits"}` returns the IPROG balance. |
| `action-by-token` | **OFF** — Dashboard → Edge Functions → action-by-token → Settings → disable "Enforce JWT verification" | Public `/action/<token>` link. Token-gated; service role server-side only. |

Legacy `air-action` is superseded by `action-by-token` (same contract,
plus `repaired` and notify-all-personnel). You may delete `air-action`
after `action-by-token` is live; `ActionPage` now calls `action-by-token`.

## 3. Secrets

```bash
# SMS is provider-pluggable (default semaphore) — see docs/SMS-PROVIDER-DEPLOY.md
supabase secrets set SMS_PROVIDER=semaphore SEMAPHORE_API_KEY=your-semaphore-api-key
supabase secrets set IPROG_SMS_API_TOKEN=your-iprogsms-api-token
# IPROG_API_TOKEN is accepted as an alias if you already use that name.

# Movider (SMS_PROVIDER=movider) — secrets never reach the frontend:
supabase secrets set SMS_PROVIDER=movider MOVIDER_API_KEY=your-movider-api-key MOVIDER_API_SECRET=your-movider-api-secret
supabase secrets set MOVIDER_SENDER_NAME=MOVIDER   # optional, default MOVIDER

# Redeploy after setting/changing provider secrets:
supabase functions deploy send-sms
supabase functions deploy send-sms-alert   # also uses _shared/sms-provider.ts
supabase functions deploy air-alerts check-offline

# ERR_AUTHENTICATION_FAILED? Copy keys with the Copy button (never the masked
# value), re-set them, redeploy send-sms, then use the Admin-only
# "Test SMS connection" button on the Notifications page (balance endpoint
# only, no SMS sent). Full troubleshooting: docs/SMS-PROVIDER-DEPLOY.md §4.
# Already required by air-alerts:
supabase secrets set SUPABASE_URL=https://<project-ref>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
supabase secrets set APP_PUBLIC_URL=https://<your-public-app-url>
```

Get the IPROG token from iprogsms.com → Account → API token. Never put it
in `VITE_*` env vars or any frontend code.

## 4. Updated test plan (acceptance)

1. **Cross-user action visibility** — Log in as **Maintenance**. Open the
   bell, click **"On my way"** on the Hallway **Offline** alert (live
   alert → a row is upserted first). Confirm:
   - the row now shows "On my way - [Maintenance name] (Maintenance), [time]";
   - log in as **Admin**: the bell shows "[Name] took action: On my way -
     Hallway Offline", the Notifications row label and the detail timeline
     include the action; the dashboard Action Plan shows who is handling it;
     the Action Log tab lists it newest-first (filter by that personnel).
2. **Manual SMS to one number** — Log in as **Admin** (or Security).
   Notifications → **Send custom SMS** → select **one** personnel with a
   number → type a short message (e.g. "Please check Room 106") → Review →
   Send. Confirm:
   - results show Sent for that recipient;
   - the SMS Log tab (open any alert drawer, or check via the Action Log
     "SMS sent" entries) and **sms_logs** in Supabase show the row
     (`status=submitted`, provider_response);
   - the message appears in **iprogsms.com → SMS Messages** for that number.
   Sending to a failed number then shows a **Resend** button on its SMS Log
   row; resending creates a new sms_logs row for that recipient only.
3. **SMS action link** — On a phone (no login), open the `/action/<token>`
   link from an alert SMS. Tap **"On my way"** (or Acknowledge). Confirm the
   action is logged under the recipient's name in the timeline / Action Log,
   the alert's handled-by line updates for everyone, and an expired token
   (after 24h for manual SMS) shows "Link expired".
