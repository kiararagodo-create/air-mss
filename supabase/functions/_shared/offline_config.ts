// Single source of truth for "how stale is too stale" - the device offline
// threshold.
//
// A device is ONLINE when its newest signal (the newest row in public.readings
// for its device_id, or rooms.last_seen when that column carries a newer
// timestamp) is younger than this threshold; otherwise it is OFFLINE.
//
// Normal readings arrive about once a minute per device, so the default is
// 3 minutes. Nothing may configure a value below MIN_OFFLINE_AFTER_S (2
// minutes): a shorter window would flip a perfectly healthy device offline
// between two of its own polls, and a device that flaps is a device nobody
// believes.
//
// This file is imported from BOTH sides of the system:
//
//   * supabase/functions/air-alerts/index.ts - the check-offline sweep and
//     the offline/online SMS. (check-offline delegates to that function.)
//   * src/lib/deviceConnectivity.ts         - the dashboard's room cards,
//     Devices page and summary counts.
//
// so the dashboard and the SMS can never disagree about whether a device is
// offline. Keep every consumer importing from here; do not restate 180 (or
// any other number) in a second place.

/** Default staleness before a device counts as offline: 3 minutes. */
export const DEFAULT_OFFLINE_AFTER_S = 180;

/** Hard floor: never treat a device as offline sooner than 2 minutes. */
export const MIN_OFFLINE_AFTER_S = 120;

/** The same threshold in milliseconds, for the browser side. */
export const OFFLINE_THRESHOLD_MS = DEFAULT_OFFLINE_AFTER_S * 1000;

/**
 * Clamp a candidate threshold (seconds) to the floor.
 *
 * Kept as a function so any future override - an environment variable, a
 * settings row - is validated in one place instead of being trusted at the
 * call site, where a value of 60 would silently make the server page
 * personnel for a device that is merely between polls.
 */
export function clampOfflineAfterSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_OFFLINE_AFTER_S;
  return Math.max(MIN_OFFLINE_AFTER_S, Math.round(seconds));
}

/** The threshold in whole minutes, for copy such as "no reading for 3 min". */
export const OFFLINE_AFTER_MINUTES = Math.round(DEFAULT_OFFLINE_AFTER_S / 60);
