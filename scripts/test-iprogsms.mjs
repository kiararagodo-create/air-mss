#!/usr/bin/env node
/**
 * Standalone iProgSMS connectivity test (same endpoint/payload as server).
 * Usage:
 *   node scripts/test-iprogsms.mjs --number 09171234567
 *   node scripts/test-iprogsms.mjs --number 09171234567 --send "A.I.R. test"
 * Env: IPROG_SMS_API_TOKEN (required), IPROG_SMS_API_URL (optional)
 */
import process from "node:process";

const ENDPOINT = (process.env.IPROG_SMS_API_URL || "https://sms.iprogtech.com/api/v1/sms_messages").trim();
const TOKEN = (process.env.IPROG_SMS_API_TOKEN || process.env.IPROG_API_TOKEN || "").trim();
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

function normalizePhTo639(input) {
  let d = String(input ?? "").replace(/\D/g, "");
  if (d.startsWith("63")) d = "0" + d.slice(2);
  if (/^9\d{9}$/.test(d)) d = "0" + d;
  if (!/^09\d{9}$/.test(d)) return null;
  return "63" + d.slice(1);
}

async function credits() {
  const url = new URL(ENDPOINT.replace(/\/$/, ""));
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/sms_messages") ? path.replace(/\/sms_messages$/, "/account/sms_credits") : `${path}/account/sms_credits`;
  const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${TOKEN}` } });
  const body = await res.text();
  console.log("credits status", res.status, body.slice(0, 400));
}

async function send(to639, message) {
  const payload = { api_token: TOKEN, phone_number: to639, message };
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(payload) });
  const body = await res.text();
  console.log("send status", res.status);
  console.log(body.slice(0, 800));
}

if (!TOKEN) { console.error("Missing IPROG_SMS_API_TOKEN"); process.exit(2); }
const num = normalizePhTo639(arg("--number"));
if (!num) { console.error("Provide --number 09XXXXXXXXX (PH mobile)"); process.exit(2); }
const msg = arg("--send");
await credits();
if (msg) await send(num, msg);
else console.log("Dry check only (no SMS sent). Pass --send \"text\" to send a real message to", num);
