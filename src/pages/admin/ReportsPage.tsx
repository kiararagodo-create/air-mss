import { useEffect, useState, useCallback } from "react";
import { Download, RefreshCw } from "lucide-react";
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

export default function ReportsPage({ rooms, thresholds }: ReportsPageProps) {
  const [events, setEvents] = useState<DangerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const affectedRoomCount = new Set(events.map((e) => e.device_id)).size;

  const summaryCards: { label: string; value: number; border: string }[] = [
    { label: "TOTAL DEVICES", value: rooms.length, border: "#0d9488" },
    { label: "TOTAL DANGER EVENTS", value: events.length, border: "#d97706" },
    { label: "ROOMS AFFECTED", value: affectedRoomCount, border: "#dc2626" },
  ];

  const columns = [
    "TIMESTAMP",
    "ROOM & FLOOR",
    "DEVICE ID",
    "CO2",
    "LPG",
    "TEMP",
    "HUMIDITY",
    "TRIGGERED BY",
  ];

  return (
    <div>
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
            }}
          >
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5 }}>
              {c.label}
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, color: "#0f172a", marginTop: 4 }}>
              {c.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          background: "#fff",
          border: "1px solid #eef1f4",
          borderRadius: 12,
          padding: 16,
          overflowX: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div>
            <span style={{ fontWeight: 700, fontSize: 14.5, color: "#0f172a" }}>
              Danger Event Log
            </span>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              Recorded readings where CO2, LPG, temperature, or humidity reached the danger
              limit at the time - not current/live values.
            </div>
          </div>
          <span style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "nowrap" }}>
            {events.length} Recorded Event{events.length === 1 ? "" : "s"}
          </span>
        </div>

        {error ? (
          <div style={{ padding: "24px 6px", fontSize: 13, color: "#dc2626", textAlign: "center" }}>
            Failed to load danger events: {error}
          </div>
        ) : loading ? (
          <div style={{ padding: "24px 6px", fontSize: 13, color: "#94a3b8", textAlign: "center" }}>
            Loading recorded danger events...
          </div>
        ) : events.length === 0 ? (
          <div style={{ padding: "24px 6px", fontSize: 13, color: "#94a3b8", textAlign: "center" }}>
            No recorded readings have reached danger level yet.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#94a3b8", fontSize: 11 }}>
                {columns.map((h) => (
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
              {events.map((e) => (
                <tr key={e.id} style={{ borderBottom: "1px solid #f8fafc" }}>
                  <td style={{ padding: "10px 6px", color: "#475569", whiteSpace: "nowrap" }}>
                    {new Date(e.created_at).toLocaleString()}
                  </td>
                  <td style={{ padding: "10px 6px" }}>
                    <div style={{ fontWeight: 700, color: "#0f172a" }}>{e.roomName}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>{e.roomFloor}</div>
                  </td>
                  <td style={{ padding: "10px 6px", color: "#475569" }}>{e.device_id}</td>
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
    </div>
  );
}