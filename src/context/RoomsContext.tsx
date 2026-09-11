import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { Room, Thresholds } from "../data/Data";
import { DEFAULT_THRESHOLDS } from "../data/Data";
import { supabase } from "../lib/supabase";

// Matches DevicesPage.tsx's RoomForm = Partial<Room> & { submitLabel?: string }
type RoomForm = Partial<Room> & { submitLabel?: string };

export interface AppSettings {}

const DEFAULT_SETTINGS: AppSettings = {};

interface RoomsContextValue {
  rooms: Room[];
  loading: boolean;
  selectedId: string;
  setSelectedId: (id: string) => void;
  thresholds: Thresholds;
  setThresholds: (t: Thresholds) => void;
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
  toggleOnline: (id: string) => void;
  removeRoom: (id: string) => Promise<void>;
  addRoom: (form: RoomForm) => Promise<{ error: string | null }>;
  toggleSiren: (id: string) => Promise<void>;
  muteAll: (muted: boolean) => Promise<void>;
}

const RoomsContext = createContext<RoomsContextValue | undefined>(undefined);

// ---------- Supabase "rooms" row <-> Room mapping ----------
// rooms table columns: id, name, floor, sensor (legacy combined field, kept
// but unused), co2_sensor, gas_sensor, temp_humidity_sensor, length, width,
// height, co2, lpg, alert_count, last_seen, created_at,
// installed_at, siren_muted. temp/humidity/online are NOT stored here - they
// come live from the "readings" table below, keyed by device_id = room id.
interface RoomRow {
  id: string;
  name: string;
  floor: string;
  co2_sensor: string | null;
  gas_sensor: string | null;
  temp_humidity_sensor: string | null;
  length: number;
  width: number;
  height: number;
  co2: number | null;
  lpg: number | null;
  alert_count: number | null;
  installed_at: string | null;
  siren_muted: boolean | null;
}

function rowToRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    floor: row.floor,
    co2Sensor: row.co2_sensor ?? "",
    gasSensor: row.gas_sensor,
    tempHumiditySensor: row.temp_humidity_sensor,
    // Every registered room is its own live device: the ESP32 sends
    // readings.device_id = rooms.id directly.
    deviceId: row.id,
    length: row.length,
    width: row.width,
    height: row.height,
    co2: row.co2,
    lpg: row.lpg,
    // Placeholder until the readings fetch/subscription below fills these
    // in for real, per-device.
    temp: 0,
    humidity: 0,
    online: false,
    alertCount: row.alert_count ?? 0,
    installedAt: row.installed_at ?? new Date().toISOString().slice(0, 10),
    sirenMuted: row.siren_muted ?? false,
  };
}

function roomToInsertRow(form: RoomForm) {
  return {
    id: form.id?.trim(),
    name: form.name ?? "New Room",
    floor: form.floor ?? "",
    co2_sensor: form.co2Sensor ?? "MH-Z19C",
    gas_sensor: form.gasSensor ?? null,
    temp_humidity_sensor: form.tempHumiditySensor ?? null,
    length: Number(form.length ?? 6),
    width: Number(form.width ?? 4),
    height: Number(form.height ?? 3),
    co2: form.co2 != null ? Number(form.co2) : null,
    lpg: form.lpg != null ? Number(form.lpg) : null,
    alert_count: 0,
    installed_at: new Date().toISOString().slice(0, 10),
    // siren_muted has a DB default of false, so it's fine to omit here -
    // included explicitly for clarity.
    siren_muted: false,
  };
}

// Shape of a row in the Supabase `readings` table, based on what the ESP32
// sketch actually POSTs: { device_id, lpg, severity }, plus Supabase's
// auto-generated columns.
interface ReadingRow {
  device_id: string;
  co2: number | null;
  lpg: number;
  temp: number | null;
  humidity: number | null;
  severity: number;
  created_at: string;
}

// How stale a reading can be before we consider that device offline.
const OFFLINE_THRESHOLD_MS = 30_000; // 30s

export function RoomsProvider({ children }: { children: ReactNode }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>("");
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  // ---------- Persistent safety thresholds (Supabase "platform_thresholds") ----------
  // The Settings page lets admins adjust CO2 / LPG / DHT22 temp / DHT22
  // humidity tiers. These used to live only in React state and reset to
  // DEFAULT_THRESHOLDS on every reload - now they're backed by a single
  // canonical row in the platform_thresholds table so they survive across
  // sessions and tabs.

  function rowToThresholds(row: {
    co2_warning: number; co2_high: number; co2_danger: number;
    lpg_warning: number; lpg_high: number; lpg_danger: number;
    temp_freeze_below: number; temp_cool_below: number; temp_heat_above: number;
    humidity_dry_below: number; humidity_low_below: number; humidity_mold_above: number;
  }): Thresholds {
    return {
      co2: { warning: row.co2_warning, high: row.co2_high, danger: row.co2_danger },
      lpg: { warning: row.lpg_warning, high: row.lpg_high, danger: row.lpg_danger },
      temp: { freezeBelow: row.temp_freeze_below, coolBelow: row.temp_cool_below, heatAbove: row.temp_heat_above },
      humidity: { dryBelow: row.humidity_dry_below, lowBelow: row.humidity_low_below, moldAbove: row.humidity_mold_above },
    };
  }

  async function loadThresholds(): Promise<Thresholds> {
    const { data, error } = await supabase
      .from("platform_thresholds")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      console.error("Failed to load platform thresholds:", error.message);
      return DEFAULT_THRESHOLDS;
    }
    if (!data) return DEFAULT_THRESHOLDS;
    return rowToThresholds(data as any);
  }

  async function persistThresholds(next: Thresholds): Promise<void> {
    const row = {
      id: 1,
      co2_warning: next.co2.warning,
      co2_high: next.co2.high,
      co2_danger: next.co2.danger,
      lpg_warning: next.lpg.warning,
      lpg_high: next.lpg.high,
      lpg_danger: next.lpg.danger,
      temp_freeze_below: next.temp.freezeBelow,
      temp_cool_below: next.temp.coolBelow,
      temp_heat_above: next.temp.heatAbove,
      humidity_dry_below: next.humidity.dryBelow,
      humidity_low_below: next.humidity.lowBelow,
      humidity_mold_above: next.humidity.moldAbove,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("platform_thresholds")
      .upsert(row, { onConflict: "id" });
    if (error) {
      console.error("Failed to persist platform thresholds:", error.message);
    }
  }

  // Override setThresholds so every update is also written back to the DB.
  const setThresholdsPersist = useCallback((next: Thresholds) => {
    setThresholds(next);
    persistThresholds(next);
  }, []);

  // ---------- Room registry (Supabase "rooms" table) ----------

  const refreshRooms = useCallback(async () => {
    const { data, error } = await supabase.from("rooms").select("*");
    if (error) {
      console.error("Failed to fetch rooms:", error.message);
      return;
    }
    if (!data) return;
    const mapped = data.map((row) => rowToRoom(row as RoomRow));
    setRooms(mapped);
    setSelectedId((prev) => (prev && mapped.some((r) => r.id === prev) ? prev : mapped[0]?.id ?? ""));
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const loaded = await loadThresholds();
      setThresholds(loaded);
      await refreshRooms();
      setLoading(false);
    })();
  }, [refreshRooms]);

  // Realtime: keep the room registry itself in sync (e.g. if a room is
  // added/removed/updated - including siren_muted - from another tab or
  // directly in Supabase).
  useEffect(() => {
    const channel = supabase
      .channel("rooms-registry")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms" },
        (payload) => {
          if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
            const updated = rowToRoom(payload.new as RoomRow);
            setRooms((prev) => {
              const exists = prev.some((r) => r.id === updated.id);
              // Preserve any live temp/humidity/online/co2/lpg already merged
              // in from the "readings" table. The "rooms" table's own
              // co2/lpg columns are stale placeholder fields (e.g. the 400
              // default from AddDeviceModal's form) - they must NEVER
              // clobber the live readings values just because an unrelated
              // column (like siren_muted) changed on this row.
              const existing = prev.find((r) => r.id === updated.id);
              const merged = existing
                ? {
                    ...updated,
                    temp: existing.temp,
                    humidity: existing.humidity,
                    online: existing.online,
                    co2: existing.co2,
                    lpg: existing.lpg,
                  }
                : updated;
              return exists ? prev.map((r) => (r.id === merged.id ? merged : r)) : [...prev, merged];
            });
          } else if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as any)?.id;
            setRooms((prev) => prev.filter((r) => r.id !== deletedId));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Realtime: keep the global platform thresholds in sync across tabs.
  // If an admin adjusts the safety tiers from another session, the
  // dashboard and reports pages pick the change up without a reload.
  useEffect(() => {
    const channel = supabase
      .channel("platform-thresholds-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "platform_thresholds" },
        async () => {
          const loaded = await loadThresholds();
          setThresholds(loaded);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadThresholds]);

  // ---------- Live sensor data (Supabase "readings" table) ----------
  // Only rooms currently in the registry are eligible for live data - this
  // recomputes automatically whenever `rooms` changes (e.g. a new device
  // was just added).
  const deviceIds = rooms.map((r) => r.deviceId).filter((id): id is string => !!id);

  const fetchLatestFor = useCallback(async (deviceId: string) => {
    const { data, error } = await supabase
      .from("readings")
      .select("device_id, co2, lpg, temp, humidity, severity, created_at")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<ReadingRow>();

    if (error) {
      console.error(`Failed to fetch latest reading for ${deviceId}:`, error.message);
      return;
    }
    if (!data) return; // no readings yet for this device -> stays offline/null

    const isRecent = Date.now() - new Date(data.created_at).getTime() < OFFLINE_THRESHOLD_MS;

    setRooms((prev) =>
      prev.map((r) =>
        r.deviceId === deviceId
          ? {
              ...r,
              lpg: data.lpg,
              co2: data.co2 ?? r.co2,
              temp: data.temp ?? r.temp,
              humidity: data.humidity ?? r.humidity,
              online: isRecent,
            }
          : r
      )
    );
  }, []);

  useEffect(() => {
    if (deviceIds.length === 0) return;
    (async () => {
      for (const deviceId of deviceIds) {
        await fetchLatestFor(deviceId);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceIds.join(",")]);

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
                ? {
                    ...r,
                    lpg: row.lpg,
                    co2: row.co2 ?? r.co2,
                    temp: row.temp ?? r.temp,
                    humidity: row.humidity ?? r.humidity,
                    online: true,
                  }
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

  // Polling fallback: catches missed realtime events and flips stale
  // devices offline.
  useEffect(() => {
    if (deviceIds.length === 0) return;

    const poll = async () => {
      for (const deviceId of deviceIds) {
        await fetchLatestFor(deviceId);
      }
    };

    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceIds.join(",")]);

  // Refetch immediately when the tab regains focus (background tabs throttle
  // setInterval heavily).
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && deviceIds.length > 0) {
        deviceIds.forEach((id) => fetchLatestFor(id));
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceIds.join(",")]);

  // ---------- Room registry mutations ----------

  // No longer meaningful as a manual toggle now that "online" is derived
  // purely from reading freshness - kept as a no-op so existing callers
  // (DevicesPage's Online/Offline button) don't break. Consider removing
  // that button from the UI since it no longer does anything real.
  const toggleOnline = useCallback((_id: string) => {
    console.warn("toggleOnline is a no-op: online status is now derived from live readings, not stored.");
  }, []);

  const removeRoom = useCallback(async (id: string) => {
    const { error } = await supabase.from("rooms").delete().eq("id", id);
    if (error) {
      console.error("Failed to delete room:", error.message);
      return;
    }
    setRooms((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const addRoom = useCallback(async (form: RoomForm) => {
    const insertRow = roomToInsertRow(form);
    if (!insertRow.id) {
      console.error("Cannot add room: Device ID is required.");
      return { error: "Device ID is required." };
    }
    const { data, error } = await supabase
      .from("rooms")
      .insert(insertRow)
      .select()
      .single();

    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("already exists")) {
        return { error: `Device ID "${insertRow.id}" is already registered. Choose a different ID.` };
      }
      console.error("Failed to add room:", error.message);
      return { error: error.message };
    }
    if (data) {
      setRooms((prev) => [...prev, rowToRoom(data as RoomRow)]);
    }
    return { error: null };
  }, []);

  // Flip a single device's siren_muted flag. Writes to Supabase first so the
  // ESP32 picks it up on its next poll; the local optimistic update makes the
  // UI feel instant, and the realtime subscription above will reconcile it
  // (and sync it to any other open tab) once the write confirms.
  const toggleSiren = useCallback(
    async (id: string) => {
      const current = rooms.find((r) => r.id === id);
      if (!current) return;
      const next = !current.sirenMuted;

      setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, sirenMuted: next } : r)));

      const { error } = await supabase.from("rooms").update({ siren_muted: next }).eq("id", id);
      if (error) {
        console.error("Failed to toggle siren mute:", error.message);
        // Roll back the optimistic update on failure.
        setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, sirenMuted: current.sirenMuted } : r)));
      }
    },
    [rooms]
  );

  // Mute or unmute every registered device at once. Applies the same
  // siren_muted value to all rooms currently in the registry - not a
  // separate global setting, just a bulk write of the per-device flag.
  const muteAll = useCallback(
    async (muted: boolean) => {
      const previous = rooms;
      setRooms((prev) => prev.map((r) => ({ ...r, sirenMuted: muted })));

      const ids = rooms.map((r) => r.id);
      if (ids.length === 0) return;

      const { error } = await supabase.from("rooms").update({ siren_muted: muted }).in("id", ids);
      if (error) {
        console.error("Failed to mute/unmute all devices:", error.message);
        setRooms(previous);
      }
    },
    [rooms]
  );

  return (
    <RoomsContext.Provider
      value={{
        rooms,
        loading,
        selectedId,
        setSelectedId,
        thresholds,
        setThresholds: setThresholdsPersist,
        settings,
        setSettings,
        toggleOnline,
        removeRoom,
        addRoom,
        toggleSiren,
        muteAll,
      }}
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