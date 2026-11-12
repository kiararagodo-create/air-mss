// src/lib/dayPdf.ts

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { renderTimeChartToDataUrl } from "./chartCanvas";
import { METRIC_LABEL_SHORT, METRIC_UNIT_SHORT, type MetricKey } from "./reportQueries";
import { fmtTimestamp } from "./reports";

import type { ReportThresholds } from "./reports";

const TEAL: [number, number, number] = [13, 148, 136];
const SLATE: [number, number, number] = [100, 116, 139];
const PAGE_W = 215.9;
const PAGE_H = 355.6;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;

interface DayPdfReading {
  created_at: string;
  device_id: string;
  co2: number | null;
  lpg: number | null;
  temp: number | null;
  humidity: number | null;
  status: string;
  triggered_by: string[];
}

interface DayPdfData {
  day: string;
  deviceLabel: string;
  rooms?: { id: string; name: string }[];
  reading_count: number;
  danger_readings: number;
  normal_readings?: number;
  readings?: DayPdfReading[];
  metrics: Record<MetricKey, { min: number | null; avg: number | null; max: number | null; count: number }>;
  excluded: Record<MetricKey, number>;
  sensor_fault_readings: number;
  thresholds: ReportThresholds;
  selectedSensors: MetricKey[];
  statusFilter: string;
  timeFrom: string;
  timeTo: string;
}

export async function downloadDayPdf(
  data: DayPdfData,
  chartPoints: { t: number; metric: MetricKey; v: number | null }[],
  readings: DayPdfReading[],
  _filters: any
): Promise<void> {
  const doc = new jsPDF({ unit: "mm", format: "legal", orientation: "portrait" });
  let y = MARGIN;

  function ensure(space: number) {
    if (y + space > PAGE_H - MARGIN - 12) {
      doc.addPage();
      y = MARGIN;
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(15, 23, 42);
  doc.text("Environmental Quality Report", MARGIN, y);
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...SLATE);
  const lines = [
    `${data.deviceLabel}`,
    `${data.day}`,
    `Timezone: Asia/Manila (UTC+8) | ${data.reading_count.toLocaleString("en-US")} readings`,
    `Filters: sensors=${data.selectedSensors.join(",")}; status=${data.statusFilter}; time=${data.timeFrom || "start"}-${data.timeTo || "end"}`,
  ];
  for (const ln of lines) {
    doc.text(ln, MARGIN, y);
    y += 5;
  }
  y += 4;

  // Min/Avg/Max cards
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...TEAL);
  doc.text("Summary", MARGIN, y);
  y += 5;

  const cardW = CONTENT_W / Math.max(1, data.selectedSensors.length);
  let cx = MARGIN;
  for (const m of data.selectedSensors) {
    const s = data.metrics[m];
    const has = s && s.count > 0;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(`${METRIC_LABEL_SHORT[m]} (${METRIC_UNIT_SHORT[m]})`, cx, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...SLATE);
    doc.text(`Min: ${has ? (m === "temp" ? s.min!.toFixed(1) : Math.round(s.min!).toLocaleString("en-US")) : "-"}`, cx, y + 4);
    doc.text(`Avg: ${has ? (m === "temp" ? s.avg!.toFixed(1) : Math.round(s.avg!).toLocaleString("en-US")) : "-"}`, cx, y + 8);
    doc.text(`Max: ${has ? (m === "temp" ? s.max!.toFixed(1) : Math.round(s.max!).toLocaleString("en-US")) : "-"}`, cx, y + 12);
    cx += cardW;
  }
  y += 18;

  doc.setFontSize(9);
  const ex = data.excluded;
doc.text(
    `Excluded from statistics: CO2 ${ex.co2} readings outside 300-10000 ppm, LPG ${ex.lpg} readings outside 0-10000 ppm, Temperature ${ex.temp} readings outside 10-50 C, Humidity ${ex.humidity} readings outside 5-100% (values outside plausible range or suspected sensor fault). Raw data is unchanged.`,
    MARGIN,
    y
);
  y += 5;
  doc.text(
    `Counts: Readings ${data.reading_count} | Normal ${data.normal_readings ?? 0} | Danger ${data.danger_readings} | Suspected sensor-fault ${data.sensor_fault_readings}`,
    MARGIN,
    y
  );
  y += 8;

  // Charts
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...TEAL);
  doc.text("Through the day", MARGIN, y);
  y += 5;

  const CHART_W = CONTENT_W;
  const CHART_H = 45;

  for (const m of data.selectedSensors) {
    const pts = chartPoints
      .filter((p) => p.metric === m)
      .map((p) => ({ t: p.t, v: p.v }));
    if (!pts.some((p) => p.v !== null)) continue;

    const hi = m === "co2" ? data.thresholds.co2_danger : m === "lpg" ? data.thresholds.lpg_danger : m === "temp" ? data.thresholds.temp_heat_above : data.thresholds.humidity_mold_above;
    const lo = m === "temp" ? data.thresholds.temp_freeze_below : m === "humidity" ? data.thresholds.humidity_dry_below : null;

    const dataUrl = renderTimeChartToDataUrl({
      points: pts,
      thresholdHigh: hi ?? null,
      thresholdLow: lo ?? null,
      unit: METRIC_UNIT_SHORT[m],
      width: 700,
      height: 200,
      formatX: (t: number) =>
        new Date(t).toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false }),
    });
    if (!dataUrl) continue;

    ensure(10 + CHART_H);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(METRIC_LABEL_SHORT[m], MARGIN, y + 4);
    doc.addImage(dataUrl, "PNG", MARGIN, y + 6, CHART_W, CHART_H, undefined, "FAST");
    y += 6 + CHART_H + 6;
  }

  // Readings table
  if (readings && readings.length > 0) {
    ensure(12);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...TEAL);
    doc.text("Readings", MARGIN, y);
    y += 5;

    const body = readings.map((r) => [
      fmtTimestamp(r.created_at),
      (data.rooms ?? []).find((rm) => String(rm.id) === String(r.device_id))?.name ?? r.device_id ?? "-",
      r.co2 == null ? "-" : Math.round(r.co2).toLocaleString("en-US"),
      r.lpg == null ? "-" : Math.round(r.lpg).toLocaleString("en-US"),
      r.temp == null ? "-" : r.temp.toFixed(1),
      r.humidity == null ? "-" : Math.round(r.humidity).toLocaleString("en-US"),
      r.status ?? "normal",
      (r.triggered_by ?? []).join(", "),
    ]);
    autoTable(doc, {
      startY: y,
      head: [["Time", "Room/Device", "CO2", "LPG", "Temp", "Humidity", "Status", "Triggered By"]],
      body,
      theme: "grid",
      headStyles: { fillColor: TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 7.5 },
      bodyStyles: { fontSize: 7.5, textColor: [30, 41, 59] },
      margin: { left: MARGIN, right: MARGIN },
      showHead: "everyPage",
      didParseCell: (hookData: any) => {
        if (hookData.section !== "body") return;
        const row = readings[hookData.row.index];
        if (row && row.status === "danger") {
          hookData.cell.styles.textColor = [220, 38, 38];
          hookData.cell.styles.fillColor = [254, 226, 226];
        }
      },
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text("A.I.R. Sensor Monitoring System", MARGIN, PAGE_H - 8);
    doc.text(`Page ${p} of ${pages}`, MARGIN + CONTENT_W, PAGE_H - 8, { align: "right" });
  }

  const filename = `AIR-Day-${data.day}-${data.deviceLabel}`.replace(/[^\w.-]+/g, "-").slice(0, 90);
  doc.save(`${filename}.pdf`);
}
