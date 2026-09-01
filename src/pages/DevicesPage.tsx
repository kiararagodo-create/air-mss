import { useState } from "react";
import {
  Activity,
  Box,
  Building2,
  ChevronDown,
  Plus,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Room, Thresholds, getStatus, volumeOf } from "../data/Data";
import { Badge } from "../ui";

type User = {
  id: string;
  role: string;
  name?: string;
  email?: string;
};

type RoomForm = Partial<Room> & { submitLabel?: string };

// Edit these lists to add/remove dropdown options
const FLOOR_OPTIONS = ["Ground Floor", "2nd Floor", "3rd Floor",];

const CO2_SENSOR_OPTIONS = [
  "MH-Z19",
  "MH-Z19B",
  "MH-Z19C",
  "SCD30",
  "SCD40",
  "SCD41",
  "CCS811",
  "K30",
  "T6713",
];

const GAS_SENSOR_OPTIONS = [
  "MQ-2",
  "MQ-4",
  "MQ-5",
  "MQ-6",
  "MQ-7",
  "MQ-9",
  "MQ-135",
  "None (CO2 monitoring only)",
];

const TEMP_HUMIDITY_SENSOR_OPTIONS = [
  "DHT11",
  "DHT22",
  "SHT31",
  "SHT35",
  "BME280",
  "BME680",
  "SI7021",
  "None (No temp/humidity sensor)",
];

const selectStyle = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  color: "#0f172a",
  width: "100%",
  boxSizing: "border-box" as const,
  background: "#fff",
};

function AddDeviceModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (form: RoomForm) => void;
}) {
  const [form, setForm] = useState<any>({
    id: "",
    name: "",
    floor: FLOOR_OPTIONS[0],
    length: "6",
    width: "4",
    height: "3",
    co2Sensor: CO2_SENSOR_OPTIONS[0],
    gasSensor: GAS_SENSOR_OPTIONS[0],
    tempHumiditySensor: TEMP_HUMIDITY_SENSOR_OPTIONS[0],
    co2: 400,
    lpg: 0,
    temp: 25,
    humidity: 50,
    online: true,
  });

  const updateField = (field: string, value: any) => {
    setForm((prev: any) => ({ ...prev, [field]: value }));
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.35)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 520,
          background: "#fff",
          borderRadius: 16,
          padding: 20,
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.15)",
          maxHeight: "90vh",
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>Add New IoT Device</h2>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              color: "#475569",
            }}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="air-modal-grid">
          {[
            { label: "Device ID", field: "id", type: "text" },
            { label: "Name", field: "name", type: "text" },
            { label: "Length (m)", field: "length", type: "number" },
            { label: "Width (m)", field: "width", type: "number" },
            { label: "Height (m)", field: "height", type: "number" },
          ].map(({ label, field, type }) => (
            <label key={field} style={{ display: "flex", flexDirection: "column", fontSize: 12, color: "#334155" }}>
              <span style={{ marginBottom: 6 }}>{label}</span>
              <input
                value={form[field] ?? ""}
                type={type}
                onChange={(event) => updateField(field, type === "number" ? Number(event.target.value) : event.target.value)}
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 13,
                  color: "#0f172a",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            </label>
          ))}

          <label style={{ display: "flex", flexDirection: "column", fontSize: 12, color: "#334155" }}>
            <span style={{ marginBottom: 6 }}>Floor</span>
            <select value={form.floor} onChange={(event) => updateField("floor", event.target.value)} style={selectStyle}>
              {FLOOR_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", fontSize: 12, color: "#334155" }}>
            <span style={{ marginBottom: 6 }}>CO2 Sensor</span>
            <select value={form.co2Sensor} onChange={(event) => updateField("co2Sensor", event.target.value)} style={selectStyle}>
              {CO2_SENSOR_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", fontSize: 12, color: "#334155" }}>
            <span style={{ marginBottom: 6 }}>Gas Sensor</span>
            <select value={form.gasSensor} onChange={(event) => updateField("gasSensor", event.target.value)} style={selectStyle}>
              {GAS_SENSOR_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", fontSize: 12, color: "#334155" }}>
            <span style={{ marginBottom: 6 }}>Temp/Humidity Sensor</span>
            <select
              value={form.tempHumiditySensor}
              onChange={(event) => updateField("tempHumiditySensor", event.target.value)}
              style={selectStyle}
            >
              {TEMP_HUMIDITY_SENSOR_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
          <button
            onClick={onClose}
            type="button"
            style={{
              borderRadius: 8,
              padding: "10px 14px",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              color: "#475569",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(form as RoomForm)}
            type="button"
            style={{
              borderRadius: 8,
              padding: "10px 14px",
              background: "#0d9488",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Add Device
          </button>
        </div>
      </div>
    </div>
  );
}

function RemoveDeviceModal({
  room,
  onClose,
  onConfirm,
}: {
  room: Room;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.35)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: 16,
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "#fff",
          borderRadius: 16,
          padding: 20,
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.15)",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "#fef2f2",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Trash2 size={16} color="#dc2626" />
          </div>
          <h2 style={{ margin: 0, fontSize: 17, color: "#0f172a" }}>Remove Device</h2>
        </div>
        <p style={{ fontSize: 13.5, color: "#64748b", lineHeight: 1.6, margin: "0 0 18px" }}>
          Are you sure you want to remove <b style={{ color: "#0f172a" }}>{room.name}</b> ({room.id})? This
          device will stop reporting readings and this action cannot be undone.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={onClose}
            type="button"
            style={{
              borderRadius: 8,
              padding: "10px 14px",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              color: "#475569",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            type="button"
            style={{
              borderRadius: 8,
              padding: "10px 14px",
              background: "#dc2626",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Trash2 size={14} /> Remove Device
          </button>
        </div>
      </div>
    </div>
  );
}

interface DevicesPageProps {
  rooms: Room[];
  removeRoom: (id: string) => void;
  addRoom: (form: RoomForm) => Promise<void>;
  user: User;
  thresholds: Thresholds;
  toggleSiren: (id: string) => Promise<void>;
  muteAll: (muted: boolean) => Promise<void>;
}

export default function DevicesPage({
  rooms,
  removeRoom,
  addRoom,
  user,
  thresholds,
  toggleSiren,
  muteAll,
}: DevicesPageProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [roomToRemove, setRoomToRemove] = useState<Room | null>(null);
  const [closedFloors, setClosedFloors] = useState<Set<string>>(new Set());
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const canManage = user.role === "admin";

  const allMuted = rooms.length > 0 && rooms.every((r) => r.sirenMuted);

  // Group rooms by floor, preserving FLOOR_OPTIONS order first, then any
  // custom floor names present in the data that aren't in that list.
  const floorOrder = Array.from(new Set([...FLOOR_OPTIONS, ...rooms.map((r) => r.floor)]));
  const roomsByFloor = floorOrder
    .map((floor) => ({ floor, floorRooms: rooms.filter((r) => r.floor === floor) }))
    .filter((f) => f.floorRooms.length > 0);

  const toggleFloor = (floor: string) => {
    setClosedFloors((prev) => {
      const next = new Set(prev);
      if (next.has(floor)) next.delete(floor);
      else next.add(floor);
      return next;
    });
  };

  const toggleRoom = (id: string) => {
    setOpenRoomId((prev) => (prev === id ? null : id));
  };

  return (
    <div>
      <style>{`
        .air-modal-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        .air-floor-card {
          background: #fff;
          border: 1px solid #eef1f4;
          border-radius: 12px;
          margin-bottom: 16px;
          overflow: hidden;
        }
        .air-floor-header {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
          background: #fff;
          border: none;
          cursor: pointer;
          text-align: left;
        }
        .air-floor-icon {
          width: 36px;
          height: 36px;
          border-radius: 999px;
          background: #0d9488;
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .air-floor-count {
          font-size: 11.5;
          font-weight: 700;
          color: #475569;
          background: #f1f5f9;
          padding: 3px 10px;
          border-radius: 999px;
        }
        .air-floor-body {
          padding: 0 16px 16px;
        }
        .air-room-item {
          border: 1px solid #eef1f4;
          border-radius: 10px;
          margin-bottom: 10px;
          overflow: hidden;
        }
        .air-room-item:last-child {
          margin-bottom: 0;
        }
        .air-room-header {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          background: #fff;
          border: none;
          cursor: pointer;
          text-align: left;
          flex-wrap: wrap;
        }
        .air-room-id-pill {
          font-size: 11px;
          font-weight: 700;
          color: #475569;
          background: #f1f5f9;
          padding: 3px 9px;
          border-radius: 6px;
          flex-shrink: 0;
        }
        .air-room-body {
          padding: 14px;
          border-top: 3px solid #0d9488;
          background: #fafffe;
        }
        .air-room-body-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 20px;
          align-items: center;
          justify-content: space-between;
        }
        .air-readings-row {
          display: flex;
          flex-wrap: wrap;
          gap: 24px;
        }
        @media (max-width: 420px) {
          .air-modal-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 20,
          flexWrap: "wrap",
          gap: 12,
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
              whiteSpace: "nowrap",
            }}
          >
            <Plus size={15} /> Add New IoT Device
          </button>
        )}
      </div>

      {showAdd && (
        <AddDeviceModal
          onClose={() => setShowAdd(false)}
          onSubmit={async (form: RoomForm) => {
            await addRoom(form);
            setShowAdd(false);
          }}
        />
      )}

      {roomToRemove && (
        <RemoveDeviceModal
          room={roomToRemove}
          onClose={() => setRoomToRemove(null)}
          onConfirm={() => {
            removeRoom(roomToRemove.id);
            setRoomToRemove(null);
          }}
        />
      )}

      {canManage && rooms.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            background: "#fff",
            border: "1px solid #eef1f4",
            borderLeft: "4px solid #0d9488",
            borderRadius: 12,
            padding: "12px 16px",
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {allMuted ? <VolumeX size={16} color="#64748b" /> : <Volume2 size={16} color="#0d9488" />}
            <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
              Siren Control &mdash; all devices
            </span>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              Mutes/unmutes the physical buzzer on every registered device. Readings and dashboard
              alerts are unaffected.
            </span>
          </div>
          <button
            onClick={() => muteAll(!allMuted)}
            type="button"
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              border: allMuted ? "1px solid #e2e8f0" : "1px solid #fde68a",
              background: allMuted ? "#f8fafc" : "#fffbeb",
              color: allMuted ? "#475569" : "#b45309",
              borderRadius: 8,
              padding: "8px 14px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              whiteSpace: "nowrap",
            }}
          >
            {allMuted ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {allMuted ? "Unmute All" : "Mute All"}
          </button>
        </div>
      )}

      {roomsByFloor.length === 0 ? (
        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: "60px 20px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", marginBottom: 6 }}>
            No devices registered yet
          </div>
          <div style={{ fontSize: 13, color: "#64748b" }}>
            Use "Add New IoT Device" to register your first sensor node.
          </div>
        </div>
      ) : (
        roomsByFloor.map(({ floor, floorRooms }) => {
          const floorOpen = !closedFloors.has(floor);
          return (
            <div key={floor} className="air-floor-card">
              <button type="button" className="air-floor-header" onClick={() => toggleFloor(floor)}>
                <span className="air-floor-icon">
                  <Building2 size={18} />
                </span>
                <span style={{ fontWeight: 800, fontSize: 16, color: "#0f172a", letterSpacing: 0.3 }}>
                  {floor.toUpperCase()}
                </span>
                <span className="air-floor-count">
                  {floorRooms.length} room{floorRooms.length === 1 ? "" : "s"}
                </span>
                <span style={{ marginLeft: "auto", flexShrink: 0, display: "flex" }}>
                  <ChevronDown
                    size={18}
                    color="#0f172a"
                    style={{
                      transform: floorOpen ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.15s ease",
                    }}
                  />
                </span>
              </button>

              {floorOpen && (
                <div className="air-floor-body">
                  {floorRooms.map((room) => {
                    const st = getStatus(room, thresholds);
                    const isOpen = openRoomId === room.id;
                    return (
                      <div
                        key={room.id}
                        className="air-room-item"
                        style={{ borderColor: isOpen ? "#0d9488" : "#eef1f4" }}
                      >
                        <button type="button" className="air-room-header" onClick={() => toggleRoom(room.id)}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
                            <ChevronDown
                              size={16}
                              color="#94a3b8"
                              style={{
                                flexShrink: 0,
                                transform: isOpen ? "rotate(180deg)" : "rotate(-90deg)",
                                transition: "transform 0.15s ease",
                              }}
                            />
                            <span style={{ fontWeight: 800, fontSize: 15, color: "#0f172a" }}>{room.name}</span>
                            <span className="air-room-id-pill">{room.id}</span>
                            <Badge label={`CO2: ${room.co2Sensor}`} tone="success" />
                            {room.gasSensor && <Badge label={`Gas: ${room.gasSensor}`} tone="success" />}
                            {room.tempHumiditySensor && <Badge label={`T/H: ${room.tempHumiditySensor}`} tone="success" />}
                            <Badge label={st.label} tone={st.tone} />
                            {room.sirenMuted && <Badge label="Siren Muted" tone="neutral" />}
                          </div>
                          {!isOpen && (
                            <Badge
                              label={room.online ? "Online" : "Offline"}
                              tone={room.online ? "success" : "neutral"}
                            />
                          )}
                        </button>

                        {isOpen && (
                          <div className="air-room-body">
                            <div className="air-room-body-grid">
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <Box size={16} color="#0d9488" />
                                <div>
                                  <div style={{ fontSize: 11, color: "#64748b" }}>Room Size</div>
                                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0f172a" }}>
                                    {room.length}m x {room.width}m x {room.height}m: {volumeOf(room)} m3
                                  </div>
                                </div>
                              </div>

                              <div className="air-readings-row">
                                <div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#64748b" }}>
                                    <Activity size={13} /> Current Readings
                                  </div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 11, color: "#64748b" }}>CO2 Reading</div>
                                  <div style={{ fontSize: 17, fontWeight: 800, color: "#0d9488" }}>
                                    {room.co2 != null ? `${Math.round(room.co2)} ppm` : "N/A"}
                                  </div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 11, color: "#64748b" }}>LPG Gas Reading</div>
                                  <div
                                    style={{
                                      fontSize: 17,
                                      fontWeight: 800,
                                      color: room.lpg != null ? "#0d9488" : "#94a3b8",
                                    }}
                                  >
                                    {room.lpg != null ? `${Math.round(room.lpg)} ppm` : "N/A"}
                                  </div>
                                </div>
                                <div>
                                  <div style={{ fontSize: 11, color: "#64748b" }}>Temp / Humidity</div>
                                  <div style={{ fontSize: 17, fontWeight: 800, color: "#0d9488" }}>
                                    {room.tempHumiditySensor
                                      ? `${room.temp.toFixed(1)}\u00b0C / ${Math.round(room.humidity)}%`
                                      : "N/A"}
                                  </div>
                                </div>
                              </div>

                              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                <Badge
                                  label={room.online ? "Online" : "Offline"}
                                  tone={room.online ? "success" : "neutral"}
                                />
                                <button
                                  onClick={() => canManage && toggleSiren(room.id)}
                                  disabled={!canManage}
                                  type="button"
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 600,
                                    border: room.sirenMuted ? "1px solid #e2e8f0" : "1px solid #99f6e4",
                                    background: room.sirenMuted ? "#f8fafc" : "#fff",
                                    color: room.sirenMuted ? "#475569" : "#0d9488",
                                    borderRadius: 6,
                                    padding: "6px 10px",
                                    cursor: canManage ? "pointer" : "not-allowed",
                                    opacity: canManage ? 1 : 0.5,
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 4,
                                  }}
                                >
                                  {room.sirenMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                                  {room.sirenMuted ? "Muted" : "Siren On"}
                                </button>
                                <button
                                  onClick={() => canManage && setRoomToRemove(room)}
                                  disabled={!canManage}
                                  type="button"
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
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}