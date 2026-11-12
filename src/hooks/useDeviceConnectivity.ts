// src/hooks/useDeviceConnectivity.ts
//
// The one shared connectivity helper. Every online/offline indicator in the
// app - the Monitored Rooms list on the dashboard, the Devices page, the
// summary counts - reads through this hook so they cannot drift apart.
//
// Two things it guarantees:
//
//   * the threshold comes from the shared config module the check-offline
//     function and the offline SMS also use (see src/lib/deviceConnectivity.ts),
//     so the dashboard and the SMS always agree;
//   * the labels are live. One module-level clock ticks every 15s and every
//     subscriber re-renders, so "Last seen 2 min ago" counts up and a device
//     flips to Offline without a page refresh - even if the realtime stream is
//     quiet. The ticker stops when the last subscriber unmounts.

import { useSyncExternalStore } from "react";
import {
  ageOf,
  formatManilaClock,
  formatRelativeAge,
  isDeviceOnline,
} from "../lib/deviceConnectivity";

/** How often the labels and the online/offline state are re-evaluated. */
const TICK_MS = 15_000;

let currentTick = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      currentTick = Date.now();
      listeners.forEach((notify) => notify());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return currentTick;
}

/** Shared clock tick. Re-renders on every tick, so relative times stay true. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface DeviceConnectivity {
  /** True when the newest signal is inside the shared offline threshold. */
  online: boolean;
  /** Age of the newest signal in ms, or null when the device never reported. */
  ageMs: number | null;
  /** The newest signal itself (reading created_at, or rooms.last_seen). */
  lastSeenAt: string | null;
  /** "Last seen 2 min ago", or "No reading yet" when there is nothing to show. */
  lastSeenLabel: string;
  /** "Offline since 2:11 PM" (Asia/Manila). Null while the device is online. */
  offlineSinceLabel: string | null;
}

/**
 * Connectivity for one device, derived from the timestamp of its newest
 * signal and the shared offline threshold.
 *
 * Pass the room's newest signal (RoomsContext keeps it in `lastReadingAt`);
 * the hook does the rest and keeps re-evaluating while it is mounted.
 */
export function useDeviceConnectivity(lastSeenAt: string | null | undefined): DeviceConnectivity {
  const now = useNow();
  const iso = lastSeenAt ?? null;
  const online = isDeviceOnline(iso, now);
  const ageMs = iso ? ageOf(iso, now) : null;
  const usable = iso !== null && ageMs !== null && Number.isFinite(ageMs);

  return {
    online,
    ageMs: usable ? ageMs : null,
    lastSeenAt: iso,
    lastSeenLabel: usable ? `Last seen ${formatRelativeAge(ageMs as number)}` : "No reading yet",
    offlineSinceLabel: !online && usable ? `Offline since ${formatManilaClock(iso as string, now)}` : null,
  };
}
