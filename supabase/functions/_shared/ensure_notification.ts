// Shared: turn a client-side "live alert" (computed from readings, no DB row
// yet) into a real public.air_notifications row, reusing the existing open
// row for the same device+sensor when one exists. Mirrors the dedup logic in
// air-alerts/index.ts upsertNotification() and the partial unique index
// air_notifications_one_open_per_device_sensor_level (open rows only).
//
// Service-role only: callers are Edge Functions, never the browser.

export interface LiveAlert {
  device_id: string;
  room_name?: string;
  floor?: string;
  sensor_type: string;
  level_label: string;
  severity: string;
  reading_value?: number | null;
  reading_unit?: string;
  message?: string;
}

export async function ensureNotification(
  admin: any,
  live: LiveAlert
): Promise<{ id: number; notification: any; created: boolean } | null> {
  if (!live.device_id || !live.sensor_type || !live.level_label) return null;

  // Room name/floor: prefer the caller's snapshot, fall back to rooms table.
  let room_name = live.room_name ?? "";
  let floor = live.floor ?? "";
  if (!room_name) {
    const { data: room } = await admin.from("rooms")
      .select("name, floor").eq("id", live.device_id).maybeSingle();
    room_name = room?.name ?? live.device_id;
    floor = room?.floor ?? floor;
  }

  const { data: existing } = await admin.from("air_notifications")
    .select("*")
    .eq("device_id", live.device_id)
    .eq("sensor_type", live.sensor_type)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (existing.level_label === live.level_label) {
      const patch: any = {};
      if (live.reading_value != null) patch.reading_value = live.reading_value;
      if (live.message) patch.message = live.message;
      if (Object.keys(patch).length) {
        await admin.from("air_notifications").update(patch).eq("id", existing.id);
        existing.reading_value = patch.reading_value ?? existing.reading_value;
        existing.message = patch.message ?? existing.message;
      }
      return { id: existing.id, notification: existing, created: false };
    }
    // Level changed: resolve the old open row, insert the new one.
    await admin.from("air_notifications")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Escalated to " + live.level_label })
      .eq("id", existing.id);
    const { data: inserted, error: insErr } = await admin.from("air_notifications").insert({
      device_id: live.device_id,
      room_name,
      floor,
      sensor_type: live.sensor_type,
      level_label: live.level_label,
      severity: live.severity || "warning",
      reading_value: live.reading_value ?? null,
      reading_unit: live.reading_unit ?? "",
      message: live.message ?? "",
      status: "open",
      escalation_of: existing.id,
    }).select("*").single();
    if (insErr || !inserted) return null;
    return { id: inserted.id, notification: inserted, created: true };
  }

  const { data: inserted, error } = await admin.from("air_notifications").insert({
    device_id: live.device_id,
    room_name,
    floor,
    sensor_type: live.sensor_type,
    level_label: live.level_label,
    severity: live.severity || "warning",
    reading_value: live.reading_value ?? null,
    reading_unit: live.reading_unit ?? "",
    message: live.message ?? "",
    status: "open",
  }).select("*").single();
  if (error || !inserted) return null;
  return { id: inserted.id, notification: inserted, created: true };
}

/** Resolve which row an action/SMS refers to: explicit id, else ensure from live. */
export async function resolveNotification(
  admin: any,
  notificationId: number | null | undefined,
  live: LiveAlert | null | undefined
): Promise<{ id: number; notification: any } | null> {
  if (notificationId) {
    const { data: n } = await admin.from("air_notifications")
      .select("*").eq("id", notificationId).maybeSingle();
    if (n) return { id: n.id, notification: n };
  }
  if (live) {
    const ensured = await ensureNotification(admin, live);
    if (ensured) return { id: ensured.id, notification: ensured.notification };
  }
  return null;
}

/** Authenticate the caller from the JWT and return their approved profile. */
export async function callerProfile(admin: any, req: Request): Promise<any | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data: userData, error } = await admin.auth.getUser(jwt);
  if (error || !userData?.user) return null;
  const { data: profile } = await admin.from("profiles")
    .select("*").eq("id", userData.user.id).maybeSingle();
  if (!profile || !profile.is_active) return null;
  if (profile.role !== "admin" && profile.account_status !== "approved") return null;
  return profile;
}

export const ACTION_ROLES = ["admin", "maintenance", "security"];

export function actionPatch(action: string, note: string | null, profile: any, takenAt: string) {
  const patch: any = {
    handled_by_id: profile.id,
    handled_by_name: profile.name,
    handled_by_role: profile.role,
    handled_at: takenAt,
  };
  if (action === "resolved" || action === "false_alarm" || action === "repaired") {
    patch.status = "resolved";
    patch.resolved_at = takenAt;
    patch.resolution_note = note ||
      (action === "false_alarm" ? "Marked as false alarm" : action === "repaired" ? "Marked as repaired" : "Resolved");
  } else if (action === "acknowledge" || action === "on_my_way") {
    patch.status = "acknowledged";
  }
  return patch;
}

/** Tell every other active personnel member (bell mailbox, realtime). */
export async function notifyPersonnel(admin: any, exceptUserId: string, title: string, body: string) {
  const { data: people } = await admin.from("profiles")
    .select("id").eq("is_active", true).neq("id", exceptUserId);
  for (const p of ((people as any[]) ?? [])) {
    await admin.from("notifications").insert({
      user_id: p.id, kind: "alert_action", title, body,
    });
  }
}
