import { createContext, useContext, useState, type ReactNode } from "react";
import { devices as initialDevices } from "../data/Data";
import type { IoTDevice } from "../types";

interface DeviceContextValue {
  devices: IoTDevice[];
  setDeviceStatus: (id: string, status: "online" | "offline") => void;
  removeDevice: (id: string) => void;
  addDevice: (device: IoTDevice) => void;
}

const DeviceContext = createContext<DeviceContextValue | undefined>(undefined);

// Single source of truth for device data. Every page (Dashboard, Devices,
// Reports) reads from this same context, so a status change or removal on
// one page is reflected everywhere else immediately.
export function DeviceProvider({ children }: { children: ReactNode }) {
  const [devices, setDevices] = useState<IoTDevice[]>(initialDevices);

  function setDeviceStatus(id: string, status: "online" | "offline") {
    setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, connectionStatus: status } : d)));
  }

  function removeDevice(id: string) {
    setDevices((prev) => prev.filter((d) => d.id !== id));
  }

  function addDevice(device: IoTDevice) {
    setDevices((prev) => [...prev, device]);
  }

  return (
    <DeviceContext.Provider value={{ devices, setDeviceStatus, removeDevice, addDevice }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevices() {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error("useDevices must be used within a DeviceProvider");
  return ctx;
}
