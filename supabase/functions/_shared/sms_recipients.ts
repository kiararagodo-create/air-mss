/**
 * sms_recipients - the ONE place that decides who may receive an SMS.
 *
 * Every function that sends SMS (alarm, acknowledged, resolved, offline,
 * all clear) must get its recipient list from getSmsRecipients(). A person
 * receives texts only when ALL of these are true:
 *   - profiles.is_active = true
 *   - profiles.account_status = 'approved'
 *   - profiles.sms_enabled = true   (the per-person switch on Personnel page)
 *   - profiles.contact_number is a valid Philippine mobile number
 * Two profiles with the same number are texted once.
 */

export interface SmsRecipient {
  id: string;
  name: string;
  role: string;
  contact_number: string;
}

/** Digits only: "+63 927-215-3290" -> "639272153290". */
function digitsOnly(raw: unknown): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * Valid Philippine mobile numbers: 09XXXXXXXXX (11 digits),
 * 639XXXXXXXXX (12 digits, with or without +), or 9XXXXXXXXX (10 digits).
 */
export function isValidPhMobile(raw: unknown): boolean {
  return /^(09\d{9}|639\d{9}|9\d{9})$/.test(digitsOnly(raw));
}

/** Same number in any format gives the same key: "639XXXXXXXXX". */
export function phoneKey(raw: unknown): string {
  const d = digitsOnly(raw);
  if (/^09\d{9}$/.test(d)) return "63" + d.slice(1);
  if (/^9\d{9}$/.test(d)) return "63" + d;
  return d;
}

export async function getSmsRecipients(admin: any): Promise<SmsRecipient[]> {
  const { data, error } = await admin
    .from("profiles")
    .select("id, name, role, contact_number")
    .eq("is_active", true)
    .eq("account_status", "approved")
    .eq("sms_enabled", true);

  if (error) {
    console.error("getSmsRecipients failed:", error.message);
    return [];
  }

  const seen = new Set<string>();
  const out: SmsRecipient[] = [];
  for (const r of (data as any[]) ?? []) {
    if (!isValidPhMobile(r.contact_number)) continue;
    const key = phoneKey(r.contact_number);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      name: r.name ?? "",
      role: r.role ?? "",
      contact_number: String(r.contact_number).trim(),
    });
  }
  return out;
}
