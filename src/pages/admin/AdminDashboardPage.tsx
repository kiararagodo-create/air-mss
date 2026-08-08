import { useState, useEffect, useRef, useCallback, type Dispatch, type SetStateAction } from "react";
import { Room, Thresholds, clamp, getStatus, DEFAULT_THRESHOLDS } from "../../data/Data";
import Sidebar from "../../components/Sidebar";
import ReportsPage from "./ReportsPage";
import SettingsPage from "./SettingsPage";

const INITIAL_ROOMS: Room[] = [];

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export type Role = "admin" | "maintenance" | "security";

export interface User {
  name: string;
  email: string;
  role: Role;
  roleLabel: string;
  department: string;
  accessScope: string;
  badge: string;
}

export interface Settings {
  emailAlerts: boolean;
  soundAlarms: boolean;
}

export interface RoomForm {
  name: string;
  floor: string;
  gasSensor: string;
  length: number;
  width: number;
  height: number;
  occupancy: number;
}

interface DevicesPageProps {
  rooms: Room[];
  toggleOnline: (id: string) => void;
  removeRoom: (id: string) => void;
  addRoom: (form: RoomForm) => void;
  user: User;
  thresholds: Thresholds;
}

function DevicesPage({ rooms, toggleOnline, removeRoom, addRoom, user, thresholds }: DevicesPageProps) {
  void rooms;
  void toggleOnline;
  void removeRoom;
  void addRoom;
  void user;
  void thresholds;

  return (
    <div style={{ padding: "24px", background: "#fff", borderRadius: "12px" }}>
      <h1>Devices</h1>
      <p>The devices page is currently unavailable.</p>
    </div>
  );
}

function DashboardPage({
  rooms,
  selectedId,
  setSelectedId,
  thresholds,
}: {
  rooms: Room[];
  selectedId: string;
  setSelectedId: Dispatch<SetStateAction<string>>;
  thresholds: Thresholds;
}) {
  const selectedRoom = rooms.find((room) => room.id === selectedId) ?? rooms[0];

  return (
    <div className="grid gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 style={{ margin: 0 }}>Dashboard</h1>
          <p style={{ margin: "4px 0 0", color: "#6b7280" }}>
            Live room overview and alert status.
          </p>
        </div>
      </div>

      <div className="grid gap-4">
        <div className="bg-white rounded-xl p-4 sm:p-5">
          <h2 style={{ marginTop: 0 }}>Rooms</h2>
          <div className="flex flex-wrap gap-3">
            {rooms.map((room) => {
              const isSelected = selectedRoom?.id === room.id;
              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => setSelectedId(room.id)}
                  className="flex-1 sm:flex-none min-w-[140px] text-left"
                  style={{
                    border: isSelected ? "2px solid #2563eb" : "1px solid #d1d5db",
                    borderRadius: "10px",
                    padding: "12px 14px",
                    background: isSelected ? "#eff6ff" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{room.name}</div>
                  <div style={{ fontSize: "12px", color: "#6b7280" }}>{room.floor}</div>
                </button>
              );
            })}
          </div>
        </div>

        {selectedRoom && (
          <div className="bg-white rounded-xl p-4 sm:p-5 overflow-x-hidden">
            <h2 style={{ marginTop: 0 }}>{selectedRoom.name}</h2>
            <p>CO2: {Math.round(selectedRoom.co2)} ppm</p>
            <p>Gas: {selectedRoom.lpg == null ? "N/A" : `${Math.round(selectedRoom.lpg)} ppm`}</p>
            <p>Temperature: {selectedRoom.temp.toFixed(1)}°C</p>
            <p>Humidity: {selectedRoom.humidity.toFixed(1)}%</p>
            <p>Alert count: {selectedRoom.alertCount}</p>
            <p>Status: {getStatus(selectedRoom, thresholds).severity}</p>
          </div>
        )}
      </div>
    </div>
  );
}

type Page = "dashboard" | "devices" | "reports" | "settings";

interface AdminDashboardProps {
  user: User;
  onLogout: () => void;
}

// ---------------------------------------------------------------------------
// AdminDashboard - everything shown after a successful login.
// Receives the logged-in user and a logout handler from App.tsx.
// ---------------------------------------------------------------------------
export default function AdminDashboard({ user, onLogout }: AdminDashboardProps) {
  const [page, setPage] = useState<Page>("dashboard");
  const [rooms, setRooms] = useState<Room[]>(INITIAL_ROOMS);
  const [selectedId, setSelectedId] = useState<string>(INITIAL_ROOMS[0].id);
  const [settings, setSettings] = useState<Settings>({ emailAlerts: true, soundAlarms: true });
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const idCounter = useRef<number>(0);

  // Simulate live sensor data
  useEffect(() => {
    const interval = setInterval(() => {
      setRooms((prev) =>
        prev.map((r) => {
          const co2Drift = (Math.random() - 0.45) * 25;
          const nextCo2 = clamp(r.co2 + co2Drift, 350, 2200);
          let nextLpg = r.lpg;
          if (r.lpg != null) {
            const lpgDrift = (Math.random() - 0.45) * 15;
            nextLpg = clamp(r.lpg + lpgDrift, 0, 1600);
          }
          const nextTemp = clamp(r.temp + (Math.random() - 0.5) * 0.3, 22, 36);
          const nextHumidity = clamp(r.humidity + (Math.random() - 0.5) * 1.5, 30, 90);

          const prevRoom: Room = { ...r };
          const wasSeverity = getStatus(prevRoom, thresholds).severity;
          const nextRoom: Room = { ...r, co2: nextCo2, lpg: nextLpg };
          const isSeverity = getStatus(nextRoom, thresholds).severity;
          const newAlert = isSeverity > wasSeverity && isSeverity >= 1;

          return {
            ...r,
            co2: nextCo2,
            lpg: nextLpg,
            temp: nextTemp,
            humidity: nextHumidity,
            alertCount: newAlert ? r.alertCount + 1 : r.alertCount,
          };
        })
      );
    }, 3000);
    return () => clearInterval(interval);
  }, [thresholds]);

  const toggleOnline = useCallback((id: string) => {
    setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, online: !r.online } : r)));
  }, []);

  const removeRoom = useCallback((id: string) => {
    setRooms((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const addRoom = useCallback((form: RoomForm) => {
    idCounter.current += 1;
    const newRoom: Room = {
      id: `AIR-${200 + idCounter.current}`,
      name: form.name,
      floor: form.floor,
      co2Sensor: "MH-Z19C",
      gasSensor: form.gasSensor === "MQ-6" ? "MQ-6" : null,
      length: form.length,
      width: form.width,
      height: form.height,
      occupancy: form.occupancy,
      installedAt: new Date().toISOString(),
      co2: 420,
      lpg: form.gasSensor === "MQ-6" ? 40 : null,
      temp: 28,
      humidity: 55,
      online: true,
      alertCount: 0,
    };
    setRooms((prev) => [...prev, newRoom]);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        background: "#f6f8fa",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <Sidebar
        {...({
          page,
          currentPage: page,
          activePage: page,
          setPage,
          setCurrentPage: setPage,
          onPageChange: setPage,
          user,
          onLogout,
        } as any)}
      />
      {/* pt-20 clears the fixed mobile hamburger bar from Sidebar; md:pt-8 restores normal spacing on desktop */}
      <div className="flex-1 min-w-0 overflow-x-auto p-4 pt-20 md:p-8 md:pt-8">
        {page === "dashboard" && (
          <DashboardPage
            rooms={rooms}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            thresholds={thresholds}
          />
        )}
        {page === "devices" && user.role !== "security" && (
          <DevicesPage
            rooms={rooms}
            toggleOnline={toggleOnline}
            removeRoom={removeRoom}
            addRoom={addRoom}
            user={user}
            thresholds={thresholds}
          />
        )}
        {page === "reports" && <ReportsPage rooms={rooms} thresholds={thresholds} />}
        {page === "settings" && user.role === "admin" && (
          <SettingsPage
            settings={settings}
            setSettings={setSettings}
            thresholds={thresholds}
            setThresholds={setThresholds}
            user={user}
          />
        )}
      </div>
    </div>
  );
}