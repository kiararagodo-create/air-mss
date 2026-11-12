# SMS provider-pluggable deploy (Semaphore / PhilSMS / IPROG / Movider)

All SMS sending — manual (`send-sms`), automatic alerts (`air-alerts`),
legacy webhook (`send-sms-alert`) — goes through one adapter layer:
`supabase/functions/_shared/sms-provider.ts`, function
`sendSms({ to, message }) -> { ok, provider, providerMessageId, status, raw, error }`.
The active provider is picked by the `SMS_PROVIDER` secret (**default
`semaphore`**, so a fresh deploy works with only Semaphore secrets set).
Provider API keys stay in Edge Function secrets and never reach the browser.

## Provider adapters (official docs)

| Provider | Send | Auth | Number format | Balance |
|---|---|---|---|---|
| **Semaphore** (default) | `POST https://api.semaphore.co/api/v4/messages` (form: `apikey`, `number`, `message`, `sendername?`) | `SEMAPHORE_API_KEY` form field; optional `SEMAPHORE_SENDER_NAME` | `09XXXXXXXXX` | `GET /api/v4/account` → `credit_balance` |
| **PhilSMS** | `POST https://app.philsms.com/api/v3/sms/send` (JSON: `recipient`, `sender_id`, `type: plain|unicode`, `message`) | `Authorization: Bearer PHILSMS_API_TOKEN` | `639XXXXXXXXX` | `GET /api/v3/balance` (Bearer) |
| **IPROG** | `POST https://sms.iprogtech.com/api/v1/sms_messages` (JSON: `api_token`, `phone_number`, `message`) | `IPROG_API_TOKEN` (legacy alias `IPROG_SMS_API_TOKEN` still works) | `639XXXXXXXXX` | `GET /api/v1/account/sms_credits` → `data.load_balance` |
| **Movider** | `POST https://api.movider.co/v1/sms` (form: `api_key`, `api_secret`, `to`, `text`, `from?`) | `MOVIDER_API_KEY` + `MOVIDER_API_SECRET`; optional `MOVIDER_SENDER_NAME` (default `MOVIDER`) | `639XXXXXXXXX` (E.164, no `+`) | `POST /v1/balance` (form `api_key`+`api_secret`) → `amount` |

Docs: Semaphore https://api.semaphore.co/docs ·
PhilSMS https://app.philsms.com/developers/documentation ·
IPROG https://sms.iprogtech.com/api/v1/documentation ·
Movider https://developer.movider.co/reference/sms and
https://developer.movider.co/reference/balance (movider.co).
Movider success = the number appears in the response's
`phone_number_list` (sent list); failure = it appears in
`bad_phone_number_list` (failed list) or an `error` is returned — the raw
response is stored in `sms_logs.provider_response`.

PhilSMS `sender_id` is **required** by their API (max 11 chars): set
`PHILSMS_SENDER_ID` to your registered sender ID; it defaults to
`PhilSMS` when unset. Numbers are normalized per provider
(`09…` for Semaphore, `639…` for PhilSMS/IPROG) inside the adapter, so
stored `09…` numbers work with all three.

## 1. Database (once)

Supabase Dashboard → SQL Editor → paste all of
`supabase/DEPLOY-SMS-PROVIDER.sql` → Run (adds `provider`,
`provider_message_id`, `provider_status` to `sms_logs` and `provider` to
legacy `alert_log`).

## 2. Secrets

```bash
# Semaphore (default provider)
supabase secrets set SMS_PROVIDER=semaphore SEMAPHORE_API_KEY=your-semaphore-api-key
supabase secrets set SEMAPHORE_SENDER_NAME=AIR            # optional

# PhilSMS (only if SMS_PROVIDER=philsms)
supabase secrets set SMS_PROVIDER=philsms PHILSMS_API_TOKEN=your-philsms-api-token
supabase secrets set PHILSMS_SENDER_ID=YourName           # optional, default PhilSMS

# IPROG (only if SMS_PROVIDER=iprog)
supabase secrets set SMS_PROVIDER=iprog IPROG_API_TOKEN=your-iprogsms-api-token

# Movider (only if SMS_PROVIDER=movider)
supabase secrets set SMS_PROVIDER=movider MOVIDER_API_KEY=your-movider-api-key MOVIDER_API_SECRET=your-movider-api-secret
supabase secrets set MOVIDER_SENDER_NAME=MOVIDER   # optional, default MOVIDER

# Test without spending credits (logs attempts, reports success, no provider call)
supabase secrets set DRY_RUN=true
```

## 3. Deploy the functions

```bash
supabase functions deploy send-sms
supabase functions deploy air-alerts
supabase functions deploy send-sms-alert   # also uses _shared/sms-provider.ts
supabase functions deploy check-offline
```

Switching providers later = change `SMS_PROVIDER` + redeploy the function(s)
above; no code or frontend change needed. The Send SMS dialog shows the
active provider name (from the `send-sms` credits response) and the
Administrator sees a warning when the balance is below the message count
(sending is blocked at a known balance of 0; an unknown balance never blocks).

## 4. Verify

1. Notifications page (Administrator) → **Test SMS connection**: balance
   endpoint only, no SMS sent. Shows "Connected, balance X" or the exact
   Movider error. The Send SMS dialog also shows "via <provider>" and
   its credit balance, and blocks sending with a clear message when
   credentials are proven wrong.
2. Send a custom SMS to one number → `sms_logs` row has `provider`,
   `provider_message_id`, `provider_status` and the raw provider response
   in `provider_response`; the message appears in the provider's own
   message history.
3. With `DRY_RUN=true`, repeat: the row is logged with status
   `submitted` / provider_status `dry_run` and nothing is sent.

## Troubleshoot: ERR_AUTHENTICATION_FAILED (Movider)

Movider error 403 = the `api_key` + `api_secret` combination is wrong
(developer.movider.co/reference/api-error-codes). The adapter matches the
docs exactly (`POST /v1/sms`, form-encoded `api_key, api_secret, to,
text, from`), so this means the **secrets in Supabase are wrong or stale**:

1. Movider dashboard → Settings → API Settings: click the eye icon to
   reveal each value, then use its **Copy** button (never copy the
   masked `••••` value, and never type it from memory).
2. Re-set and redeploy (secrets alone do not reliably update a deployed
   function):

```bash
supabase secrets set SMS_PROVIDER=movider MOVIDER_API_KEY=<copied-key> MOVIDER_API_SECRET=<copied-secret>
supabase functions deploy send-sms
supabase functions deploy send-sms-alert   # also uses _shared/sms-provider.ts
supabase functions deploy air-alerts check-offline
```

3. Check `send-sms` logs (Supabase Dashboard → Edge Functions → send-sms →
   Logs): each send/balance call logs
   `api_key=abcd•••ef (len N) api_secret_len=N format=application/x-www-form-urlencoded`
   — the length tells you if a value was truncated or masked
   (`len` much shorter than the Movider value = partial copy / quotes
   pasted in; the adapter already strips surrounding quotes/angle
   brackets and trims whitespace, and rejects empty values with
   "MOVIDER_API_KEY / MOVIDER_API_SECRET is not set").
4. Sender: `MOVIDER_SENDER_NAME` defaults to `MOVIDER` and Movider
   sender names are **case-sensitive** — it must exactly match a sender
   registered in Movider, or remove the secret to use the default sender.
5. Re-run **Test SMS connection** (Admin, Notifications page) — it hits
   only `POST /v1/balance`, so a wrong key fails there in seconds
   without sending (or spending) anything.
