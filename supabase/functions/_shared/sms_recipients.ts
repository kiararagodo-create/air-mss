/**
 * sms_recipients - decides who may receive an automatic SMS.
 *
 * Eligible when ALL are true:
 *   - profiles.is_active = true
 *   - profiles.account_status = 'approved' (admin role allowed)
 *   - profiles.sms_enabled = true
 *   - profiles.contact_number is a valid Philippine mobile number (09XXXXXXXXX, 11 digits)
 *   - alert severity meets per-personnel sms_min_severity ('warning' = warning+, 'danger' = danger/critical only)
 *
 * Two profiles with the same normalized number are texted once.
 */

export interface SmsRecipient {
  id: string;
  name: string;
  role: string;
  contact_number: string; // normalized +639XXXXXXXXX for storage/logging; provider normalizes for send
  sms_min_severity: "warning" | "danger";
}

function digitsOnly(raw: unknown): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/** Valid PH mobile for SMS sending per product rule: 11 digits starting with 09. */
export function isValidPhMobile(raw: unknown): boolean {
  const d = digitsOnly(raw);
  return /^09\d{9}$/.test(d);
}

/** Normalize valid PH mobile to +639XXXXXXXXX. Returns null if invalid. */
export function normalizePhSmsNumber(raw: unknown): string | null {
  const d = digitsOnly(raw);
  if (!/^09\d{9}$/.test(d)) return null;
  return `+63${d.slice(1)}`;
}

export function phoneKey(raw: unknown): string {
  const d = digitsOnly(raw);
  if (/^09\d{9}$/.test(d)) return "63" + d.slice(1);
  if (/^639\d{9}$/.test(d)) return d;
  return d;
}

function alertRank(severity: string, levelLabel: string): number {
  const sev = String(severity ?? "").toLowerCase();
  const lbl = String(levelLabel ?? "").toLowerCase();
  if (sev === "critical" || lbl === "critical" || lbl === "offline") return 4;
  if (sev === "danger" || lbl === "danger" || lbl === "freeze" || lbl === "heat" || lbl === "dry" || lbl === "mold risk") return 3;
  if (sev === "high" || lbl === "high" || lbl === "alarm") return 2;
  if (sev === "warning" || lbl === "warning" || lbl === "low leak" || lbl === "cool" || lbl === "low") return 1;
  return 0;
}

function meetsMinSeverity(min: string | null | undefined, severity: string, levelLabel: string): boolean {
  const m = (min === "danger") ? "danger" : "warning"; // default warning and up
  const rank = alertRank(severity, levelLabel);
  if (m === "danger") return rank >= 3; // danger/critical/offline treated as urgent
  return rank >= 1; // warning and up
}

export async function getSmsRecipients(
  admin: any,
  opts?: { roles?: string[] | null; severity?: string; levelLabel?: string }
): Promise<SmsRecipient[]> {
  let q = admin
    .from("profiles")
    .select("id, name, role, contact_number, account_status, sms_enabled, is_active, sms_min_severity")
    .eq("is_active", true)
    .eq("sms_enabled", true);
  const roles = opts?.roles ?? null;
  if (roles && roles.length > 0) q = q.in("role", roles);

  const queryDesc = `select id,name,role,contact_number,account_status,sms_enabled,is_active,sms_min_severity from public.profiles where is_active=true and sms_enabled=true${roles && roles.length ? ` and role in (${roles.join(",")})` : ""}`;
  const { data, error } = await q;
  if (error) {
    const msg = `DB query failed: ${queryDesc} :: ${error.message}`;
    console.error(`[sms_recipients] ${msg}`, error);
    throw new Error(msg);
  }

  const seen = new Set<string>();
  const out: SmsRecipient[] = [];
  for (const r of (data as any[]) ?? []) {
    const approved = r.role === "admin" || r.account_status === "approved";
    if (!approved) continue;
    if (!isValidPhMobile(r.contact_number)) continue;
    if (opts?.severity || opts?.levelLabel) {
      if (!meetsMinSeverity(r.sms_min_severity, String(opts?.severity ?? ""), String(opts?.levelLabel ?? ""))) continue;
    }
    const normalized = normalizePhSmsNumber(r.contact_number);
    if (!normalized) continue;
    const key = phoneKey(r.contact_number);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      name: r.name ?? "",
      role: r.role ?? "",
      contact_number: normalized,
      sms_min_severity: r.sms_min_severity === "danger" ? "danger" : "warning",
    });
  }
  return out;
}
