import { useState } from "react";
import { Bell, CheckCircle2, ChevronDown, Droplets, Thermometer, X } from "lucide-react";

// Lightweight local replacements for ./ui to avoid missing-module errors.
// Kept minimal — styling inline to match expected usage in this file.
const badgeStyles: ((tone: Tone) => { text: string }) & { base: React.CSSProperties } =
  Object.assign(
    (tone: Tone) => ({ text: getToneColor(tone) }),
    {
      base: {
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        borderRadius: 8,
        fontWeight: 700,
        fontSize: 12,
      } as React.CSSProperties,
    }
  );

const toneColors: Record<Tone, string> = {
  success: "#10b981",
  warning: "#f59e0b",
  high: "#d97706",
  danger: "#ef4444",
  neutral: "#94a3b8",
};

function getToneColor(tone: Tone): string {
  return toneColors[tone];
}

function ToneDot({ tone }: { tone: Tone }) {
  const map: Record<Tone, string> = {
    success: "#10b981",
    warning: "#f59e0b",
    high: "#d97706",
    danger: "#ef4444",
    neutral: "#94a3b8",
  };
  return (
    <span style={{ width: 10, height: 10, borderRadius: 6, background: map[tone] }} />
  );
}

function Badge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span style={{ ...badgeStyles.base, background: "#fff", border: "1px solid #eef1f4" }}>
      <ToneDot tone={tone} />
      <span style={{ color: "#334155" }}>{label}</span>
    </span>
  );
}

// Minimal local replacements for missing ./data module to avoid build errors.
function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function getStatus(room: Room, thresholds: Thresholds) {
  const co2 = room.co2;
  const lpg = room.lpg ?? 0;
  const co2Severity =
    co2 == null
      ? 0
      : co2 > thresholds.co2.danger
      ? 3
      : co2 > thresholds.co2.high
      ? 2
      : co2 > thresholds.co2.warning
      ? 1
      : 0;
  const lpgSeverity = lpg > thresholds.lpg.danger ? 3 : lpg > thresholds.lpg.high ? 2 : lpg > thresholds.lpg.warning ? 1 : 0;
  const severity = Math.max(co2Severity, lpgSeverity);
  const tone: Tone[] = ["success", "warning", "high", "danger"];
  const labels = ["OK", "Monitor", "Investigate", "DANGER"];
  return { severity, tone: tone[severity] as Tone, label: labels[severity] };
}

type ActionPlan = { title: string; body: string };

function actionMessage(room: Room, thresholds: Thresholds): ActionPlan {
  const status = getStatus(room, thresholds).severity;
  if (status === 0)
    return {
      title: "No action needed",
      body: "CO2 and LPG levels are within safe limits. Continue monitoring the area.",
    };
  if (status === 1)
    return {
      title: "Monitor conditions",
      body: "Gas levels are elevated; observe the area closely and reduce exposure if possible.",
    };
  if (status === 2)
    return {
      title: "Investigate immediately",
      body: "High concentrations detected. Inspect the area immediately and address any sources.",
    };
  return {
    title: "Evacuate area and ventilate",
    body: "Dangerous gas levels detected. Evacuate immediately and ventilate the area before re-entry.",
  };
}

function volumeOf(_sensor: Room | string) {
  // placeholder: original function likely maps a Room or sensor ID to a room volume in m3.
  // If passed a Room, we could derive volume from occupancy as a fallback; keep simple for now.
  if (typeof _sensor === "string") return 0;
  return 0;
}

// Local type definitions to avoid depending on AdminDashboard module.
// Keep fields minimal to match usage in this file.
type SensorName = string;
export interface Room {
  id: string;
  name: string;
  floor: string;
  co2: number | null;
  lpg?: number | null;
  online: boolean;
  co2Sensor: SensorName;
  gasSensor?: SensorName | null;
  temp: number;
  humidity: number;
  occupancy: number;
}

export interface Thresholds {
  co2: { warning: number; high: number; danger: number };
  lpg: { warning: number; high: number; danger: number };
}

type Tone = "success" | "warning" | "high" | "danger" | "neutral";

// Which summary box is active, drives both the left-hand room list filter
// and the details panel shown above the main grid.
type SummaryFilter = "all" | "safe" | "warningHigh" | "danger" | null;

interface DashboardPageProps {
  rooms: Room[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  thresholds: Thresholds;
}


export default function DashboardPage({ rooms, selectedId, setSelectedId, thresholds }: DashboardPageProps) {
  const [activeFilter, setActiveFilter] = useState<SummaryFilter>(null);

  // Empty state: no rooms registered yet — avoid crashing on rooms[0]/undefined.
  if (rooms.length === 0) {
    return (
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", margin: 0 }}>
          IoT Environmental Safety Dashboard
        </h1>
        <p style={{ color: "#64748b", fontSize: 13.5, margin: "4px 0 20px" }}>
          Real-time CO2 & LPG telemetry across Asian College premises
        </p>
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
            No rooms registered yet
          </div>
          <div style={{ fontSize: 13, color: "#64748b" }}>
            Add a device from the Devices page to start monitoring.
          </div>
        </div>
      </div>
    );
  }

  const selected = rooms.find((r) => r.id === selectedId) || rooms[0];
  const status = getStatus(selected, thresholds);

  const safeRooms = rooms.filter((r) => getStatus(r, thresholds).severity === 0);
  // ...the rest of your original function continues unchanged from he
  const warningHighRooms = rooms.filter((r) => {
    const s = getStatus(r, thresholds).severity;
    return s === 1 || s === 2;
  });
  const dangerRooms = rooms.filter((r) => getStatus(r, thresholds).severity === 3);

  const summaryCards: { key: SummaryFilter; label: string; value: number; color: string }[] = [
    { key: "all", label: "ROOMS MONITORED", value: rooms.length, color: "#1f2937" },
    { key: "safe", label: "SAFE ROOMS", value: safeRooms.length, color: "#0d9488" },
    { key: "warningHigh", label: "WARNING / HIGH", value: warningHighRooms.length, color: "#d97706" },
    { key: "danger", label: "DANGER ROOMS", value: dangerRooms.length, color: "#dc2626" },
  ];

  const filterRoomMap: Record<Exclude<SummaryFilter, null>, Room[]> = {
    all: rooms,
    safe: safeRooms,
    warningHigh: warningHighRooms,
    danger: dangerRooms,
  };

  const filterTitles: Record<Exclude<SummaryFilter, null>, string> = {
    all: "All Monitored Rooms",
    safe: "Safe Rooms",
    warningHigh: "Warning / High Rooms",
    danger: "Danger Rooms",
  };

  // Rooms shown in the left-hand list — filtered when a summary box is active.
  const listRooms = activeFilter ? filterRoomMap[activeFilter] : rooms;

  const handleSummaryClick = (key: SummaryFilter) => {
    setActiveFilter((prev) => (prev === key ? null : key));
  };

  const co2Pct =
    selected.co2 != null ? clamp((selected.co2 / thresholds.co2.danger) * 100, 0, 100) : 0;
  const lpgPct = selected.lpg != null ? clamp((selected.lpg / thresholds.lpg.danger) * 100, 0, 100) : 0;
  const action = actionMessage(selected, thresholds);

  const co2Guide: [string, string, Tone][] = [
    [`< ${thresholds.co2.warning} ppm`, "Safe / Good", "success"],
    [`${thresholds.co2.warning} - ${thresholds.co2.high} ppm`, "Warning", "warning"],
    [`${thresholds.co2.high} - ${thresholds.co2.danger} ppm`, "High Gas", "high"],
    [`> ${thresholds.co2.danger} ppm`, "Danger", "danger"],
  ];

  const lpgGuide: [string, string, Tone][] = [
    [`< ${thresholds.lpg.warning} ppm`, "Safe", "success"],
    [`${thresholds.lpg.warning} - ${thresholds.lpg.high} ppm`, "Low Leak", "warning"],
    [`${thresholds.lpg.high} - ${thresholds.lpg.danger} ppm`, "Moderate Leak", "high"],
    [`> ${thresholds.lpg.danger} ppm`, "Dangerous", "danger"],
  ];

  // DHT22 reference guide — matches the ESP32 firmware's alarm thresholds
  // (TEMP_ALARM_LOW_C/HIGH_C = 5/35, HUM_ALARM_LOW/HIGH = 20/80) so this
  // card reflects what actually triggers the physical buzzer.
  const tempGuide: [string, string, Tone][] = [
    ["5\u00b0C - 35\u00b0C", "Safe", "success"],
    ["< 5\u00b0C", "Too Cold", "danger"],
    ["> 35\u00b0C", "Too Hot", "danger"],
  ];

  const humidityGuide: [string, string, Tone][] = [
    ["20% - 80%", "Safe", "success"],
    ["< 20%", "Too Dry", "danger"],
    ["> 80%", "Too Humid", "danger"],
  ];

  return (
    <div>
      <style>{`
        .air-summary-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 14px;
          margin-bottom: 20px;
        }
        .air-summary-card {
          background: #fff;
          border: 1px solid #eef1f4;
          border-radius: 12px;
          padding: 14px 16px;
          cursor: pointer;
          text-align: left;
          transition: box-shadow 0.15s ease, border-color 0.15s ease;
        }
        .air-summary-card:hover {
          box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
        }
        .air-dashboard-grid {
          display: grid;
          grid-template-columns: 280px 1fr 250px;
          gap: 16px;
          align-items: start;
        }
        .air-detail-subgrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .air-gauge-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin: 16px 0;
        }
        @media (max-width: 640px) {
          .air-summary-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (max-width: 1100px) {
          .air-dashboard-grid {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 480px) {
          .air-gauge-grid {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 380px) {
          .air-detail-subgrid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", margin: 0 }}>
        IoT Environmental Safety Dashboard
      </h1>
      <p style={{ color: "#64748b", fontSize: 13.5, margin: "4px 0 20px" }}>
        Real-time CO2 & LPG telemetry across Asian College premises
      </p>

      <div className="air-summary-grid">
        {summaryCards.map((c) => {
          const isActive = activeFilter === c.key;
          return (
            <button
              key={c.label}
              type="button"
              className="air-summary-card"
              onClick={() => handleSummaryClick(c.key)}
              style={{
                border: isActive ? `1px solid ${c.color}` : "1px solid #eef1f4",
                boxShadow: isActive ? `0 0 0 3px ${c.color}1a` : "none",
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: "#94a3b8",
                  letterSpacing: 0.5,
                }}
              >
                {c.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: c.color, marginTop: 4 }}>
                {c.value}
              </div>
            </button>
          );
        })}
      </div>

      {activeFilter && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: 16,
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontWeight: 800, fontSize: 15, color: "#0f172a" }}>
              {filterTitles[activeFilter]} ({filterRoomMap[activeFilter].length})
            </span>
            <button
              type="button"
              onClick={() => setActiveFilter(null)}
              style={{ border: "none", background: "none", cursor: "pointer", display: "flex" }}
            >
              <X size={16} color="#94a3b8" />
            </button>
          </div>

          {filterRoomMap[activeFilter].length === 0 ? (
            <div style={{ fontSize: 13, color: "#94a3b8" }}>No rooms in this category right now.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              {filterRoomMap[activeFilter].map((r) => {
                const st = getStatus(r, thresholds);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    style={{
                      textAlign: "left",
                      border: r.id === selected.id ? "1px solid #0d9488" : "1px solid #eef1f4",
                      background: r.id === selected.id ? "#f0faf7" : "#f8fafc",
                      borderRadius: 10,
                      padding: 10,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.4 }}>
                        {r.floor.toUpperCase()}
                      </span>
                      <Badge label={st.label} tone={st.tone} />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a", marginTop: 2 }}>
                      {r.name}
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>ID: {r.id}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12 }}>
                      <span style={{ color: "#334155" }}>
                        {r.co2 != null ? `${Math.round(r.co2)} CO2 ppm` : "N/A"}
                      </span>
                      <span style={{ color: "#334155" }}>
                        {r.lpg != null ? `${Math.round(r.lpg)} LPG ppm` : "N/A"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="air-dashboard-grid">
        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: 14,
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 13,
              fontWeight: 700,
              color: "#0f172a",
              marginBottom: 10,
            }}
          >
            <span>MONITORED ROOMS</span>
            <span style={{ color: "#94a3b8", fontWeight: 500 }}>
              {listRooms.length} {activeFilter ? "Shown" : "Installed"}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {listRooms.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "#94a3b8" }}>No rooms match this filter.</div>
            ) : (
              listRooms.map((r) => {
                const st = getStatus(r, thresholds);
                const active = r.id === selected.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    style={{
                      textAlign: "left",
                      border: active ? "1px solid #0d9488" : "1px solid #eef1f4",
                      background: active ? "#f0faf7" : "#fff",
                      borderRadius: 10,
                      padding: 10,
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: "#94a3b8",
                          letterSpacing: 0.4,
                        }}
                      >
                        {r.floor.toUpperCase()}
                      </span>
                      <Badge label={st.label} tone={st.tone} />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginTop: 2 }}>
                      {r.name}
                    </div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>ID: {r.id}</div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginTop: 6,
                        fontSize: 12,
                      }}
                    >
                      <span style={{ color: "#334155" }}>
                        {r.co2 != null ? `${Math.round(r.co2)} CO2 ppm` : "N/A"}
                      </span>
                      <span style={{ color: "#334155" }}>
                        {r.lpg != null ? `${Math.round(r.lpg)} LPG ppm` : "N/A"}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 800, fontSize: 16, color: "#0f172a" }}>
                  {selected.name}
                </span>
                <ChevronDown size={16} color="#94a3b8" />
                <span style={{ fontSize: 12, color: "#94a3b8" }}>{selected.floor}</span>
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>
                ID: {selected.id} &middot; {volumeOf(selected)} m3 &middot; {selected.occupancy}{" "}
                occupants
              </div>
            </div>
            <Badge
              label={selected.online ? "ONLINE" : "OFFLINE"}
              tone={selected.online ? "success" : "neutral"}
            />
          </div>

          <div className="air-gauge-grid">
            {/* CO2 gauge */}
            <div>
              <div style={{ textAlign: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5 }}>
                  CO2 &middot; {selected.co2Sensor}
                </div>
                <div
                  style={{
                    fontSize: 34,
                    fontWeight: 800,
                    color: selected.co2 != null ? badgeStyles(status.tone).text : "#94a3b8",
                  }}
                >
                  {selected.co2 != null ? Math.round(selected.co2) : "N/A"}
                  {selected.co2 != null && (
                    <span style={{ fontSize: 15, color: "#64748b", fontWeight: 600 }}> ppm</span>
                  )}
                </div>
              </div>
              <div
                style={{
                  background: "#f1f5f9",
                  borderRadius: 999,
                  height: 8,
                  margin: "10px 0 4px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${co2Pct}%`,
                    height: "100%",
                    background: selected.co2 != null ? badgeStyles(status.tone).text : "#e2e8f0",
                    borderRadius: 999,
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "#94a3b8" }}>
                <span>SAFE (0)</span>
                <span>DANGER ({thresholds.co2.danger})</span>
              </div>
              {selected.co2 == null && (
                <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 4 }}>No CO2 sensor installed</div>
              )}
            </div>

            {/* LPG gauge */}
            <div>
              <div style={{ textAlign: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5 }}>
                  LPG &middot; {selected.gasSensor ?? "No sensor"}
                </div>
                <div
                  style={{
                    fontSize: 34,
                    fontWeight: 800,
                    color: selected.lpg != null ? badgeStyles(getStatus(selected, thresholds).tone).text : "#94a3b8",
                  }}
                >
                  {selected.lpg != null ? Math.round(selected.lpg) : "N/A"}
                  {selected.lpg != null && <span style={{ fontSize: 15, color: "#64748b", fontWeight: 600 }}> ppm</span>}
                </div>
              </div>
              <div
                style={{
                  background: "#f1f5f9",
                  borderRadius: 999,
                  height: 8,
                  margin: "10px 0 4px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${lpgPct}%`,
                    height: "100%",
                    background: selected.lpg != null ? badgeStyles(status.tone).text : "#e2e8f0",
                    borderRadius: 999,
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "#94a3b8" }}>
                <span>SAFE (0)</span>
                <span>DANGER ({thresholds.lpg.danger})</span>
              </div>
              {selected.lpg == null && (
                <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 4 }}>No gas sensor installed</div>
              )}
            </div>
          </div>

          <div className="air-detail-subgrid">
            <div
              style={{
                background: "#f8fafc",
                borderRadius: 10,
                padding: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Thermometer size={16} color="#0d9488" />
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8" }}>TEMPERATURE</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>
                  {selected.temp.toFixed(1)} &deg;C
                </div>
              </div>
            </div>
            <div
              style={{
                background: "#f8fafc",
                borderRadius: 10,
                padding: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Droplets size={16} color="#0d9488" />
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8" }}>HUMIDITY</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>
                  {Math.round(selected.humidity)}%
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              background: "#0f172a",
              borderRadius: 12,
              padding: 16,
              color: "#fff",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.5,
                color: "#cbd5e1",
                marginBottom: 10,
              }}
            >
              <Bell size={13} /> ACTION PLAN
            </div>
            <div
              style={{
                background: "rgba(255,255,255,0.06)",
                borderRadius: 10,
                padding: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontWeight: 700,
                  fontSize: 13,
                  color:
                    status.tone === "success"
                      ? "#5DCAA5"
                      : status.tone === "warning"
                      ? "#FAC775"
                      : status.tone === "high"
                      ? "#F0997B"
                      : "#F09595",
                  marginBottom: 6,
                }}
              >
                <CheckCircle2 size={14} /> {action.title.toUpperCase()}
              </div>
              <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5 }}>
                {action.body}
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
              CO2 REFERENCE GUIDE
            </div>
            {co2Guide.map(([range, label, tone]) => (
              <div
                key={range}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 12.5,
                  padding: "5px 0",
                }}
              >
                <span style={{ color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
                  <ToneDot tone={tone} /> {range}
                </span>
                <span style={{ color: badgeStyles(tone).text, fontWeight: 700 }}>{label}</span>
              </div>
            ))}
            <div
              style={{
                fontSize: 10.5,
                color: "#94a3b8",
                marginTop: 6,
                borderTop: "1px solid #f1f5f9",
                paddingTop: 6,
              }}
            >
              &gt;5000 ppm approaches the OSHA occupational exposure limit - immediate evacuation.
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
              LPG REFERENCE GUIDE
            </div>
            {lpgGuide.map(([range, label, tone]) => (
              <div
                key={range}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 12.5,
                  padding: "5px 0",
                }}
              >
                <span style={{ color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
                  <ToneDot tone={tone} /> {range}
                </span>
                <span style={{ color: badgeStyles(tone).text, fontWeight: 700 }}>{label}</span>
              </div>
            ))}
            <div
              style={{
                fontSize: 10.5,
                color: "#94a3b8",
                marginTop: 6,
                borderTop: "1px solid #f1f5f9",
                paddingTop: 6,
              }}
            >
              Lower explosive limit (LEL) is roughly 21,000 ppm (~2.1% by volume) - extreme danger.
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
              TEMP & HUMIDITY REFERENCE GUIDE (DHT22)
            </div>
            {tempGuide.map(([range, label, tone]) => (
              <div
                key={range}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 12.5,
                  padding: "5px 0",
                }}
              >
                <span style={{ color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
                  <ToneDot tone={tone} /> {range}
                </span>
                <span style={{ color: badgeStyles(tone).text, fontWeight: 700 }}>{label}</span>
              </div>
            ))}
            <div
              style={{
                fontSize: 10.5,
                color: "#94a3b8",
                margin: "6px 0",
                borderTop: "1px solid #f1f5f9",
                paddingTop: 6,
              }}
            >
              Humidity
            </div>
            {humidityGuide.map(([range, label, tone]) => (
              <div
                key={range}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: 12.5,
                  padding: "5px 0",
                }}
              >
                <span style={{ color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
                  <ToneDot tone={tone} /> {range}
                </span>
                <span style={{ color: badgeStyles(tone).text, fontWeight: 700 }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}