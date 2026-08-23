import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { supabase } from "../supabase"; // adjust path if your supabase client lives elsewhere
import type { IoTDevice } from "../types";

interface DeviceContextValue {
  devices: IoTDevice[];
  loading: boolean;
  setDeviceStatus: (id: string, status: "online" | "offline") => void;
  removeDevice: (id: string) => Promise<void>;
  addDevice: (device: IoTDevice) => Promise<void>;
  refreshDevices: () => Promise<void>;
}

const DeviceContext = createContext<DeviceContextValue | undefined>(undefined);

// ---------- Mapping helpers ----------
// Your Supabase "rooms" table uses different field names (snake_case, and a
// single "sensor" column) than the IoTDevice type used across the frontend.
// Adjust these two functions if your actual column names differ.

function rowToDevice(row: any): IoTDevice {
  return {
    id: row.id,
    name: row.name,
    floor: row.floor,
    co2Sensor: row.sensor ?? "",
    gasSensor: row.gas_sensor ?? null,
    length: row.length,
    width: row.width,
    height: row.height,
    occupancy: row.occupancy,
    co2: row.co2 ?? 0,
    lpg: row.lpg ?? null,
    temp: row.temp ?? 0,
    humidity: row.humidity ?? 0,
    connectionStatus: row.connection_status ?? "offline",
    alertCount: row.alert_count ?? 0,
  };
}

function deviceToRow(device: IoTDevice) {
  return {
    id: device.id,
    name: device.name,
    floor: device.floor,
    sensor: device.co2Sensor,
    gas_sensor: device.gasSensor,
    length: device.length,
    width: device.width,
    height: device.height,
    occupancy: device.occupancy,
    co2: device.co2,
    lpg: device.lpg,
    temp: device.temp,
    humidity: device.humidity,
    connection_status: device.connectionStatus,
    alert_count: device.alertCount,
  };
}

// Single source of truth for device data. Every page (Dashboard, Devices,
// Reports) reads from this same context, so a status change, addition, or
// removal on one page is reflected everywhere else immediately, and is
// persisted in Supabase so refreshing the page keeps the correct state.
export function DeviceProvider({ children }: { children: ReactNode }) {
  const [devices, setDevices] = useState<IoTDevice[]>([]);
  const [loading, setLoading] = useState(true);

  async function refreshDevices() {
    setLoading(true);
    const { data, error } = await supabase.from("rooms").select("*");
    if (error) {
      console.error("Failed to fetch devices:", error);
    } else if (data) {
      setDevices(data.map(rowToDevice));
    }
    setLoading(false);
  }

  useEffect(() => {
    refreshDevices();

    // Realtime subscription: any INSERT/UPDATE/DELETE on "rooms" pushes
    // straight into local state, so temp/humidity (and everything else in
    // this table) update live instead of only on initial page load.
    const channel = supabase
      .channel("rooms-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms" },
        (payload) => {
          if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
            const updated = rowToDevice(payload.new);
            setDevices((prev) => {
              const exists = prev.some((d) => d.id === updated.id);
              return exists
                ? prev.map((d) => (d.id === updated.id ? updated : d))
                : [...prev, updated];
            });
          } else if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as any)?.id;
            setDevices((prev) => prev.filter((d) => d.id !== deletedId));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function setDeviceStatus(id: string, status: "online" | "offline") {
    // Optimistically update local state first for a snappy UI
    setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, connectionStatus: status } : d)));

    const { error } = await supabase
      .from("rooms")
      .update({ connection_status: status })
      .eq("id", id);

    if (error) {
      console.error("Failed to update device status:", error);
      // Roll back on failure by re-fetching the true state
      refreshDevices();
    }
  }

  async function removeDevice(id: string) {
    const { error } = await supabase.from("rooms").delete().eq("id", id);
    if (error) {
      console.error("Failed to delete device:", error);
      return;
    }
    setDevices((prev) => prev.filter((d) => d.id !== id));
  }

  async function addDevice(device: IoTDevice) {
    const { data, error } = await supabase
      .from("rooms")
      .insert(deviceToRow(device))
      .select()
      .single();

    if (error) {
      console.error("Failed to add device:", error);
      return;
    }

    if (data) {
      setDevices((prev) => [...prev, rowToDevice(data)]);
    }
  }

  return (
    <DeviceContext.Provider
      value={{ devices, loading, setDeviceStatus, removeDevice, addDevice, refreshDevices }}
    >
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevices() {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error("useDevices must be used within a DeviceProvider");
  return ctx;
}