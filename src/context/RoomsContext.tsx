import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
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
  /**
   * Save a configuration change. Resolves once the write has been attempted;
   * `error` is non-null when the database rejected it, in which case the
   * on-screen value has been rolled back to the previously saved one.
   */
  setThresholds: (t: Thresholds) => Promise<{ error: string | null }>;
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
// installed_at, siren_muted.
//
// IMPORTANT: rooms.co2 and rooms.lpg are NOT measurements. They are legacy
// columns last written by the device-registration form. They are deliberately
// NOT read into Room here - doing so presented the form's default numbers as
// live sensor readings. Live values come only from the readings table.
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
    // `floor` and `name` are dereferenced with .toUpperCase() by the UI. A row
    // edited directly in the Supabase table editor can carry a NULL here, which
    // would throw during render and white-screen the dashboard. Coerce like
    // co2_sensor is, rather than asserting non-null in the type.
    name: row.name ?? "",
    floor: row.floor ?? "",
    co2Sensor: row.co2_sensor ?? "",
    gasSensor: row.gas_sensor,
    tempHumiditySensor: row.temp_humidity_sensor,
    // Every registered room is its own live device: the ESP32 sends
    // readings.device_id = rooms.id directly.
    deviceId: row.id,
    length: row.length,
    width: row.width,
    height: row.height,
    // null, NOT a placeholder number, until the readings fetch below supplies
    // a real measurement. Null renders as "No sensor data recorded".
    co2: null,
    lpg: null,
    temp: null,
    humidity: null,
    online: false,
    lastReadingAt: null,
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
    // co2 / lpg are intentionally absent. They are not sensor measurements, and
    // writing a default here is what previously caused a newly registered
    // device to display a fabricated "400 ppm CO2 / 0 ppm LPG".
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
  lpg: number | null;
  temp: number | null;
  humidity: number | null;
  severity: number | null;
  created_at: string;
}

// How stale a reading can be before we consider that device offline.
const OFFLINE_THRESHOLD_MS = 30_000; // 30s

// Tolerance for clock skew between the browser, Supabase's clock and an ESP32
// with no RTC. Without a lower bound on the age, a device whose clock runs
// even slightly fast reads as permanently online forever - including one that
// died weeks ago - because the age never goes positive.
const MAX_FUTURE_SKEW_MS = 60_000;

/**
 * True when a reading is recent enough that its device should read as online.
 *
 * `created_at` comes from the database, so it is authoritative in principle,
 * but the row travels through the device clock and the browser clock and either
 * can drift. A reading dated in the future is treated as fresh rather than
 * being rejected outright.
 */
function nowMinusReadingMs(created_at: string): boolean {
  const age = Date.now() - new Date(created_at).getTime();
  return age < OFFLINE_THRESHOLD_MS && age > -MAX_FUTURE_SKEW_MS;
}

export function RoomsProvider({ children }: { children: ReactNode }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>("");
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  // Mirror of `thresholds` for use inside callbacks that must not re-create
  // themselves (and therefore must not close over a stale value) on every
  // keystroke. Lets a failed save roll back to what is actually on screen.
  const thresholdsRef = useRef(thresholds);
  useEffect(() => {
    thresholdsRef.current = thresholds;
  }, [thresholds]);
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

  /**
   * Read the saved configuration.
   *
   * Memoised because the realtime subscription below depends on it: an
   * unmemoised copy would re-create and re-subscribe the channel on every
   * render, which drops events and leaks a subscription per render.
   */
  const loadThresholds = useCallback(async (): Promise<Thresholds> => {
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
  }, []);

  /**
   * Write the configuration back.
   *
   * Returns the Supabase error instead of only logging it. The Settings page
   * optimistically swaps in the new values so the form feels instant, which
   * means a rejected write - an ascending-order CHECK constraint, or an RLS
   * rejection because the caller is not an active approved admin - would
   * otherwise leave the screen showing values that were never persisted.
   */
  async function persistThresholds(next: Thresholds): Promise<string | null> {
    const now = new Date().toISOString();
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
      updated_at: now,
    };
    const { error } = await supabase
      .from("platform_thresholds")
      .upsert(row, { onConflict: "id" });
    if (error) {
      console.error("Failed to persist platform thresholds:", error.message);
      return error.message;
    }

    // Append to threshold_history in the same change.
    //
    // Reports evaluate readings against the thresholds that were in effect at
    // the time, not against whatever is configured now. platform_thresholds
    // only ever holds the current values, so without this log a report for a
    // past month would silently be scored using present-day settings - which
    // is exactly the kind of invented history the reporting rules forbid.
    //
    // Only write when something actually changed, otherwise every save would
    // add a duplicate history row.
    //
    // threshold_history is optional (it arrives with the monthly-reporting
    // migrations, which are not applied to every project), so its absence is
    // not an error and never blocks the live configuration.
    const { data: previous, error: historyReadError } = await supabase
      .from("threshold_history")
      .select("*")
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (historyReadError) {
      console.warn(
        "threshold_history unavailable; the live thresholds saved but no history row was recorded:",
        historyReadError.message
      );
      return null;
    }

    const changed =
      !previous ||
      Number(previous.co2_danger) !== Number(next.co2.danger) ||
      Number(previous.co2_warning) !== Number(next.co2.warning) ||
      Number(previous.co2_high) !== Number(next.co2.high) ||
      Number(previous.lpg_danger) !== Number(next.lpg.danger) ||
      Number(previous.lpg_warning) !== Number(next.lpg.warning) ||
      Number(previous.lpg_high) !== Number(next.lpg.high) ||
      Number(previous.temp_freeze_below) !== Number(next.temp.freezeBelow) ||
      Number(previous.temp_cool_below) !== Number(next.temp.coolBelow) ||
      Number(previous.temp_heat_above) !== Number(next.temp.heatAbove) ||
      Number(previous.humidity_dry_below) !== Number(next.humidity.dryBelow) ||
      Number(previous.humidity_low_below) !== Number(next.humidity.lowBelow) ||
      Number(previous.humidity_mold_above) !== Number(next.humidity.moldAbove);

    if (!changed) return null;

    const { error: historyError } = await supabase.from("threshold_history").insert({
      // Spelled out rather than spread from `row`, because threshold_history has
      // its own `effective_from` and has no `id` / `updated_at` columns.
      effective_from: now,
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
      change_note: "Updated from the Settings page",
    });

    if (historyError) {
      // Not fatal: the live thresholds saved fine. Reports for periods before
      // now will be labelled as evaluated against current thresholds.
      console.error(
        "Failed to record threshold history (reports for past periods will use current thresholds):",
        historyError.message
      );
    }

    return null;
  }

  /**
   * Persist a configuration change.
   *
   * Applies it locally first so the Settings page and every card react at once,
   * then writes through. On failure the previous value is restored, because
   * leaving the optimistic value on screen would show a configuration that was
   * never saved and that the next reload would silently contradict.
   */
  const setThresholdsPersist = useCallback(
    async (next: Thresholds): Promise<{ error: string | null }> => {
      const previousValue = thresholdsRef.current;
      setThresholds(next);

      const error = await persistThresholds(next);
      if (error) {
        setThresholds(previousValue);
        return { error };
      }
      return { error: null };
    },
    []
  );

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
                    // rowToRoom() always sets lastReadingAt: null because the
                    // rooms table has no reading timestamp. Spreading `updated`
                    // re-introduces that null, so it has to be carried over
                    // explicitly like every other live field - otherwise any
                    // unrelated rooms UPDATE (toggling a siren, editing a
                    // name) resets a healthy device to "no reading ever
                    // received".
                    lastReadingAt: existing.lastReadingAt,
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
      // Leave the previous values and lastReadingAt untouched so the UI can
      // keep showing how old they are. Silently blanking them would be worse,
      // and silently freezing them without a timestamp is what this fixes.
      console.error(`Failed to fetch latest reading for ${deviceId}:`, error.message);
      return;
    }

    if (!data) {
      // No readings have EVER been received for this device. Every live metric
      // stays null so the UI reports "No sensor data recorded" rather than a
      // fabricated or zero value.
      //
      // Guarded by "we have never shown one for this device": a request issued
      // before the device's first reading can resolve after it, and blanking
      // live values here would make a healthy new device claim it has never
      // reported.
      setRooms((prev) =>
        prev.map((r) =>
          r.deviceId === deviceId && r.lastReadingAt === null
            ? { ...r, co2: null, lpg: null, temp: null, humidity: null, online: false, lastReadingAt: null }
            : r
        )
      );
      return;
    }

    const isRecent = nowMinusReadingMs(data.created_at);
    const incomingMs = new Date(data.created_at).getTime();

    // Assign the sensor's values verbatim. A NULL in the reading row stays
    // NULL - it is not replaced by a previous value or a zero, because the
    // sensor genuinely returned nothing for that metric.
    //
    // Only ever move forward in time. The realtime INSERT handler and this
    // poller both write the same room, so whichever response happens to land
    // last wins unless the merge itself is monotonic. Without this the
    // dashboard visibly rolls back one reading whenever a poll that was
    // dispatched earlier resolves after a newer realtime event.
    setRooms((prev) =>
      prev.map((r) => {
        if (r.deviceId !== deviceId) return r;
        const currentMs = r.lastReadingAt ? new Date(r.lastReadingAt).getTime() : null;
        if (currentMs !== null && incomingMs <= currentMs) return r;
        return {
          ...r,
          lpg: data.lpg ?? null,
          co2: data.co2 ?? null,
          temp: data.temp ?? null,
          humidity: data.humidity ?? null,
          online: isRecent,
          lastReadingAt: data.created_at,
        };
      })
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
                    // Verbatim: a NULL metric stays NULL.
                    lpg: row.lpg ?? null,
                    co2: row.co2 ?? null,
                    temp: row.temp ?? null,
                    humidity: row.humidity ?? null,
                    online: true,
                    lastReadingAt: row.created_at,
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

    // setInterval does not await its callback, so without this a sweep that
    // takes longer than the 2s interval (cold start, RLS evaluation, many
    // devices) overlaps the next one and requests multiply without bound.
    let sweepInFlight = false;

    const poll = async () => {
      if (sweepInFlight) return;
      sweepInFlight = true;
      try {
        for (const deviceId of deviceIds) {
          await fetchLatestFor(deviceId);
        }
      } finally {
        sweepInFlight = false;
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
      // The realtime INSERT handler already appends this row, and on a
      // low-latency link it usually wins the race against this REST response.
      // Appending unconditionally registered the device twice: it appeared
      // twice in the list, was polled twice, and only one copy was removed by
      // removeRoom's filter.
      const next = rowToRoom(data as RoomRow);
      setRooms((prev) =>
        prev.some((r) => r.id === next.id)
          ? prev.map((r) => (r.id === next.id ? next : r))
          : [...prev, next]
      );
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
      setRooms((prev) => prev.map((r) => ({ ...r, sirenMuted: muted })));

      const ids = rooms.map((r) => r.id);
      if (ids.length === 0) return;

      const { error } = await supabase.from("rooms").update({ siren_muted: muted }).in("id", ids);
      if (error) {
        console.error("Failed to mute/unmute all devices:", error.message);
        // Roll back ONLY the flag that was changed. Restoring a whole-array
        // snapshot also reverted every co2/temp/humidity value and
        // lastReadingAt that the 2s poller had written while the request was
        // in flight, making a transient network failure look like the whole
        // building stopped reporting.
        setRooms((prev) => prev.map((r) => ({ ...r, sirenMuted: !muted })));
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