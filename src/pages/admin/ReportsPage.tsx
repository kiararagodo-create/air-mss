import { useEffect, useState, useCallback } from "react";
import {
  Building2,
  ChevronDown,
  Download,
  RefreshCw,
  Smartphone,
  AlertTriangle,
  Users,
  FileWarning,
} from "lucide-react";
import { Badge } from "../../ui";
import { Room, Thresholds } from "../../data/Data";
import { supabase } from "../../lib/supabase";

interface ReportsPageProps {
  rooms: Room[];
  thresholds: Thresholds;
}

// DHT22 danger thresholds - these are NOT part of the configurable
// `Thresholds` type (Settings page only exposes co2/lpg), so they're
// hardcoded here to match the ESP32 firmware's own alarm constants
// (TEMP_ALARM_LOW_C / TEMP_ALARM_HIGH_C / HUM_ALARM_LOW / HUM_ALARM_HIGH
// in air_mss_esp32.ino). If those firmware values ever change, update
// these too so the report stays consistent with what actually triggers
// the physical buzzer.
const TEMP_DANGER_LOW_C = 5;
const TEMP_DANGER_HIGH_C = 35;
const HUM_DANGER_LOW = 20;
const HUM_DANGER_HIGH = 80;

// Shape of a row in the Supabase "readings" table (matches what the ESP32
// sketch POSTs via sendReading(), plus Supabase's auto-generated columns).
interface ReadingRow {
  id: number;
  device_id: string;
  co2: number | null;
  lpg: number | null;
  temp: number | null;
  humidity: number | null;
  severity: number | null;
  created_at: string;
}

interface DangerEvent extends ReadingRow {
  roomName: string;
  roomFloor: string;
  triggeredBy: string[];
}

function escapeCSV(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function exportCSV(events: DangerEvent[]) {
  const headers = [
    "TIMESTAMP",
    "ROOM & FLOOR",
    "DEVICE ID",
    "CO2 (ppm)",
    "LPG (ppm)",
    "TEMP (C)",
    "HUMIDITY (%)",
    "TRIGGERED BY",
  ];

  const rows = events.map((e) => [
    new Date(e.created_at).toLocaleString(),
    `${e.roomName} / ${e.roomFloor}`,
    e.device_id,
    e.co2 != null ? Math.round(e.co2).toString() : "N/A",
    e.lpg != null ? Math.round(e.lpg).toString() : "N/A",
    e.temp != null ? e.temp.toFixed(1) : "N/A",
    e.humidity != null ? Math.round(e.humidity).toString() : "N/A",
    e.triggeredBy.join(", "),
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map(escapeCSV).join(","))
    .join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", "danger-events-report.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getTriggeredBy(row: ReadingRow, thresholds: Thresholds): string[] {
  const triggers: string[] = [];
  if (row.co2 != null && row.co2 >= thresholds.co2.danger) triggers.push("CO2");
  if (row.lpg != null && row.lpg >= thresholds.lpg.danger) triggers.push("LPG");
  if (row.temp != null && (row.temp < TEMP_DANGER_LOW_C || row.temp > TEMP_DANGER_HIGH_C)) {
    triggers.push("Temperature");
  }
  if (row.humidity != null && (row.humidity < HUM_DANGER_LOW || row.humidity > HUM_DANGER_HIGH)) {
    triggers.push("Humidity");
  }
  return triggers;
}

// Groups the full room list by floor, preserving the order rooms already
// come in via the `rooms` prop. Unlike grouping by event, this always
// includes every room/floor - even ones with zero recorded danger events -
// so the report reads as a status board, not just a log of incidents.
function groupRoomsByFloor(rooms: Room[]) {
  const floors = new Map<string, Room[]>();
  for (const room of rooms) {
    if (!floors.has(room.floor)) floors.set(room.floor, []);
    floors.get(room.floor)!.push(room);
  }
  return floors;
}

const eventColumns = ["TIMESTAMP", "CO2", "LPG", "TEMP", "HUMIDITY", "TRIGGERED BY"];

export default function ReportsPage({ rooms, thresholds }: ReportsPageProps) {
  const [events, setEvents] = useState<DangerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closedFloors, setClosedFloors] = useState<Set<string>>(new Set());
  const [openRoomKey, setOpenRoomKey] = useState<string | null>(null);

  const fetchDangerEvents = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Query the recorded history in "readings" directly - NOT the live
    // `rooms` state - and only rows where a reading actually crossed into
    // danger at the time it was recorded. Using .or() pushes the filtering
    // down to Postgres instead of pulling every historical row over the
    // wire and filtering client-side.
    const { data, error: fetchError } = await supabase
      .from("readings")
      .select("id, device_id, co2, lpg, temp, humidity, severity, created_at")
      .or(
        `co2.gte.${thresholds.co2.danger},` +
          `lpg.gte.${thresholds.lpg.danger},` +
          `temp.lt.${TEMP_DANGER_LOW_C},temp.gt.${TEMP_DANGER_HIGH_C},` +
          `humidity.lt.${HUM_DANGER_LOW},humidity.gt.${HUM_DANGER_HIGH}`
      )
      .order("created_at", { ascending: false })
      .limit(500);

    if (fetchError) {
      console.error("Failed to fetch danger events:", fetchError.message);
      setError(fetchError.message);
      setLoading(false);
      return;
    }

    const mapped: DangerEvent[] = (data ?? []).map((row) => {
      const r = row as ReadingRow;
      const room = rooms.find((rm) => rm.id === r.device_id);
      return {
        ...r,
        roomName: room?.name ?? r.device_id,
        roomFloor: room?.floor ?? "-",
        triggeredBy: getTriggeredBy(r, thresholds),
      };
    });

    setEvents(mapped);
    setLoading(false);
  }, [rooms, thresholds]);

  useEffect(() => {
    fetchDangerEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thresholds.co2.danger, thresholds.lpg.danger]);

  // Lookup: device_id -> its events, so each room can pull just its own
  // slice out of the single combined query above.
  const eventsByDevice = new Map<string, DangerEvent[]>();
  for (const e of events) {
    if (!eventsByDevice.has(e.device_id)) eventsByDevice.set(e.device_id, []);
    eventsByDevice.get(e.device_id)!.push(e);
  }

  const affectedRoomCount = new Set(events.map((e) => e.device_id)).size;

  const summaryCards: { label: string; value: number; border: string; icon: JSX.Element }[] = [
    {
      label: "TOTAL DEVICES",
      value: rooms.length,
      border: "#0d9488",
      icon: <Smartphone size={18} color="#0d9488" />,
    },
    {
      label: "TOTAL DANGER EVENTS",
      value: events.length,
      border: "#d97706",
      icon: <AlertTriangle size={18} color="#d97706" />,
    },
    {
      label: "ROOMS AFFECTED",
      value: affectedRoomCount,
      border: "#dc2626",
      icon: <Users size={18} color="#dc2626" />,
    },
  ];

  const floorGroups = groupRoomsByFloor(rooms);

  const toggleFloor = (floor: string) => {
    setClosedFloors((prev) => {
      const next = new Set(prev);
      if (next.has(floor)) next.delete(floor);
      else next.add(floor);
      return next;
    });
  };

  const toggleRoom = (key: string) => {
    setOpenRoomKey((prev) => (prev === key ? null : key));
  };

  return (
    <div>
      <style>{`
        .air-floor-card {
          background: #fff;
          border: 1px solid #eef1f4;
          border-radius: 12px;
          margin-bottom: 12px;
          overflow: hidden;
        }
        .air-floor-header {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 16px;
          background: #fff;
          border: none;
          cursor: pointer;
          text-align: left;
        }
        .air-floor-icon {
          width: 32px;
          height: 32px;
          border-radius: 999px;
          background: #0d9488;
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .air-floor-count {
          font-size: 11.5px;
          font-weight: 700;
          color: #0d9488;
          background: #f0fdfa;
          border: 1px solid #99f6e4;
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
        .air-room-icon {
          width: 26px;
          height: 26px;
          border-radius: 999px;
          border: 1.5px solid #99f6e4;
          color: #0d9488;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
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
        .air-room-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .air-room-body {
          padding: 14px;
          border-top: 1px solid #eef1f4;
          background: #fafbfc;
          overflow-x: auto;
        }
        .air-empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 32px 12px;
          text-align: center;
        }
        .air-empty-icon {
          width: 44px;
          height: 44px;
          border-radius: 999px;
          background: #f0fdfa;
          color: #0d9488;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 12px;
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
            Environmental Quality Reports & Logs
          </h1>
          <p style={{ color: "#64748b", fontSize: 13.5, margin: "4px 0 0" }}>
            Recorded danger-level events - CO2, LPG, temperature, or humidity readings that
            crossed into the danger zone.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={fetchDangerEvents}
            disabled={loading}
            style={{
              background: "#fff",
              color: "#0d9488",
              border: "1px solid #99f6e4",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={() => exportCSV(events)}
            disabled={events.length === 0}
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
              cursor: events.length === 0 ? "not-allowed" : "pointer",
              opacity: events.length === 0 ? 0.6 : 1,
            }}
          >
            <Download size={15} /> Export CSV Report
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 20 }}>
        {summaryCards.map((c) => (
          <div
            key={c.label}
            style={{
              background: "#fff",
              border: "1px solid #eef1f4",
              borderLeft: `4px solid ${c.border}`,
              borderRadius: 12,
              padding: "14px 16px",
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 999,
                background: `${c.border}1a`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {c.icon}
            </div>
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5 }}>
                {c.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "#0f172a", marginTop: 2 }}>
                {c.value}
              </div>
            </div>
          </div>
        ))}
      </div>

      {error ? (
        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: "24px 6px",
            fontSize: 13,
            color: "#dc2626",
            textAlign: "center",
          }}
        >
          Failed to load danger events: {error}
        </div>
      ) : loading ? (
        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: "24px 6px",
            fontSize: 13,
            color: "#94a3b8",
            textAlign: "center",
          }}
        >
          Loading recorded danger events...
        </div>
      ) : rooms.length === 0 ? (
        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: "24px 6px",
            fontSize: 13,
            color: "#94a3b8",
            textAlign: "center",
          }}
        >
          No devices/rooms have been added yet.
        </div>
      ) : (
        Array.from(floorGroups.entries()).map(([floor, floorRooms]) => {
          const floorOpen = !closedFloors.has(floor);
          return (
            <div key={floor} className="air-floor-card">
              <button type="button" className="air-floor-header" onClick={() => toggleFloor(floor)}>
                <span className="air-floor-icon">
                  <Building2 size={16} />
                </span>
                <span style={{ fontWeight: 800, fontSize: 15, color: "#0f172a", letterSpacing: 0.3 }}>
                  {floor}
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
                    const roomEvents = eventsByDevice.get(room.id) ?? [];
                    const roomKey = `${floor}::${room.id}`;
                    const isOpen = openRoomKey === roomKey;
                    const hasDanger = roomEvents.length > 0;

                    return (
                      <div key={roomKey} className="air-room-item">
                        <button type="button" className="air-room-header" onClick={() => toggleRoom(roomKey)}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
                            <span className="air-room-icon">
                              <Smartphone size={13} />
                            </span>
                            <span style={{ fontWeight: 800, fontSize: 14.5, color: "#0f172a" }}>{room.name}</span>
                            <span className="air-room-id-pill">{room.id}</span>
                            <span
                              className="air-room-status-dot"
                              style={{ background: hasDanger ? "#dc2626" : "#16a34a" }}
                            />
                            <span style={{ fontSize: 12.5, color: "#475569", fontWeight: 600, whiteSpace: "nowrap" }}>
                              {roomEvents.length} danger event{roomEvents.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          <ChevronDown
                            size={16}
                            color="#94a3b8"
                            style={{
                              flexShrink: 0,
                              transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                              transition: "transform 0.15s ease",
                            }}
                          />
                        </button>

                        {isOpen && (
                          <div className="air-room-body">
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                marginBottom: 10,
                                flexWrap: "wrap",
                                gap: 8,
                              }}
                            >
                              <div>
                                <span style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>
                                  Danger Event Log
                                </span>
                                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2, maxWidth: 460 }}>
                                  Recorded readings where CO2, LPG, temperature, or humidity reached the
                                  danger limit at the time - not current/live values.
                                </div>
                              </div>
                              <span style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "nowrap" }}>
                                {roomEvents.length} Recorded Event{roomEvents.length === 1 ? "" : "s"}
                              </span>
                            </div>

                            {roomEvents.length === 0 ? (
                              <div className="air-empty-state">
                                <span className="air-empty-icon">
                                  <FileWarning size={20} />
                                </span>
                                <span style={{ fontSize: 13, color: "#94a3b8" }}>
                                  No recorded readings have reached danger level yet.
                                </span>
                              </div>
                            ) : (
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                                <thead>
                                  <tr style={{ textAlign: "left", color: "#94a3b8", fontSize: 11 }}>
                                    {eventColumns.map((h) => (
                                      <th
                                        key={h}
                                        style={{
                                          padding: "8px 6px",
                                          fontWeight: 700,
                                          borderBottom: "1px solid #f1f5f9",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {h}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {roomEvents.map((e) => (
                                    <tr key={e.id} style={{ borderBottom: "1px solid #f8fafc" }}>
                                      <td style={{ padding: "10px 6px", color: "#475569", whiteSpace: "nowrap" }}>
                                        {new Date(e.created_at).toLocaleString()}
                                      </td>
                                      <td
                                        style={{
                                          padding: "10px 6px",
                                          fontWeight: 700,
                                          color: e.triggeredBy.includes("CO2") ? "#dc2626" : "#475569",
                                        }}
                                      >
                                        {e.co2 != null ? `${Math.round(e.co2)} ppm` : "N/A"}
                                      </td>
                                      <td
                                        style={{
                                          padding: "10px 6px",
                                          fontWeight: 700,
                                          color: e.triggeredBy.includes("LPG") ? "#dc2626" : "#475569",
                                        }}
                                      >
                                        {e.lpg != null ? `${Math.round(e.lpg)} ppm` : "N/A"}
                                      </td>
                                      <td
                                        style={{
                                          padding: "10px 6px",
                                          fontWeight: 700,
                                          color: e.triggeredBy.includes("Temperature") ? "#dc2626" : "#475569",
                                        }}
                                      >
                                        {e.temp != null ? `${e.temp.toFixed(1)}\u00b0C` : "N/A"}
                                      </td>
                                      <td
                                        style={{
                                          padding: "10px 6px",
                                          fontWeight: 700,
                                          color: e.triggeredBy.includes("Humidity") ? "#dc2626" : "#475569",
                                        }}
                                      >
                                        {e.humidity != null ? `${Math.round(e.humidity)}%` : "N/A"}
                                      </td>
                                      <td style={{ padding: "10px 6px" }}>
                                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                          {e.triggeredBy.map((t) => (
                                            <Badge key={t} label={t} tone="danger" />
                                          ))}
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
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