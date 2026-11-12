// src/lib/deviceConnectivity.ts
//
// The browser side of "is this device online?".
//
// The number that decides it - the offline threshold - is NOT defined here. It
// comes from supabase/functions/_shared/offline_config.ts, the same module the
// check-offline sweep and the offline SMS import, so the pill on a room card
// and the text of an SMS can never disagree about a device.
//
// Everything here is pure: given a timestamp and a clock, it answers. The
// ticking clock itself lives in src/hooks/useDeviceConnectivity.ts.

import {
  DEFAULT_OFFLINE_AFTER_S,
  MIN_OFFLINE_AFTER_S,
  OFFLINE_AFTER_MINUTES,
  OFFLINE_THRESHOLD_MS,
} from "../../supabase/functions/_shared/offline_config";

export {
  DEFAULT_OFFLINE_AFTER_S,
  MIN_OFFLINE_AFTER_S,
  OFFLINE_AFTER_MINUTES,
  OFFLINE_THRESHOLD_MS,
};

/**
 * How far into the future a reading may be dated and still count as fresh.
 *
 * `created_at` is written by the database but travels through an ESP32 with no
 * RTC and a browser clock; either can drift. Without this lower bound a device
 * whose clock runs fast reads as permanently online - including one that died
 * weeks ago, because its age never becomes positive.
 */
export const MAX_FUTURE_SKEW_MS = 60_000;

/**
 * True when `lastSeenAt` is young enough that its device counts as online.
 *
 * `now` is injectable so every consumer - the pill, the summary counts, the
 * staleness timer - evaluates the same timestamp against the same clock tick
 * instead of each calling Date.now() a few milliseconds apart.
 */
export function isDeviceOnline(lastSeenAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const then = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(then)) return false;
  const age = now - then;
  return age < OFFLINE_THRESHOLD_MS && age > -MAX_FUTURE_SKEW_MS;
}

/** Age of a timestamp in whole milliseconds, floored at 0 for future dates. */
export function ageOf(iso: string, now: number = Date.now()): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return Number.NaN;
  return Math.max(0, now - then);
}

/**
 * The newest non-null timestamp among the candidates.
 *
 * Used to combine `rooms.last_seen` (when that column is maintained) with the
 * newest row in `readings` for the same device: whichever of the two is more
 * recent is the device's actual last signal.
 */
export function newestTimestamp(...candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const c of candidates) {
    if (!c) continue;
    const ms = new Date(c).getTime();
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = c;
    }
  }
  return best;
}

/**
 * The newest signal a Room has produced - what every online/offline indicator
 * should be handed. Prefers `lastSeenAt` (which RoomsContext keeps at
 * max(rooms.last_seen, newest reading)) and falls back to `lastReadingAt` for
 * Room objects built elsewhere, such as from a notification row.
 */
export function roomLastSeen(room: {
  lastSeenAt?: string | null;
  lastReadingAt?: string | null;
}): string | null {
  return newestTimestamp(room.lastSeenAt, room.lastReadingAt);
}

/**
 * Compact relative age: "just now", "42 sec ago", "2 min ago", "3 hr ago",
 * "2 d ago". Deliberately coarse - the number under a room name is there to say
 * "this is current" or "this is stale", not to be a stopwatch.
 */
export function formatRelativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
  const s = Math.floor(ageMs / 1000);
  if (s < 15) return "just now";
  if (s < 60) return `${s} sec ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * "2:11 PM" in Asia/Manila, prefixed with the date when the timestamp is not
 * from today - "Offline since 2:11 PM" is only unambiguous for a device that
 * went quiet today.
 */
export function formatManilaClock(iso: string, now: number = Date.now()): string {
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return "unknown time";
  const time = then.toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const sameDay = then.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }) ===
    new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  if (sameDay) return time;
  const date = then.toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
  });
  return `${date}, ${time}`;
}
