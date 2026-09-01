import { useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  ChevronDown,
  Droplets,
  ShieldCheck,
  Thermometer,
  Wifi,
} from "lucide-react";
import DangerAlarmBanner from "../components/DangerAlarmBanner";

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

const toneBg: Record<Tone, string> = {
  success: "#ecfdf5",
  warning: "#fffbeb",
  high: "#fff7ed",
  danger: "#fef2f2",
  neutral: "#f8fafc",
};

function getToneColor(tone: Tone): string {
  return toneColors[tone];
}

function ToneDot({ tone }: { tone: Tone }) {
  return (
    <span style={{ width: 10, height: 10, borderRadius: 6, background: toneColors[tone], flexShrink: 0 }} />
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

// Computes a gas severity/tone/label from a single reading against its own
// thresholds only - kept separate from getStatus() (which combines CO2 +
// LPG for the overall room badge) so the CO2 gauge and LPG gauge can each
// reflect their own reading independently, instead of one gas's danger
// level bleeding color into the other's box.
function getGasStatus(
  value: number | null | undefined,
  t: { warning: number; high: number; danger: number }
): { severity: number; tone: Tone; label: string } {
  if (value == null) return { severity: 0, tone: "neutral", label: "N/A" };
  const severity = value > t.danger ? 3 : value > t.high ? 2 : value > t.warning ? 1 : 0;
  const tone: Tone[] = ["success", "warning", "high", "danger"];
  const labels = ["OK", "Monitor", "Investigate", "DANGER"];
  return { severity, tone: tone[severity], label: labels[severity] };
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
}

export interface Thresholds {
  co2: { warning: number; high: number; danger: number };
  lpg: { warning: number; high: number; danger: number };
}

type Tone = "success" | "warning" | "high" | "danger" | "neutral";

// Which summary box is active, drives the Monitored Rooms accordion filter.
type SummaryFilter = "all" | "safe" | "warningHigh" | "danger" | null;

interface DashboardPageProps {
  rooms: Room[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  thresholds: Thresholds;
}

// A single tier used to color/label a gauge's threshold bar.
type GaugeBreakpoint = { upper: number; tone: Tone; label: string; rangeText: string };

function buildGaugeSegments(breakpoints: GaugeBreakpoint[], maxDisplay: number) {
  let prev = 0;
  return breakpoints.map((bp) => {
    const upperClamped = bp.upper === Infinity ? maxDisplay : Math.min(bp.upper, maxDisplay);
    const widthPct = Math.max(0, ((upperClamped - prev) / maxDisplay) * 100);
    prev = upperClamped;
    return { ...bp, widthPct };
  });
}

function GaugePanel({
  sensorLabel,
  value,
  breakpoints,
  maxDisplay,
  activeTone,
}: {
  sensorLabel: string;
  value: number | null | undefined;
  breakpoints: GaugeBreakpoint[];
  maxDisplay: number;
  activeTone: Tone;
}) {
  const segments = buildGaugeSegments(breakpoints, maxDisplay);
  const hasValue = value != null;
  const markerPct = hasValue ? clamp((value as number) / maxDisplay, 0, 1) * 100 : 0;

  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5 }}>
          {sensorLabel}
        </div>
        <div
          style={{
            fontSize: 34,
            fontWeight: 800,
            color: hasValue ? badgeStyles(activeTone).text : "#94a3b8",
            lineHeight: 1.2,
          }}
        >
          {hasValue ? Math.round(value as number) : "N/A"}
          {hasValue && <span style={{ fontSize: 15, color: "#64748b", fontWeight: 600 }}> ppm</span>}
        </div>
      </div>

      <div style={{ position: "relative", padding: "10px 0 6px" }}>
        {hasValue && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: `${markerPct}%`,
              transform: "translateX(-50%)",
              fontSize: 12,
              color: "#334155",
              lineHeight: 1,
            }}
          >
            &#9660;
          </div>
        )}
        <div style={{ display: "flex", borderRadius: 999, overflow: "hidden", height: 8, marginTop: 12 }}>
          {segments.map((seg, i) => (
            <div
              key={i}
              style={{
                width: `${seg.widthPct}%`,
                background: hasValue ? toneColors[seg.tone] : "#e2e8f0",
              }}
            />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", marginTop: 6 }}>
        {breakpoints.map((bp, i) => (
          <div
            key={bp.label}
            style={{
              flex: 1,
              textAlign: i === 0 ? "left" : i === breakpoints.length - 1 ? "right" : "center",
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 800,
                color: toneColors[bp.tone],
                letterSpacing: 0.3,
              }}
            >
              {bp.label}
            </div>
            <div style={{ fontSize: 10, color: "#94a3b8" }}>{bp.rangeText}</div>
          </div>
        ))}
      </div>
      {!hasValue && (
        <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 6, textAlign: "center" }}>
          No sensor installed
        </div>
      )}
    </div>
  );
}

export default function DashboardPage({ rooms, selectedId, setSelectedId, thresholds }: DashboardPageProps) {
  const [activeFilter, setActiveFilter] = useState<SummaryFilter>(null);
  const [openRoomId, setOpenRoomId] = useState<string | null>(selectedId);

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
  const action = actionMessage(selected, thresholds);
  const co2GasStatus = getGasStatus(selected.co2, thresholds.co2);
  const lpgGasStatus = getGasStatus(selected.lpg, thresholds.lpg);

  const safeRooms = rooms.filter((r) => getStatus(r, thresholds).severity === 0);
  const warningHighRooms = rooms.filter((r) => {
    const s = getStatus(r, thresholds).severity;
    return s === 1 || s === 2;
  });
  const dangerRooms = rooms.filter((r) => getStatus(r, thresholds).severity === 3);

  const summaryCards: { key: SummaryFilter; label: string; value: number; color: string; icon: React.ReactNode }[] = [
    { key: "all", label: "ROOMS MONITORED", value: rooms.length, color: "#2563eb", icon: <Building2 size={18} /> },
    { key: "safe", label: "SAFE ROOMS", value: safeRooms.length, color: "#0d9488", icon: <ShieldCheck size={18} /> },
    { key: "warningHigh", label: "WARNING / HIGH", value: warningHighRooms.length, color: "#d97706", icon: <AlertTriangle size={18} /> },
    { key: "danger", label: "DANGER ROOMS", value: dangerRooms.length, color: "#dc2626", icon: <AlertOctagon size={18} /> },
  ];

  const filterRoomMap: Record<Exclude<SummaryFilter, null>, Room[]> = {
    all: rooms,
    safe: safeRooms,
    warningHigh: warningHighRooms,
    danger: dangerRooms,
  };

  // Rooms shown in the accordion — filtered when a summary card is active.
  const listRooms = activeFilter ? filterRoomMap[activeFilter] : rooms;

  const handleSummaryClick = (key: SummaryFilter) => {
    setActiveFilter((prev) => (prev === key ? null : key));
  };

  const handleToggleRoom = (room: Room) => {
    setSelectedId(room.id);
    setOpenRoomId((prev) => (prev === room.id ? null : room.id));
  };

  // CO2 gauge — 3 tiers, matching the ESP32 firmware's two cutoffs
  // (CO2_SOFT_PPM logged only, CO2_URGENT_PPM sounds the physical buzzer).
  const co2Breakpoints: GaugeBreakpoint[] = [
    { upper: thresholds.co2.warning, tone: "success", label: "SAFE", rangeText: `< ${thresholds.co2.warning} ppm` },
    { upper: thresholds.co2.danger, tone: "warning", label: "WARNING", rangeText: `${thresholds.co2.warning} - ${thresholds.co2.danger} ppm` },
    { upper: Infinity, tone: "danger", label: "DANGER", rangeText: `> ${thresholds.co2.danger} ppm` },
  ];
  const co2MaxDisplay = thresholds.co2.danger * 1.3;

  const lpgBreakpoints: GaugeBreakpoint[] = [
    { upper: thresholds.lpg.warning, tone: "success", label: "SAFE", rangeText: `< ${thresholds.lpg.warning} ppm` },
    { upper: thresholds.lpg.high, tone: "warning", label: "LOW LEAK", rangeText: `${thresholds.lpg.warning} - ${thresholds.lpg.high} ppm` },
    { upper: thresholds.lpg.danger, tone: "high", label: "MODERATE LEAK", rangeText: `${thresholds.lpg.high} - ${thresholds.lpg.danger} ppm` },
    { upper: Infinity, tone: "danger", label: "DANGEROUS", rangeText: `> ${thresholds.lpg.danger} ppm` },
  ];
  const lpgMaxDisplay = thresholds.lpg.danger * 1.2;

  // Reference guide cards at the bottom of the page (unaffected by the
  // currently selected room — these are static thresholds).
  const co2Guide: [string, string, Tone][] = [
    [`< ${thresholds.co2.warning} ppm`, "Safe / Good", "success"],
    [`${thresholds.co2.warning} - ${thresholds.co2.danger} ppm`, "Warning", "warning"],
    [`> ${thresholds.co2.danger} ppm`, "Danger", "danger"],
  ];

  const lpgGuide: [string, string, Tone][] = [
    [`< ${thresholds.lpg.warning} ppm`, "Safe", "success"],
    [`${thresholds.lpg.warning} - ${thresholds.lpg.high} ppm`, "Low Leak", "warning"],
    [`${thresholds.lpg.high} - ${thresholds.lpg.danger} ppm`, "Moderate Leak", "high"],
    [`> ${thresholds.lpg.danger} ppm`, "Dangerous", "danger"],
  ];

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
          display: flex;
          align-items: center;
          gap: 12px;
          transition: box-shadow 0.15s ease, border-color 0.15s ease;
        }
        .air-summary-card:hover {
          box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
        }
        .air-summary-icon {
          width: 40px;
          height: 40px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .air-card {
          background: #fff;
          border: 1px solid #eef1f4;
          border-radius: 12px;
          padding: 16px;
          margin-bottom: 20px;
        }
        .air-gauge-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
          margin: 18px 0;
        }
        .air-detail-subgrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        .air-guide-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 14px;
        }
        .air-accordion-item {
          border: 1px solid #eef1f4;
          border-radius: 10px;
          margin-bottom: 10px;
          overflow: hidden;
        }
        .air-accordion-header {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          background: #fff;
          border: none;
          cursor: pointer;
          text-align: left;
        }
        .air-accordion-body {
          padding: 0 14px 14px;
          border-top: 1px solid #f1f5f9;
        }
        @media (max-width: 640px) {
          .air-summary-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (max-width: 480px) {
          .air-gauge-grid {
            grid-template-columns: 1fr;
          }
          .air-detail-subgrid {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 720px) {
          .air-guide-grid {
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

      <DangerAlarmBanner isDanger={dangerRooms.length > 0} />

      {/* KPI summary cards */}
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
              <span className="air-summary-icon" style={{ background: `${c.color}1a`, color: c.color }}>
                {c.icon}
              </span>
              <span>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5 }}>
                  {c.label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#0f172a", marginTop: 2 }}>
                  {c.value}
                </div>
              </span>
            </button>
          );
        })}
      </div>

      {/* Live monitoring: gauges + temp/humidity for the currently selected room */}
      <div className="air-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Wifi size={16} color="#0d9488" />
            <span style={{ fontWeight: 800, fontSize: 15, color: "#0f172a" }}>Live Monitoring</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              {selected.name} &middot; {selected.floor}
            </span>
            <Badge label={selected.online ? "ONLINE" : "OFFLINE"} tone={selected.online ? "success" : "neutral"} />
          </div>
        </div>

        <div className="air-gauge-grid">
          <GaugePanel
            sensorLabel={`CO2 \u00b7 ${selected.co2Sensor}`}
            value={selected.co2}
            breakpoints={co2Breakpoints}
            maxDisplay={co2MaxDisplay}
            activeTone={co2GasStatus.tone}
          />
          <GaugePanel
            sensorLabel={`LPG \u00b7 ${selected.gasSensor ?? "No sensor"}`}
            value={selected.lpg}
            breakpoints={lpgBreakpoints}
            maxDisplay={lpgMaxDisplay}
            activeTone={lpgGasStatus.tone}
          />
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

      {/* Action plan for the currently selected room */}
      <div
        className="air-card"
        style={{ background: "#0f172a", border: "none", color: "#fff" }}
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
          <Bell size={13} /> ACTION PLAN &middot; {selected.name}
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
          <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5 }}>{action.body}</div>
        </div>
      </div>

      {/* Monitored rooms — accordion list */}
      <div className="air-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Building2 size={16} color="#2563eb" />
            <span style={{ fontWeight: 800, fontSize: 15, color: "#0f172a" }}>Monitored Rooms</span>
          </div>
          <span style={{ fontSize: 12.5, color: "#94a3b8" }}>
            {listRooms.length} {activeFilter ? "Shown" : "Installed"}
          </span>
        </div>

        {listRooms.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "#94a3b8" }}>No rooms match this filter.</div>
        ) : (
          listRooms.map((r) => {
            const st = getStatus(r, thresholds);
            const isOpen = openRoomId === r.id;
            const isSelected = r.id === selected.id;
            const roomAction = actionMessage(r, thresholds);
            return (
              <div
                key={r.id}
                className="air-accordion-item"
                style={{ borderColor: isSelected ? "#0d9488" : "#eef1f4" }}
              >
                <button
                  type="button"
                  className="air-accordion-header"
                  onClick={() => handleToggleRoom(r)}
                  style={{ background: isSelected ? "#f0faf7" : "#fff" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <ChevronDown
                      size={16}
                      color="#94a3b8"
                      style={{
                        flexShrink: 0,
                        transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                        transition: "transform 0.15s ease",
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.4 }}>
                        {r.floor.toUpperCase()}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>ID: {r.id}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
                    <span style={{ fontSize: 12.5, color: "#334155", display: "none" }} />
                    <div style={{ textAlign: "right", fontSize: 12 }}>
                      <div style={{ color: "#334155" }}>
                        {r.co2 != null ? `${Math.round(r.co2)} CO2 ppm` : "N/A"}
                      </div>
                      <div style={{ color: "#334155" }}>
                        {r.lpg != null ? `${Math.round(r.lpg)} LPG ppm` : "N/A"}
                      </div>
                    </div>
                    <Badge label={st.label} tone={st.tone} />
                  </div>
                </button>

                {isOpen && (
                  <div className="air-accordion-body">
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                        gap: 10,
                        marginTop: 12,
                      }}
                    >
                      <div style={{ background: toneBg[co2GasStatus.tone] ?? "#f8fafc", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>CO2</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                          {r.co2 != null ? `${Math.round(r.co2)} ppm` : "N/A"}
                        </div>
                      </div>
                      <div style={{ background: "#f8fafc", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>LPG</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                          {r.lpg != null ? `${Math.round(r.lpg)} ppm` : "N/A"}
                        </div>
                      </div>
                      <div style={{ background: "#f8fafc", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>TEMPERATURE</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                          {r.temp.toFixed(1)} &deg;C
                        </div>
                      </div>
                      <div style={{ background: "#f8fafc", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>HUMIDITY</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                          {Math.round(r.humidity)}%
                        </div>
                      </div>
                    </div>
                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 12,
                        color: "#475569",
                        lineHeight: 1.5,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Badge label={r.online ? "ONLINE" : "OFFLINE"} tone={r.online ? "success" : "neutral"} />
                      <span>{roomAction.body}</span>
                    </div>
                    {!isSelected && (
                      <button
                        type="button"
                        onClick={() => setSelectedId(r.id)}
                        style={{
                          marginTop: 10,
                          fontSize: 12,
                          fontWeight: 700,
                          color: "#0d9488",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        View in Live Monitoring &rarr;
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Reference guides */}
      <div className="air-guide-grid">
        <div className="air-card" style={{ marginBottom: 0 }}>
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
            &gt;{thresholds.co2.danger} ppm triggers the physical alarm. (OSHA's 8-hour occupational
            exposure limit is 5000 ppm — this threshold is set lower for earlier warning.)
          </div>
        </div>

        <div className="air-card" style={{ marginBottom: 0 }}>
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

        <div className="air-card" style={{ marginBottom: 0 }}>
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
  );
}