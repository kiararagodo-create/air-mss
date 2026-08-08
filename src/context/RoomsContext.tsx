import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { Room, Thresholds } from "../data/Data";
import { clamp, DEFAULT_THRESHOLDS } from "../data/Data";

const SEED_ROOMS: Room[] = [
  {
    id: "AIR-106",
    name: "Room 106",
    floor: "Ground Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: null,
    length: 8,
    width: 6,
    height: 3,
    occupancy: 30,
    co2: 490,
    lpg: null,
    temp: 27.5,
    humidity: 55,
    online: true,
    alertCount: 0,
    installedAt: "2024-08-15",
  },
  {
    id: "AIR-K01",
    name: "Kitchen",
    floor: "3rd Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: "MQ-6",
    length: 6,
    width: 5,
    height: 3,
    occupancy: 8,
    co2: 992,
    lpg: 510,
    temp: 30.2,
    humidity: 60,
    online: true,
    alertCount: 3,
    installedAt: "2025-01-10",
  },
  {
    id: "AIR-C182",
    name: "Chem Lab Room",
    floor: "2nd Floor",
    co2Sensor: "MH-Z19C",
    gasSensor: "MQ-6",
    length: 10,
    width: 8,
    height: 3.2,
    occupancy: 25,
    co2: 974,
    lpg: 333,
    temp: 28.8,
    humidity: 58,
    online: true,
    alertCount: 2,
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

export function RoomsProvider({ children }: { children: ReactNode }) {
  const [rooms, setRooms] = useState<Room[]>(SEED_ROOMS);
  const [selectedId, setSelectedId] = useState<string>(SEED_ROOMS[0].id);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  // Simulate live sensor drift.
  useEffect(() => {
    const interval = setInterval(() => {
      setRooms((prev) =>
        prev.map((r) => {
          const nextCo2 = clamp(r.co2 + (Math.random() - 0.45) * 25, 350, 2200);
          const nextLpg = r.lpg != null ? clamp(r.lpg + (Math.random() - 0.45) * 15, 0, 1600) : r.lpg;
          const nextTemp = clamp(r.temp + (Math.random() - 0.5) * 0.3, 22, 36);
          const nextHumidity = clamp(r.humidity + (Math.random() - 0.5) * 1.5, 30, 90);
          return { ...r, co2: nextCo2, lpg: nextLpg, temp: nextTemp, humidity: nextHumidity };
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
      length: Number(form.length ?? 6),
      width: Number(form.width ?? 4),
      height: Number(form.height ?? 3),
      occupancy: Number(form.occupancy ?? 1),
      co2: Number(form.co2 ?? 420),
      lpg: form.lpg != null ? Number(form.lpg) : null,
      temp: Number(form.temp ?? 25),
      humidity: Number(form.humidity ?? 50),
      online: form.online ?? true,
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