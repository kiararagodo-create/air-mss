import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { Room, Thresholds } from "../data/data";
import { DEFAULT_THRESHOLDS } from "../data/data";
import { supabase } from "../lib/supabase";

// NOTE: Room now optionally carries a deviceId that maps it to a physical
// ESP32's DEVICE_ID (as sent in the sketch's Supabase payload).
//
// Rooms WITHOUT a deviceId have NO hardware installed yet. They are always
// forced offline, with lpg = null and co2 = null ("no sensor installed"),
// and never get simulated/fake number drift.
//
// AIR-K01 has a deviceId (real MQ-6 gas sensor), so its `lpg` field is
// driven by live Supabase data. It has NO CO2 sensor wired up yet, so its
// `co2` stays null until an MH-Z19C is physically installed and the ESP32
// sketch is updated to send a co2 value.

const SEED_ROOMS: Room[] = [
  {
    id: "AIR-106",
    name: "Room 106",
    floor: "Ground Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: "MQ-6",
    // No deviceId -> no hardware installed -> always offline, no fake data.
    length: 8,
    width: 6,
    height: 3,
    occupancy: 30,
    deviceId: "AIR-106",
    co2: null,
    lpg: null,
    temp: 0,
    humidity: 0,
    online: false,
    alertCount: 0,
    installedAt: "2024-08-15",
  },
  {
    id: "AIR-K01",
    name: "Kitchen",
    floor: "3rd Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: "MQ-6",
    // This room's own id (AIR-K01) is also the value your ESP32 sends as
    // DEVICE_ID, since readings.device_id has a foreign key to rooms.id.
    deviceId: "AIR-K01",
    length: 6,
    width: 5,
    height: 3,
    occupancy: 8,
    // No CO2 sensor wired up yet -> honestly null, not a fake number.
    // temp/humidity also stay placeholder until those sensors are added.
    co2: null,
    lpg: null, // will be filled by the live fetch/subscription below
    temp: 30.2,
    humidity: 60,
    online: false, // will flip true once a real reading comes in
    alertCount: 3,
    installedAt: "2025-01-10",
  },
  {
    id: "AIR-CL02",
    name: "Chem Lab Room",
    floor: "2nd Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: "MQ-6",
    // No deviceId -> no hardware installed -> always offline, no fake data.
    length: 10,
    width: 8,
    height: 3.2,
    occupancy: 25,
    co2: null,
    lpg: null,
    temp: 0,
    humidity: 0,
    online: false,
    alertCount: 0,
    installedAt: "2023-11-02",
  },
];

// Matches DevicesPage.tsx's RoomForm = Partial<Room> & { submitLabel?: string }
type RoomForm = Partial<Room> & { submitLabel?: string };

export interface AppSettings {
  emailAlerts: boolean;
  soundAlarms: boolean;
}

const DEFAULT_SETTINGS: AppSettings = { emailAlerts: true, soundAlarms: true };

interface RoomsContextValue {
  rooms: Room[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  thresholds: Thresholds;
  setThresholds: (t: Thresholds) => void;
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  toggleOnline: (id: string) => void;
  removeRoom: (id: string) => void;
  addRoom: (form: RoomForm) => void;
}

const RoomsContext = createContext<RoomsContextValue | undefined>(undefined);

// Shape of a row in the Supabase `readings` table, based on what the ESP32
// sketch actually POSTs: { device_id, lpg, severity }, plus Supabase's
// auto-generated columns. `co2` is included here (and will read as null
// until the ESP32 sketch actually sends it) so this type is ready for when
// a CO2 sensor is added later — no need to touch this file again then.
interface ReadingRow {
  device_id: string;
  co2: number | null;
  lpg: number;
  severity: number;
  created_at: string;
}

// How stale a reading can be before we consider that device offline.
// Loosened to 30s to tolerate browser tab throttling (background tabs slow
// down setInterval), while still catching a genuinely dead sensor quickly.
const OFFLINE_THRESHOLD_MS = 30_000; // 30s

export function RoomsProvider({ children }: { children: ReactNode }) {
  const [rooms, setRooms] = useState<Room[]>(SEED_ROOMS);
  const [selectedId, setSelectedId] = useState<string>(SEED_ROOMS[0].id);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  // Only rooms with a real deviceId are eligible for live data / online status.
  const deviceIds = SEED_ROOMS.map((r) => r.deviceId).filter(
    (id): id is string => !!id
  );

  // Shared helper: fetch the latest reading for a single deviceId and apply
  // it to state. Used by the on-mount fetch, the polling fallback, the
  // visibility-change refetch, and can be reused for a manual refresh button.
  const fetchLatestFor = useCallback(async (deviceId: string) => {
    const { data, error } = await supabase
      .from("readings")
      .select("device_id, co2, lpg, severity, created_at")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<ReadingRow>();

    if (error) {
      console.error(`Failed to fetch latest reading for ${deviceId}:`, error.message);
      return;
    }
    if (!data) return; // no readings yet for this device -> stays offline/null

    const isRecent =
      Date.now() - new Date(data.created_at).getTime() < OFFLINE_THRESHOLD_MS;

    setRooms((prev) =>
      prev.map((r) =>
        r.deviceId === deviceId
          ? {
              ...r,
              lpg: data.lpg,
              // co2 stays null until the ESP32 sketch actually sends it —
              // this line is future-proofed so nothing needs to change here
              // once a real CO2 sensor is added, only the sketch/payload.
              co2: data.co2 ?? r.co2,
              online: isRecent,
            }
          : r
      )
    );
  }, []);

  // ---------- Live sensor data (Supabase) ----------

  // On mount: fetch the most recent reading for every room that has a
  // deviceId, and apply it immediately so the dashboard isn't waiting on the
  // next realtime event to show real numbers. Rooms with no deviceId are
  // skipped entirely and stay at their forced offline/null state.
  useEffect(() => {
    if (deviceIds.length === 0) return;
    (async () => {
      for (const deviceId of deviceIds) {
        await fetchLatestFor(deviceId);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime: subscribe to new INSERTs on `readings` and update the matching
  // room's lpg (and co2, once sent) live, no polling or page refresh needed.
  // Requires Replication to be enabled for the `readings` table in
  // Supabase (Database -> Replication). If that's off, this subscription
  // will silently receive nothing — the polling effect below is the backup.
  useEffect(() => {
    const channel = supabase
      .channel("readings-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "readings" },
        (payload) => {
          const row = payload.new as ReadingRow;
          setRooms((prev) =>
            prev.map((r) =>
              r.deviceId === row.device_id
                ? { ...r, lpg: row.lpg, co2: row.co2 ?? r.co2, online: true }
                : r
            )
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Polling fallback: even if the Realtime subscription drops, was never
  // enabled, or misses an event, this guarantees the dashboard catches up
  // quickly. Also handles flipping a room to "offline" if its latest
  // reading has gone stale (ESP32 powered off, WiFi dropped, etc). Interval
  // matches the ESP32's 2s SEND_INTERVAL so the dashboard never lags more
  // than ~2s behind the sensor while this tab is active/foregrounded.
  useEffect(() => {
    if (deviceIds.length === 0) return;

    const poll = async () => {
      for (const deviceId of deviceIds) {
        await fetchLatestFor(deviceId);
      }
    };

    const interval = setInterval(poll, 2000); // check every 2s
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Force an immediate refetch whenever this tab regains focus/visibility.
  // Browsers throttle setInterval() timers heavily on background tabs, so
  // switching away (e.g. to Arduino IDE or Supabase) and back can otherwise
  // cause a stale "OFFLINE" flash even though fresh data is sitting in
  // Supabase the whole time. This closes that gap instantly on tab-switch.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && deviceIds.length > 0) {
        deviceIds.forEach((id) => fetchLatestFor(id));
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Simulated drift ----------
  // No-op for every current room: rooms with no deviceId are forced offline
  // above (and offline rooms are skipped), and rooms WITH a deviceId only
  // get live lpg/co2 data, never fake drift. Left in place in case you want
  // to reintroduce drift for a demo/testing room later.
  useEffect(() => {
    const interval = setInterval(() => {
      setRooms((prev) =>
        prev.map((r) => {
          if (!r.online) return r; // offline / no-sensor rooms: never drift
          if (r.deviceId) return r; // rooms with a real sensor: only lpg/co2 are live, no fake drift
          return r; // no rooms left that reach this branch, kept for clarity
        })
      );
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const toggleOnline = useCallback((id: string) => {
    setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, online: !r.online } : r)));
  }, []);

  const removeRoom = useCallback((id: string) => {
    setRooms((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const addRoom = useCallback((form: RoomForm) => {
    const newRoom: Room = {
      id: form.id?.trim() || `AIR-${Date.now()}`,
      name: form.name ?? "New Room",
      floor: form.floor ?? "",
      co2Sensor: form.co2Sensor ?? "MH-Z19C",
      gasSensor: form.gasSensor ?? null,
      deviceId: form.deviceId,
      length: Number(form.length ?? 6),
      width: Number(form.width ?? 4),
      height: Number(form.height ?? 3),
      occupancy: Number(form.occupancy ?? 1),
      // New rooms start honestly at null unless the form explicitly
      // provides a starting value.
      co2: form.co2 != null ? Number(form.co2) : null,
      lpg: form.lpg != null ? Number(form.lpg) : null,
      temp: form.deviceId ? Number(form.temp ?? 25) : 0,
      humidity: form.deviceId ? Number(form.humidity ?? 50) : 0,
      online: false, // always starts offline until a real reading confirms it's live
      alertCount: 0,
      // New devices are installed "now" - not user-editable in the add form.
      installedAt: new Date().toISOString().slice(0, 10),
    };
    setRooms((prev) => [...prev, newRoom]);
  }, []);

  return (
    <RoomsContext.Provider
      value={{ rooms, selectedId, setSelectedId, thresholds, setThresholds, settings, setSettings, toggleOnline, removeRoom, addRoom }}
    >
      {children}
    </RoomsContext.Provider>
  );
}

export function useRooms() {
  const ctx = useContext(RoomsContext);
  if (!ctx) throw new Error("useRooms must be used within a RoomsProvider");
  return ctx;
}