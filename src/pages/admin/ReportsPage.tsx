import { Download } from "lucide-react";
import { Badge } from "../../ui";
import { Room, Thresholds, getStatus } from "../../data/data";

interface ReportsPageProps {
  rooms: Room[];
  thresholds: Thresholds;
}

function escapeCSV(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function exportCSV(rooms: Room[], thresholds: Thresholds) {
  const headers = [
    "ROOM & FLOOR",
    "DEVICE ID",
    "CURRENT CO2",
    "ALERT COUNT",
    "CURRENT LPG",
    "CO2 LIMIT",
    "LPG LIMIT",
    "STATUS",
  ];

  const rows = rooms.map((r) => {
    const st = getStatus(r, thresholds);
    return [
      `${r.name} / ${r.floor}`,
      r.id,
      r.co2 != null ? `${Math.round(r.co2)} ppm` : "N/A",
      r.alertCount.toString(),
      r.lpg != null ? `${Math.round(r.lpg)} ppm` : "N/A (CO2 only)",
      `${thresholds.co2.danger} ppm`,
      `${thresholds.lpg.danger} ppm`,
      st.label,
    ];
  });

  const csvContent = [headers, ...rows]
    .map((row) => row.map(escapeCSV).join(","))
    .join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", "reports.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function ReportsPage({ rooms, thresholds }: ReportsPageProps) {
  const totalAlerts = rooms.reduce((sum, r) => sum + r.alertCount, 0);
  const atRisk = rooms.filter((r) => getStatus(r, thresholds).severity >= 2).length;

  // Audit table + CSV export only surface rooms currently at Warning, High Gas,
  // or Danger (severity >= 1) — this mirrors the Dashboard's live meter status
  // since there's no real sensor hardware wired in yet. "Good" rooms are omitted
  // from the log because this table is meant to read as an alert/event log.
  const loggedRooms = rooms.filter((r) => getStatus(r, thresholds).severity >= 1);

  const summaryCards: { label: string; value: number; border: string }[] = [
    { label: "TOTAL DEVICES", value: rooms.length, border: "#0d9488" },
    { label: "TOTAL ALERTS", value: totalAlerts, border: "#d97706" },
    { label: "ROOMS AT RISK", value: atRisk, border: "#dc2626" },
  ];

  const columns = [
    "ROOM & FLOOR",
    "DEVICE ID",
    "CURRENT CO2",
    "ALERT COUNT",
    "CURRENT LPG",
    "CO2 LIMIT",
    "LPG LIMIT",
    "STATUS",
  ];

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
            Environmental Quality Reports & Logs
          </h1>
          <p style={{ color: "#64748b", fontSize: 13.5, margin: "4px 0 0" }}>
            Historical telemetry data and threshold event audit logs
          </p>
        </div>
        <button
          onClick={() => exportCSV(loggedRooms, thresholds)}
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
          <Download size={15} /> Export CSV Report
        </button>
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
              Building Sensor Readings Audit Table
            </span>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              Showing Warning, High Gas, and Danger readings only
            </div>
          </div>
          <span style={{ fontSize: 12, color: "#94a3b8" }}>{loggedRooms.length} Active Rows</span>
        </div>
        {loggedRooms.length === 0 ? (
          <div style={{ padding: "24px 6px", fontSize: 13, color: "#94a3b8", textAlign: "center" }}>
            No rooms currently at Warning, High Gas, or Danger levels.
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
              {loggedRooms.map((r) => {
                const st = getStatus(r, thresholds);
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid #f8fafc" }}>
                    <td style={{ padding: "10px 6px" }}>
                      <div style={{ fontWeight: 700, color: "#0f172a" }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8" }}>{r.floor}</div>
                    </td>
                    <td style={{ padding: "10px 6px", color: "#475569" }}>{r.id}</td>
                    <td style={{ padding: "10px 6px", fontWeight: 700 }}>{r.co2 != null ? `${Math.round(r.co2)} ppm` : "N/A"}</td>
                    <td style={{ padding: "10px 6px" }}>
                      <span
                        style={{
                          background: r.alertCount > 0 ? "#FAEEDA" : "#f1f5f9",
                          color: r.alertCount > 0 ? "#854F0B" : "#64748b",
                          padding: "2px 8px",
                          borderRadius: 6,
                          fontWeight: 700,
                        }}
                      >
                        {r.alertCount}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "10px 6px",
                        fontWeight: 700,
                        color: r.lpg != null ? "#dc2626" : "#94a3b8",
                      }}
                    >
                      {r.lpg != null ? `${Math.round(r.lpg)} ppm` : "N/A (CO2 only)"}
                    </td>
                    <td style={{ padding: "10px 6px", color: "#475569" }}>{thresholds.co2.danger} ppm</td>
                    <td style={{ padding: "10px 6px", color: "#475569" }}>{thresholds.lpg.danger} ppm</td>
                    <td style={{ padding: "10px 6px" }}>
                      <Badge label={st.label} tone={st.tone} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
