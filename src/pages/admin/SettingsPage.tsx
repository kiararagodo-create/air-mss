import { useState, type CSSProperties } from "react";
import { Bell, Save, Shield, SlidersHorizontal, User, Volume2 } from "lucide-react";
import { Badge, Toggle } from "../../ui";

// Local type definitions to avoid depending on AdminDashboard module
type Settings = {
  emailAlerts: boolean;
  soundAlarms: boolean;
};

type SensorTier = { warning: number; high: number; danger: number };

type Thresholds = {
  co2: SensorTier;
  lpg: SensorTier;
};

type AppUser = {
  role: string;
  name: string;
  email: string;
  roleLabel: string;
  department?: string;
  accessScope?: string;
};

interface SettingsPageProps {
  settings: Settings;
  setSettings: (settings: Settings) => void;
  thresholds: Thresholds;
  setThresholds: (thresholds: Thresholds) => void;
  user: AppUser;
}

export default function SettingsPage({ settings, setSettings, thresholds, setThresholds, user }: SettingsPageProps) {
  const [local, setLocal] = useState<Settings>(settings);
  const [localThresholds, setLocalThresholds] = useState<Thresholds>(thresholds);
  const [saved, setSaved] = useState(false);

  function save() {
    setSettings(local);
    setThresholds(localThresholds);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const field: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    fontSize: 13.5,
  };
  const smallLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: "#64748b" };

  const overviewRows: [string, string][] = [
    ["Email Dispatches:", local.emailAlerts ? "Enabled" : "Disabled"],
    ["Audible Siren Alarms:", local.soundAlarms ? "Active" : "Inactive"],
    [
      "CO2 tiers:",
      `${localThresholds.co2.warning} / ${localThresholds.co2.high} / ${localThresholds.co2.danger} ppm`,
    ],
    [
      "LPG tiers:",
      `${localThresholds.lpg.warning} / ${localThresholds.lpg.high} / ${localThresholds.lpg.danger} ppm`,
    ],
  ];

  return (
    <div>
      <style>{`
        .air-settings-grid {
          display: grid;
          grid-template-columns: 1fr 320px;
          gap: 16px;
          align-items: start;
        }
        .air-threshold-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        @media (max-width: 860px) {
          .air-settings-grid {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 420px) {
          .air-threshold-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", margin: 0 }}>
        Platform Safety & System Configuration
      </h1>
      <p style={{ color: "#64748b", fontSize: 13.5, margin: "4px 0 20px" }}>
        Manage alert notifications, safety limits, and user profile parameters
      </p>

      <div className="air-settings-grid">
        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: 18,
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontWeight: 700,
              fontSize: 14,
              color: "#0f172a",
              marginBottom: 14,
            }}
          >
            <SlidersHorizontal size={16} /> System Preferences & Safety Controls
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "#f8fafc",
              borderRadius: 10,
              padding: 14,
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Bell size={16} color="#0d9488" style={{ marginTop: 2 }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a" }}>
                  Email Safety Notifications
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  Send immediate email dispatches when CO2 or LPG breaches safety limits.
                </div>
              </div>
            </div>
            <Toggle checked={local.emailAlerts} onChange={(v: boolean) => setLocal({ ...local, emailAlerts: v })} />
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "#f8fafc",
              borderRadius: 10,
              padding: 14,
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Volume2 size={16} color="#0d9488" style={{ marginTop: 2 }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a" }}>
                  Audible Siren Alarms
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  Trigger campus buzzer siren on hardware units during gas leak risk states.
                </div>
              </div>
            </div>
            <Toggle checked={local.soundAlarms} onChange={(v: boolean) => setLocal({ ...local, soundAlarms: v })} />
          </div>

          <div style={{ background: "#f8fafc", borderRadius: 10, padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Shield size={15} color="#0d9488" />
              <span style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a" }}>
                CO2 Safety Thresholds (ppm)
              </span>
            </div>
            <div className="air-threshold-grid">
              <div>
                <label style={smallLabel}>WARNING</label>
                <input
                  type="number"
                  disabled={user.role !== "admin"}
                  style={{ ...field, marginTop: 4 }}
                  value={localThresholds.co2.warning}
                  onChange={(e) =>
                    setLocalThresholds({
                      ...localThresholds,
                      co2: { ...localThresholds.co2, warning: Number(e.target.value) },
                    })
                  }
                />
              </div>
              <div>
                <label style={smallLabel}>HIGH</label>
                <input
                  type="number"
                  disabled={user.role !== "admin"}
                  style={{ ...field, marginTop: 4 }}
                  value={localThresholds.co2.high}
                  onChange={(e) =>
                    setLocalThresholds({
                      ...localThresholds,
                      co2: { ...localThresholds.co2, high: Number(e.target.value) },
                    })
                  }
                />
              </div>
              <div>
                <label style={smallLabel}>DANGER</label>
                <input
                  type="number"
                  disabled={user.role !== "admin"}
                  style={{ ...field, marginTop: 4 }}
                  value={localThresholds.co2.danger}
                  onChange={(e) =>
                    setLocalThresholds({
                      ...localThresholds,
                      co2: { ...localThresholds.co2, danger: Number(e.target.value) },
                    })
                  }
                />
              </div>
            </div>
          </div>

          <div style={{ background: "#f8fafc", borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Shield size={15} color="#0d9488" />
              <span style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a" }}>
                LPG Safety Thresholds (ppm)
              </span>
            </div>
            <div className="air-threshold-grid">
              <div>
                <label style={smallLabel}>WARNING</label>
                <input
                  type="number"
                  disabled={user.role !== "admin"}
                  style={{ ...field, marginTop: 4 }}
                  value={localThresholds.lpg.warning}
                  onChange={(e) =>
                    setLocalThresholds({
                      ...localThresholds,
                      lpg: { ...localThresholds.lpg, warning: Number(e.target.value) },
                    })
                  }
                />
              </div>
              <div>
                <label style={smallLabel}>HIGH</label>
                <input
                  type="number"
                  disabled={user.role !== "admin"}
                  style={{ ...field, marginTop: 4 }}
                  value={localThresholds.lpg.high}
                  onChange={(e) =>
                    setLocalThresholds({
                      ...localThresholds,
                      lpg: { ...localThresholds.lpg, high: Number(e.target.value) },
                    })
                  }
                />
              </div>
              <div>
                <label style={smallLabel}>DANGER</label>
                <input
                  type="number"
                  disabled={user.role !== "admin"}
                  style={{ ...field, marginTop: 4 }}
                  value={localThresholds.lpg.danger}
                  onChange={(e) =>
                    setLocalThresholds({
                      ...localThresholds,
                      lpg: { ...localThresholds.lpg, danger: Number(e.target.value) },
                    })
                  }
                />
              </div>
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>
              Defaults follow a common teaching model, not a cited standard. Justify final figures
              with ASHRAE 62.1 / NIOSH (CO2) and NFPA 58 or your sensor's calibrated data (LPG).
            </div>
          </div>

          {user.role === "admin" && (
            <button
              onClick={save}
              style={{
                background: "#0d9488",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "11px 18px",
                fontSize: 13.5,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
              }}
            >
              <Save size={15} /> {saved ? "Configuration saved" : "Save Configuration"}
            </button>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              background: "#fff",
              border: "1px solid #eef1f4",
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 700,
                fontSize: 13,
                color: "#0f172a",
                marginBottom: 12,
              }}
            >
              <User size={15} /> Logged-in Personnel Details
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: "#0d9488",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                }}
              >
                {user.name.charAt(0)}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{user.name}</div>
                <div style={{ fontSize: 11.5, color: "#94a3b8" }}>{user.email}</div>
                <Badge label={user.roleLabel} tone="success" />
              </div>
            </div>
            <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: 10, fontSize: 12.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: "#94a3b8" }}>Department:</span>
                <span style={{ fontWeight: 600, textAlign: "right" }}>{user.department}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#94a3b8" }}>Access Scope:</span>
                <span style={{ fontWeight: 600 }}>{user.accessScope}</span>
              </div>
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              border: "1px solid #eef1f4",
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 10 }}>
              ACTIVE CONFIGURATION OVERVIEW
            </div>
            {overviewRows.map(([label2, val]) => (
              <div
                key={label2}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12.5,
                  padding: "5px 0",
                }}
              >
                <span style={{ color: "#64748b" }}>{label2}</span>
                <span style={{ fontWeight: 700, color: "#0d9488", textAlign: "right" }}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}