import { useState } from "react";
import { Info, Plus, Trash2 } from "lucide-react";
import { Badge, badgeStyles } from "../../ui";
// Inline AddDeviceModal to avoid missing module import
function AddDeviceModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (f: RoomForm) => void }) {
  const [name, setName] = useState("");
  return (
    <div style={{ position: "fixed", left: 0, top: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}>
      <div style={{ background: "#fff", padding: 16, borderRadius: 8, width: 420 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Add New IoT Device</h2>
        <div style={{ marginTop: 12 }}>
          <label style={{ display: "block", fontSize: 13, color: "#334155", marginBottom: 6 }}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #e2e8f0" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{ padding: "8px 12px", borderRadius: 6 }}>Cancel</button>
          <button onClick={() => { onSubmit({ name }); }} style={{ padding: "8px 12px", borderRadius: 6, background: "#0d9488", color: "#fff", border: "none" }}>Add</button>
        </div>
      </div>
    </div>
  );
}

export interface Room {
  id: string;
  name: string;
  floor: string;
  online: boolean;
  co2Sensor: string | number;
  gasSensor?: string | number;
  length: number;
  width: number;
  height: number;
  occupancy: number;
  co2: number;
  lpg: number | null;
  temp: number;
  humidity: number;
  sensors: Array<{ id: string; type: string; reading: number; unit: string }>;
}

export interface User {
  role: "admin" | "maintenance" | "user";
}

export interface Thresholds {
  [key: string]: { min: number; max: number };
}

export interface RoomForm {
  name: string;
}

function getStatus(room: Room, thresholds: Thresholds) {
  const co2Threshold = thresholds.co2 || { min: 0, max: 1000 };
  const value = room.co2 ?? 0;

  if (value > co2Threshold.max) {
    return { tone: "danger" as const, label: "High CO2" };
  }
  if (value > co2Threshold.max * 0.8) {
    return { tone: "warning" as const, label: "Elevated CO2" };
  }
  return { tone: "success" as const, label: "Normal" };
}

function volumeOf(room: Room) {
  return Number((room.length * room.width * room.height).toFixed(1));
}

const SENSOR_INFO = [
  {
    id: "CO2",
    title: "CO2 Sensor",
    body: "Monitors carbon dioxide concentration in the air to help maintain healthy ventilation.",
    gases: "CO2",
    range: "0 - 5000 ppm",
    accuracy: "±50 ppm",
    specs: ["Non-dispersive infrared (NDIR)", "Low power consumption", "Fast response time"],
  },
  {
    id: "LPG",
    title: "LPG Sensor",
    body: "Detects liquified petroleum gas to help prevent leaks and unsafe conditions.",
    gases: "LPG",
    range: "0 - 1000 ppm",
    accuracy: "±5%",
    specs: ["Metal oxide semiconductor", "Stable operation", "Humidity compensated"],
  },
];

interface DevicesPageProps {
  rooms: Room[];
  toggleOnline: (id: string) => void;
  removeRoom: (id: string) => void;
  addRoom: (form: RoomForm) => void;
  user: User;
  thresholds: Thresholds;
}

export default function DevicesPage({ rooms, toggleOnline, removeRoom, addRoom, user, thresholds }: DevicesPageProps) {
  const [showAdd, setShowAdd] = useState(false);
  const canManage = user.role === "admin";
  const canToggle = user.role === "admin" || user.role === "maintenance";

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", margin: 0 }}>
            IoT Sensor Node Registry
          </h1>
          <p style={{ color: "#64748b", fontSize: 13.5, margin: "4px 0 0" }}>
            Manage deployed air monitoring hardware across Asian College campus
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowAdd(true)}
            style={{
              background: "#0d9488",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
            }}
          >
            <Plus size={15} /> Add New IoT Device
          </button>
        )}
      </div>

      {showAdd && (
        <AddDeviceModal
          onClose={() => setShowAdd(false)}
          onSubmit={(form: RoomForm) => {
            addRoom(form);
            setShowAdd(false);
          }}
        />
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))",
          gap: 16,
          marginBottom: 28,
        }}
      >
        {rooms.map((r) => {
          const st = getStatus(r, thresholds);
          const borderColor = badgeStyles(st.tone).text;
          return (
            <div
              key={r.id}
              style={{
                background: "#fff",
                border: "1px solid #eef1f4",
                borderLeft: `4px solid ${borderColor}`,
                borderRadius: 12,
                padding: 16,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#94a3b8",
                    letterSpacing: 0.5,
                  }}
                >
                  {r.floor.toUpperCase()}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#475569",
                    background: "#f1f5f9",
                    padding: "2px 8px",
                    borderRadius: 6,
                  }}
                >
                  {r.id}
                </span>
              </div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", margin: "4px 0 8px" }}>
                {r.name}
              </div>
              <div style={{ marginBottom: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Badge label={`CO2: ${r.co2Sensor}`} tone="success" />
                {r.gasSensor && <Badge label={`Gas: ${r.gasSensor}`} tone="success" />}
                <Badge label={st.label} tone={st.tone} />
              </div>
              <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 10 }}>
                {r.length}m x {r.width}m x {r.height}m &middot; {volumeOf(r)} m3 &middot; {r.occupancy}{" "}
                occupants
              </div>

              <div style={{ background: "#f8fafc", borderRadius: 10, padding: 10, marginBottom: 12 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12.5,
                    marginBottom: 6,
                  }}
                >
                  <span style={{ color: "#64748b" }}>CO2 Reading:</span>
                  <span style={{ fontWeight: 700 }}>{Math.round(r.co2)} ppm</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 6 }}>
                  <span style={{ color: "#64748b" }}>LPG Gas Reading:</span>
                  <span
                    style={{
                      fontWeight: 700,
                      color: r.lpg != null ? badgeStyles(st.tone).text : "#94a3b8",
                    }}
                  >
                    {r.lpg != null ? `${Math.round(r.lpg)} ppm` : "N/A (no gas sensor)"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span style={{ color: "#64748b" }}>Temp / Humidity:</span>
                  <span style={{ fontWeight: 700 }}>
                    {r.temp.toFixed(1)}&deg;C / {Math.round(r.humidity)}%
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Badge label={r.online ? "Online" : "Offline"} tone={r.online ? "success" : "neutral"} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => canToggle && toggleOnline(r.id)}
                    disabled={!canToggle}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      border: "1px solid #e2e8f0",
                      background: "#fff",
                      borderRadius: 6,
                      padding: "6px 10px",
                      cursor: canToggle ? "pointer" : "not-allowed",
                      opacity: canToggle ? 1 : 0.5,
                    }}
                  >
                    {r.online ? "Offline" : "Online"}
                  </button>
                  <button
                    onClick={() => canManage && removeRoom(r.id)}
                    disabled={!canManage}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      border: "1px solid #fecaca",
                      background: "#fff",
                      color: "#dc2626",
                      borderRadius: 6,
                      padding: "6px 10px",
                      cursor: canManage ? "pointer" : "not-allowed",
                      opacity: canManage ? 1 : 0.5,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <Trash2 size={12} /> Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <Info size={15} color="#0d9488" />
        <span style={{ fontWeight: 700, fontSize: 14.5, color: "#0f172a" }}>
          Hardware Sensor Technical Reference
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {SENSOR_INFO.map((s: any) => (
          <div
            key={s.id}
            style={{
              background: "#fff",
              border: "1px solid #eef1f4",
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>{s.title}</span>
              <Badge label={s.id} tone="success" />
            </div>
            <p style={{ fontSize: 12.5, color: "#64748b", lineHeight: 1.6, margin: "8px 0" }}>
              {s.body}
            </p>
            <div style={{ fontSize: 12, color: "#334155", marginBottom: 4 }}>
              <b>Gases Monitored:</b> {s.gases}
            </div>
            <div style={{ fontSize: 12, color: "#334155", marginBottom: 4 }}>
              <b>Sensing Range:</b> {s.range}
            </div>
            <div style={{ fontSize: 12, color: "#334155", marginBottom: 10 }}>
              <b>Accuracy Rating:</b> {s.accuracy}
            </div>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: "#94a3b8",
                letterSpacing: 0.5,
                marginBottom: 6,
              }}
            >
              KEY SPECIFICATIONS
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              {s.specs.map((sp: string) => (
                <div key={sp} style={{ fontSize: 12, color: "#334155", display: "flex", gap: 6 }}>
                  <span style={{ color: "#0d9488" }}>&bull;</span>
                  {sp}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}