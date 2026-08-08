import { useState, type CSSProperties } from "react";
import { Ruler, X } from "lucide-react";

// Local RoomForm type (was imported from AdminDashboard which may not exist in this scope)
type RoomForm = {
  name: string;
  floor: string;
  gasSensor: string;
  length: number;
  width: number;
  height: number;
  occupancy: number;
};

interface AddDeviceModalProps {
  onClose: () => void;
  onSubmit: (form: RoomForm) => void;
}

export default function AddDeviceModal({ onClose, onSubmit }: AddDeviceModalProps) {
  const [form, setForm] = useState<RoomForm>({
    name: "",
    floor: "",
    gasSensor: "MQ-6",
    length: 6,
    width: 5,
    height: 3,
    occupancy: 20,
  });

  function update<K extends keyof RoomForm>(field: K, value: RoomForm[K]) {
    setForm({ ...form, [field]: value });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.floor.trim()) return;
    onSubmit(form);
  }

  const field: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    fontSize: 13.5,
    marginTop: 4,
  };
  const label: CSSProperties = { fontSize: 11.5, fontWeight: 700, color: "#64748b" };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        overflowY: "auto",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{
          background: "#fff",
          borderRadius: 14,
          padding: 22,
          width: 420,
          maxWidth: "100%",
          margin: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <span style={{ fontWeight: 800, fontSize: 16, color: "#0f172a" }}>
            Register new IoT node
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ border: "none", background: "none", cursor: "pointer" }}
          >
            <X size={18} color="#94a3b8" />
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 10,
            marginBottom: 10,
          }}
        >
          <div>
            <label style={label}>ROOM NAME</label>
            <input
              style={field}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="e.g. Server Room"
            />
          </div>
          <div>
            <label style={label}>FLOOR</label>
            <input
              style={field}
              value={form.floor}
              onChange={(e) => update("floor", e.target.value)}
              placeholder="e.g. 4th Floor"
            />
          </div>
        </div>

        <label style={label}>CO2 MODULE (always installed)</label>
        <div style={{ ...field, background: "#f8fafc", color: "#64748b" }}>
          MH-Z19C (NDIR CO2 sensor)
        </div>

        <label style={{ ...label, display: "block", marginTop: 10 }}>
          LPG / GAS MODULE (optional - add for kitchens, labs, storage areas)
        </label>
        <select
          style={field}
          value={form.gasSensor}
          onChange={(e) => update("gasSensor", e.target.value)}
        >
          <option value="MQ-6">MQ-6 (LPG / propane / butane)</option>
          <option value="none">None (CO2 monitoring only)</option>
        </select>

        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "14px 0 6px" }}>
          <Ruler size={14} color="#0d9488" />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
            Room dimensions (meters)
          </span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))",
            gap: 10,
            marginBottom: 8,
          }}
        >
          <div>
            <label style={label}>LENGTH</label>
            <input
              type="number"
              step="0.1"
              style={field}
              value={form.length}
              onChange={(e) => update("length", Number(e.target.value))}
            />
          </div>
          <div>
            <label style={label}>WIDTH</label>
            <input
              type="number"
              step="0.1"
              style={field}
              value={form.width}
              onChange={(e) => update("width", Number(e.target.value))}
            />
          </div>
          <div>
            <label style={label}>HEIGHT</label>
            <input
              type="number"
              step="0.1"
              style={field}
              value={form.height}
              onChange={(e) => update("height", Number(e.target.value))}
            />
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: "#94a3b8", marginBottom: 10 }}>
          Volume = {Math.round(form.length * form.width * form.height * 10) / 10} m3
        </div>

        <label style={label}>OCCUPANCY</label>
        <input
          type="number"
          style={field}
          value={form.occupancy}
          onChange={(e) => update("occupancy", Number(e.target.value))}
        />

        <button
          type="submit"
          style={{
            width: "100%",
            marginTop: 16,
            background: "#0d9488",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "11px 0",
            fontSize: 13.5,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Add device
        </button>
      </form>
    </div>
  );
}