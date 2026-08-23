import { useState } from "react";
import { Info, Plus, Trash2 } from "lucide-react";
import { Room, SensorInfo, Thresholds, getStatus, volumeOf, deviceAgeLabel, SENSOR_INFO } from "../data/Data";
import { Badge, badgeStyles } from "../ui";

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
    occupancy: 1,
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
}

export default function DevicesPage({ rooms, removeRoom, addRoom, user, thresholds }: DevicesPageProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [roomToRemove, setRoomToRemove] = useState<Room | null>(null);
  const canManage = user.role === "admin";

  return (
    <div>
      <style>{`
        .air-modal-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        .air-device-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
          gap: 16px;
          margin-bottom: 28px;
        }
        .air-sensorinfo-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 16px;
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

      <div className="air-device-grid">
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
                minWidth: 0,
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
                {r.tempHumiditySensor && <Badge label={`T/H: ${r.tempHumiditySensor}`} tone="success" />}
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
                  <span style={{ fontWeight: 700 }}>{r.co2 != null ? `${Math.round(r.co2)} ppm` : "N/A"}</span>
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
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 6 }}>
                  <span style={{ color: "#64748b" }}>Temp / Humidity:</span>
                  <span style={{ fontWeight: 700 }}>
                    {r.tempHumiditySensor
                      ? `${r.temp.toFixed(1)}\u00b0C / ${Math.round(r.humidity)}%`
                      : "N/A (no sensor)"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span style={{ color: "#64748b" }}>Device Age:</span>
                  <span style={{ fontWeight: 700 }}>{deviceAgeLabel(r.installedAt)}</span>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <Badge label={r.online ? "Online" : "Offline"} tone={r.online ? "success" : "neutral"} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => canManage && setRoomToRemove(r)}
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
      <div className="air-sensorinfo-grid">
        {SENSOR_INFO.map((s: SensorInfo) => (
          <div
            key={s.id}
            style={{
              background: "#fff",
              border: "1px solid #eef1f4",
              borderRadius: 12,
              padding: 16,
              minWidth: 0,
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