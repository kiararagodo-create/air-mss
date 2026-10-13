import { useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import DangerAlarmBanner from "../components/DangerAlarmBanner";
import { NO_DATA_LABEL, actionMessage, type Room } from "../data/Data";
import { useThresholdConfig, type ThresholdConfig } from "../hooks/useThresholdConfig";
import { SEVERITY_LABEL, SEVERITY_TONE, type ReferenceCard } from "../lib/thresholdConfig";

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

/** "12s ago", "4m ago", "3h ago", "2d ago" - the age of the newest reading. */
function formatReadingAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Severity from ACTUAL measurements and the SAVED thresholds only.
 *
 * All grading lives in src/lib/thresholdConfig.ts so this page, the Devices
 * page, the CSV export, the charts and the PDF cannot disagree. In particular:
 *
 * - The ESP32's own `severity` column is never read here. The firmware grades
 *   against tiers compiled into it; re-tuning the dashboard configuration must
 *   change what the dashboard says, and trusting the device would silently stop
 *   that from happening.
 * - All four metrics contribute, not just the two gases.
 * - A null metric is not zero. `hasData` is false when nothing was measured, so
 *   callers render an explicit no-data state instead of implying a safe reading.
 */
function getStatus(room: Room, cfg: ThresholdConfig) {
  const level = cfg.overall(room);
  const hasData = cfg.hasData(room);
  return {
    level,
    // A device that has never reported grades "ok" by construction (every
    // metric is null and null grades ok) but must never be painted the colour
    // of a passing device. hasData gates the tone as well as the label.
    tone: (hasData ? SEVERITY_TONE[level] : "neutral") as Tone,
    label: hasData ? SEVERITY_LABEL[level] : NO_DATA_LABEL,
    hasData,
  };
}

// Grades ONE metric against its own limits, so each panel reflects its own
// reading instead of one metric's colour bleeding into another's box. Works for
// all four metrics - the gases are one-sided, temperature and humidity are
// two-sided - because the dispatch lives in the shared threshold module.
function getMetricStatus(
  metric: "co2" | "lpg" | "temp" | "humidity",
  value: number | null | undefined,
  cfg: ThresholdConfig
): { tone: Tone; label: string; hasData: boolean } {
  if (value == null)
    return { tone: "neutral", label: NO_DATA_LABEL, hasData: false };
  const level = cfg.severity(metric, value);
  return { tone: SEVERITY_TONE[level], label: SEVERITY_LABEL[level], hasData: true };
}

// The canonical Room / Thresholds types come from the data layer, which is also
// where they are loaded from. This page previously kept its own narrower copies
// so a room missing `lpg` or `length` would still typecheck; that let the page
// grade readings against a different shape than the one actually saved.
export type { Room, Thresholds } from "../data/Data";

type Tone = "success" | "warning" | "high" | "danger" | "neutral";

// Which summary box is active, drives the Monitored Rooms accordion filter.
type SummaryFilter = "all" | "safe" | "warningHigh" | "danger" | "noData" | null;

interface DashboardPageProps {
  rooms: Room[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  /**
   * No longer passed in. The configuration is read from the shared hook so this
   * page cannot be handed a stale or hand-made copy that disagrees with the
   * reference cards rendered from the saved row.
   */
}

// A single tier used to color/label a gauge's threshold bar.
type GaugeBreakpoint = { upper: number; tone: Tone; label: string; rangeText: string };

function buildGaugeSegments(breakpoints: GaugeBreakpoint[], maxDisplay: number, base = 0) {
  // `base` is the value the bar starts at. It is 0 for the ppm metrics, but
  // temperature and humidity are two-sided bands whose lower danger limit sits
  // at 5 °C / 20 % RH - starting those bars at zero would squash the freeze and
  // dry bands into an unreadable sliver.
  let prev = base;
  const span = maxDisplay - base;
  return breakpoints.map((bp) => {
    const upperClamped = bp.upper === Infinity ? maxDisplay : Math.min(bp.upper, maxDisplay);
    const widthPct = span > 0 ? Math.max(0, ((upperClamped - prev) / span) * 100) : 0;
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
  unit = "ppm",
  base = 0,
  statusLabel = null,
  emptyHint,
  digits = 0,
}: {
  sensorLabel: string;
  value: number | null | undefined;
  breakpoints: GaugeBreakpoint[];
  maxDisplay: number;
  activeTone: Tone;
  unit?: string;
  base?: number;
  statusLabel?: string | null;
  /** Shown under the bar when there is no measurement. Must be precise. */
  emptyHint?: string;
  digits?: number;
}) {
  const segments = buildGaugeSegments(breakpoints, maxDisplay, base);
  const hasValue = value != null && Number.isFinite(value);
  const markerPct = hasValue
    ? clamp(((value as number) - base) / (maxDisplay - base || 1), 0, 1) * 100
    : 0;

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
          {hasValue ? (digits > 0 ? (value as number).toFixed(digits) : Math.round(value as number)) : "N/A"}
          {hasValue && <span style={{ fontSize: 15, color: "#64748b", fontWeight: 600 }}> {unit}</span>}
        </div>
        {/* Every panel carries an explicit grade, so a quiet metric still states
            what it is doing instead of being inferred from its colour. */}
        <div style={{ marginTop: 6, minHeight: 20, display: "flex", justifyContent: "center" }}>
          {statusLabel && <Badge label={statusLabel} tone={activeTone} />}
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
        <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 6, textAlign: "center", lineHeight: 1.4 }}>
          {emptyHint ?? "No reading received"}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage({ rooms, selectedId, setSelectedId }: DashboardPageProps) {
  const [activeFilter, setActiveFilter] = useState<SummaryFilter>(null);
  const [openRoomId, setOpenRoomId] = useState<string | null>(selectedId);

  // The saved configuration and everything derived from it - guide copy, badge
  // labels and tones, severity. Resolved before the early return below so the
  // hook order is stable across renders.
  const cfg = useThresholdConfig();
  const thresholds = cfg.thresholds;

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
  const status = getStatus(selected, cfg);
  const action = actionMessage(selected, cfg.thresholds);
  const co2GasStatus = getMetricStatus("co2", selected.co2, cfg);
  const lpgGasStatus = getMetricStatus("lpg", selected.lpg, cfg);
  const tempStatus = getMetricStatus("temp", selected.temp, cfg);
  const humidityStatus = getMetricStatus("humidity", selected.humidity, cfg);

  // Is the hardware for this metric actually fitted to the selected room? The
  // registry and the readings are separate facts: a room can have an LPG sensor
  // listed and still never receive an LPG reading, and those two states need
  // different wording.
  const lpgFitted = !!selected.gasSensor;
  const envFitted = !!selected.tempHumiditySensor;
  const noReading = "Registered, but this device is not sending it. Check the sensor wiring and the firmware payload.";

  // Buckets come from the computed grade, never from a device-supplied one.
  //
  // A room with no measurements at all grades "ok" because every metric is
  // null, and null grades ok. Counting it under SAFE ROOMS would claim a device
  // is safe on the basis of having never been measured. It gets its own bucket
  // so the four cards still account for every registered room and the total is
  // auditable against the device list.
  const noDataRooms = rooms.filter((r) => !getStatus(r, cfg).hasData);
  const safeRooms = rooms.filter((r) => {
    const st = getStatus(r, cfg);
    return st.hasData && st.level === "ok";
  });
  const warningHighRooms = rooms.filter((r) => {
    const st = getStatus(r, cfg);
    return st.hasData && (st.level === "warning" || st.level === "high");
  });
  const dangerRooms = rooms.filter((r) => getStatus(r, cfg).level === "danger");

  const summaryCards: { key: SummaryFilter; label: string; value: number; color: string; icon: React.ReactNode }[] = [
    { key: "all", label: "ROOMS MONITORED", value: rooms.length, color: "#2563eb", icon: <Building2 size={18} /> },
    { key: "safe", label: "SAFE ROOMS", value: safeRooms.length, color: "#0d9488", icon: <ShieldCheck size={18} /> },
    { key: "warningHigh", label: "WARNING / HIGH", value: warningHighRooms.length, color: "#d97706", icon: <AlertTriangle size={18} /> },
    { key: "danger", label: "DANGER ROOMS", value: dangerRooms.length, color: "#dc2626", icon: <AlertOctagon size={18} /> },
  ];

  if (noDataRooms.length > 0) {
    summaryCards.splice(2, 0, {
      key: "noData",
      label: "NO SENSOR DATA",
      value: noDataRooms.length,
      color: "#64748b",
      icon: <CircleSlash size={18} />,
    });
  }

  const filterRoomMap: Record<Exclude<SummaryFilter, null>, Room[]> = {
    all: rooms,
    noData: noDataRooms,
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

  // Gauge bands. Four segments per gas now that the configuration carries a
  // real `high` tier between warning and danger; every upper bound and range
  // string is read straight off the saved thresholds, so re-tuning a value on
  // the Settings page redraws the bar rather than leaving a stale label on it.
  const co2Breakpoints: GaugeBreakpoint[] = [
    { upper: thresholds.co2.warning, tone: "success", label: "SAFE", rangeText: `< ${thresholds.co2.warning} ppm` },
    { upper: thresholds.co2.high, tone: "warning", label: "WARNING", rangeText: `${thresholds.co2.warning} - ${thresholds.co2.high} ppm` },
    { upper: thresholds.co2.danger, tone: "high", label: "HIGH", rangeText: `${thresholds.co2.high} - ${thresholds.co2.danger} ppm` },
    { upper: Infinity, tone: "danger", label: "DANGER", rangeText: `>= ${thresholds.co2.danger} ppm` },
  ];
  const co2MaxDisplay = thresholds.co2.danger * 1.3;

  const lpgBreakpoints: GaugeBreakpoint[] = [
    { upper: thresholds.lpg.warning, tone: "success", label: "SAFE", rangeText: `< ${thresholds.lpg.warning} ppm` },
    { upper: thresholds.lpg.high, tone: "warning", label: "LOW LEAK", rangeText: `${thresholds.lpg.warning} - ${thresholds.lpg.high} ppm` },
    { upper: thresholds.lpg.danger, tone: "high", label: "ALARM", rangeText: `${thresholds.lpg.high} - ${thresholds.lpg.danger} ppm` },
    { upper: Infinity, tone: "danger", label: "CRITICAL", rangeText: `>= ${thresholds.lpg.danger} ppm` },
  ];
  const lpgMaxDisplay = thresholds.lpg.danger * 1.2;

  // Temperature and humidity get the same full-width gauge treatment as the
  // gases. They used to be two small grey boxes underneath, which read as
  // footnotes rather than as sensors - and made a DHT22 that was sending
  // nothing look like a panel that simply was not there.
  //
  // Both bars start below their own lower danger limit rather than at zero, so
  // the freeze / dry band is wide enough to see.
  const tempBreakpoints: GaugeBreakpoint[] = [
    { upper: thresholds.temp.freezeBelow, tone: "danger", label: "FREEZE", rangeText: `< ${thresholds.temp.freezeBelow}°C` },
    { upper: thresholds.temp.coolBelow, tone: "warning", label: "COOL", rangeText: `${thresholds.temp.freezeBelow} - ${thresholds.temp.coolBelow}°C` },
    { upper: thresholds.temp.heatAbove, tone: "success", label: "COMFORT", rangeText: `${thresholds.temp.coolBelow} - ${thresholds.temp.heatAbove}°C` },
    { upper: Infinity, tone: "danger", label: "HEAT", rangeText: `> ${thresholds.temp.heatAbove}°C` },
  ];
  const tempBase = thresholds.temp.freezeBelow - 8;
  const tempMaxDisplay = thresholds.temp.heatAbove + 8;

  const humidityBreakpoints: GaugeBreakpoint[] = [
    { upper: thresholds.humidity.dryBelow, tone: "danger", label: "DRY", rangeText: `< ${thresholds.humidity.dryBelow}%` },
    { upper: thresholds.humidity.lowBelow, tone: "warning", label: "LOW", rangeText: `${thresholds.humidity.dryBelow} - ${thresholds.humidity.lowBelow}%` },
    { upper: thresholds.humidity.moldAbove, tone: "success", label: "COMFORT", rangeText: `${thresholds.humidity.lowBelow} - ${thresholds.humidity.moldAbove}%` },
    { upper: Infinity, tone: "danger", label: "MOLD", rangeText: `> ${thresholds.humidity.moldAbove}%` },
  ];
  const humidityBase = thresholds.humidity.dryBelow - 8;
  const humidityMaxDisplay = thresholds.humidity.moldAbove + 8;

  // Reference guide cards. Every range, label, standards name and footnote is
  // generated from the saved thresholds - see buildReferenceGuides() in
  // src/lib/thresholdConfig.ts. Nothing here is a literal, so a saved change
  // propagates to the cards without touching this file.
  const guides = cfg.guides;

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
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 24px 24px;
          margin: 18px 0;
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
            sensorLabel={`CO2 \u00b7 ${selected.co2Sensor || "no sensor"}`}
            value={selected.co2}
            breakpoints={co2Breakpoints}
            maxDisplay={co2MaxDisplay}
            activeTone={co2GasStatus.tone}
            statusLabel={co2GasStatus.hasData ? co2GasStatus.label : null}
            emptyHint={noReading}
          />
          <GaugePanel
            sensorLabel={`LPG \u00b7 ${selected.gasSensor || "no sensor"}`}
            value={selected.lpg}
            breakpoints={lpgBreakpoints}
            maxDisplay={lpgMaxDisplay}
            activeTone={lpgGasStatus.tone}
            statusLabel={lpgGasStatus.hasData ? lpgGasStatus.label : null}
            emptyHint={lpgFitted ? noReading : "No LPG sensor registered for this room."}
          />
          <GaugePanel
            sensorLabel={`TEMPERATURE \u00b7 ${selected.tempHumiditySensor || "no sensor"}`}
            value={selected.temp}
            breakpoints={tempBreakpoints}
            maxDisplay={tempMaxDisplay}
            base={tempBase}
            digits={1}
            unit="°C"
            activeTone={tempStatus.tone}
            statusLabel={tempStatus.hasData ? tempStatus.label : null}
            emptyHint={envFitted ? noReading : "No temperature/humidity sensor registered for this room."}
          />
          <GaugePanel
            sensorLabel={`HUMIDITY \u00b7 ${selected.tempHumiditySensor || "no sensor"}`}
            value={selected.humidity}
            breakpoints={humidityBreakpoints}
            maxDisplay={humidityMaxDisplay}
            base={humidityBase}
            unit="% RH"
            activeTone={humidityStatus.tone}
            statusLabel={humidityStatus.hasData ? humidityStatus.label : null}
            emptyHint={envFitted ? noReading : "No temperature/humidity sensor registered for this room."}
          />
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
            const st = getStatus(r, cfg);
            const isOpen = openRoomId === r.id;
            const isSelected = r.id === selected.id;
            const roomAction = actionMessage(r, thresholds);
            // Per-row tones, so one row's colour cannot bleed into another.
            const rowCo2Status = getMetricStatus("co2", r.co2, cfg);
            const rowLpgStatus = getMetricStatus("lpg", r.lpg, cfg);
            const rowTempStatus = getMetricStatus("temp", r.temp, cfg);
            const rowHumidityStatus = getMetricStatus("humidity", r.humidity, cfg);
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
                        {/* All four metrics, so the collapsed row is as
                            informative as the expanded one. A metric with no
                            reading says so rather than being omitted. */}
                        <div style={{ color: r.co2 != null ? "#334155" : "#94a3b8" }}>
                          {r.co2 != null ? `${Math.round(r.co2)} CO2 ppm` : "CO2 —"}
                        </div>
                        <div style={{ color: r.lpg != null ? "#334155" : "#94a3b8" }}>
                          {r.lpg != null ? `${Math.round(r.lpg)} LPG ppm` : "LPG —"}
                        </div>
                        <div style={{ color: r.temp != null ? "#334155" : "#94a3b8" }}>
                          {r.temp != null ? `${r.temp.toFixed(1)} °C` : "Temp —"}
                        </div>
                        <div style={{ color: r.humidity != null ? "#334155" : "#94a3b8" }}>
                          {r.humidity != null ? `${Math.round(r.humidity)} % RH` : "Humidity —"}
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
                      {/* Tone comes from THIS row's own CO2 reading, not the selected room's.
                          Previously every open row was tinted by the selected
                          room, so a row could show a green background next to a
                          red number. */}
                      <div style={{ background: rowCo2Status.hasData ? (toneBg[rowCo2Status.tone] ?? "#f8fafc") : "#f1f5f9", borderRadius: 8, padding: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>CO2</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                          {r.co2 != null ? `${Math.round(r.co2)} ppm` : NO_DATA_LABEL}
                        </div>
                      </div>
                      <div
                        style={{
                          background: rowLpgStatus.hasData ? (toneBg[rowLpgStatus.tone] ?? "#f8fafc") : "#f1f5f9",
                          borderRadius: 8,
                          padding: 10,
                        }}
                      >
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>LPG</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                          {r.lpg != null ? `${Math.round(r.lpg)} ppm` : NO_DATA_LABEL}
                        </div>
                      </div>
                      <div
                        style={{
                          background: rowTempStatus.hasData ? (toneBg[rowTempStatus.tone] ?? "#f8fafc") : "#f1f5f9",
                          borderRadius: 8,
                          padding: 10,
                        }}
                      >
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>TEMPERATURE</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                          {r.temp != null ? `${r.temp.toFixed(1)} °C` : NO_DATA_LABEL}
                        </div>
                      </div>
                      <div
                        style={{
                          background: rowHumidityStatus.hasData
                            ? (toneBg[rowHumidityStatus.tone] ?? "#f8fafc")
                            : "#f1f5f9",
                          borderRadius: 8,
                          padding: 10,
                        }}
                      >
                        <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>HUMIDITY</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                          {r.humidity != null ? `${Math.round(r.humidity)}%` : NO_DATA_LABEL}
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
                      {/* A frozen last-known number must never read as a current
                          measurement, so its age is always shown alongside it. */}
                      {!r.online && (
                        <span style={{ fontSize: 11, color: "#94a3b8" }}>
                          {r.lastReadingAt
                            ? `last reading ${formatReadingAge(r.lastReadingAt)}`
                            : "no reading ever received"}
                        </span>
                      )}
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

      {/* Reference guides. `guides` is generated from the saved thresholds, so
          these cards are rewritten by a save on the Settings page - including
          the standards names, the band ranges and the footnotes. */}
      <div className="air-guide-grid">
        <GuideCard card={guides.co2} />
        <GuideCard card={guides.lpg} />
        <GuideCard card={guides.temp} />
        <GuideCard card={guides.humidity} />
      </div>
    </div>
  );
}

/**
 * One reference card: title, the standard it comes from, the generated bands,
 * and any generated footnotes.
 *
 * Deliberately takes the whole card object rather than a title and two arrays,
 * so adding a band or a note is a change to thresholdConfig.ts alone and
 * cannot be forgotten in a third copy of the markup.
 */
function GuideCard({ card }: { card: ReferenceCard }) {
  return (
    <div className="air-card" style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 2 }}>
        {card.title}
      </div>
      <div style={{ fontSize: 10.5, color: "#0d9488", fontWeight: 700, marginBottom: 8 }}>
        {card.standard}
      </div>
      {card.rows.map((row) => (
        <div
          key={`${row.range}|${row.label}`}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            fontSize: 12.5,
            padding: "5px 0",
          }}
        >
          <span style={{ color: "#475569", display: "flex", alignItems: "center", gap: 6 }}>
            <ToneDot tone={row.tone} /> {row.range}
          </span>
          <span style={{ color: badgeStyles(row.tone).text, fontWeight: 700, textAlign: "right" }}>
            {row.label}
          </span>
        </div>
      ))}
      {card.deviceNote && (
        <div style={footnoteStyle}>
          {card.deviceNote}
        </div>
      )}
      {card.footnote && <div style={footnoteStyle}>{card.footnote}</div>}
    </div>
  );
}

const footnoteStyle: React.CSSProperties = {
  fontSize: 10.5,
  color: "#94a3b8",
  marginTop: 6,
  borderTop: "1px solid #f1f5f9",
  paddingTop: 6,
  lineHeight: 1.5,
};
