// src/lib/monthlyPdf.ts
//
// Builds the monthly PDF entirely in the browser with jsPDF.

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { renderChartToDataUrl } from "./chartCanvas";
import { interpretMonth } from "./interpretation";
import { isSensorFault, inRange, isDhtFault } from "./sensorRanges";
import {
  METRIC_LABEL_SHORT,
  METRIC_ORDER,
  METRIC_UNIT_SHORT,
  MONTH_NAMES,
  type DailyMetricField,
  type MetricKey,
  type MonthStats,
  fetchMonthDangerEvents,
  type DangerRow,
  type DangerEvent,
  type RawReading,
} from "./reportQueries";
import { daysInMonth, fmtTimestamp, type ReportThresholds } from "./reports";

const TEAL: [number, number, number] = [13, 148, 136];
const SLATE: [number, number, number] = [100, 116, 139];

const PAGE_W = 215.9;
const PAGE_H = 355.6;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;

function num(n: number | null | undefined, metric: MetricKey): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return metric === "temp" ? n.toFixed(1) : Math.round(n).toLocaleString("en-US");
}

function monthlyReadingStatus(r: RawReading, th?: ReportThresholds): "normal" | "warning" | "danger" | "fault" {
  if (isSensorFault(r)) return "fault";
  if (!th) return "normal";
  const danger =
    (r.co2 !== null && inRange("co2", r.co2) && r.co2 >= th.co2_danger) ||
    (r.lpg !== null && inRange("lpg", r.lpg) && r.lpg >= th.lpg_danger) ||
    (r.temp !== null && inRange("temp", r.temp) && !isDhtFault(r.temp, r.humidity) && (r.temp < th.temp_freeze_below || r.temp > th.temp_heat_above)) ||
    (r.humidity !== null && inRange("humidity", r.humidity) && !isDhtFault(r.temp, r.humidity) && (r.humidity < th.humidity_dry_below || r.humidity > th.humidity_mold_above));
  if (danger) return "danger";
  const warning =
    (r.co2 !== null && inRange("co2", r.co2) && r.co2 >= th.co2_warning && r.co2 < th.co2_danger) ||
    (r.lpg !== null && inRange("lpg", r.lpg) && r.lpg >= th.lpg_warning && r.lpg < th.lpg_danger);
  if (warning) return "warning";
  return "normal";
}

function monthlyStatusLabel(status: "normal" | "warning" | "danger" | "fault"): string {
  return status === "fault" ? "Sensor fault" : status;
}

function monthlyTriggeredBy(r: RawReading, th?: ReportThresholds): string[] {
  if (isSensorFault(r) || !th) return [];
  const out: string[] = [];
  if (r.co2 !== null && inRange("co2", r.co2) && r.co2 >= th.co2_danger) out.push("CO2");
  if (r.lpg !== null && inRange("lpg", r.lpg) && r.lpg >= th.lpg_danger) out.push("LPG");
  if (r.temp !== null && inRange("temp", r.temp) && !isDhtFault(r.temp, r.humidity) && (r.temp < th.temp_freeze_below || r.temp > th.temp_heat_above)) out.push("Temperature");
  if (r.humidity !== null && inRange("humidity", r.humidity) && !isDhtFault(r.temp, r.humidity) && (r.humidity < th.humidity_dry_below || r.humidity > th.humidity_mold_above)) out.push("Humidity");
  if (out.length > 0) return out;
  const warn: string[] = [];
  if (r.co2 !== null && inRange("co2", r.co2) && r.co2 >= th.co2_warning && r.co2 < th.co2_danger) warn.push("CO2");
  if (r.lpg !== null && inRange("lpg", r.lpg) && r.lpg >= th.lpg_warning && r.lpg < th.lpg_danger) warn.push("LPG");
  return warn;
}

function toSeries(stats: MonthStats, metric: MetricKey): { day: number; value: number | null }[] {
  const avgKey: DailyMetricField = `${metric}_avg`;
  const byDay = new Map(
    stats.daily.map((d) => {
      const iso = String(d.day).slice(0, 10);
      return [Number(iso.slice(8, 10)), d] as const;
    })
  );
  const days = daysInMonth(`${stats.year}-${String(stats.month).padStart(2, "0")}-01`);
  const points: { day: number; value: number | null }[] = [];
  for (let d = 1; d <= days; d++) {
    const row = byDay.get(d);
    const raw = row ? row[avgKey] : null;
    points.push({ day: d, value: raw == null || !Number.isFinite(raw) ? null : raw });
  }
  return points;
}

export interface MonthlyPdfMeta {
  deviceLabel: string;
  year: number;
  month: number;
}

export async function downloadMonthlyPdf(
  stats: MonthStats,
  meta: MonthlyPdfMeta,
  extra?: { rawDangerRows?: DangerRow[]; includeRawDanger?: boolean; rooms?: { id: string; name: string }[]; readings?: RawReading[]; thresholds?: ReportThresholds }
): Promise<void> {
  const monthLabel = MONTH_NAMES[meta.month - 1];
  const doc = new jsPDF({ unit: "mm", format: "legal", orientation: "portrait" });
  let y = MARGIN;

  function sectionTitle(text: string) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...TEAL);
    doc.text(text, MARGIN, y);
  }

  function ensure(space: number) {
    if (y + space > PAGE_H - MARGIN - 12) {
      doc.addPage();
      y = MARGIN;
    }
  }

  // Header
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(15, 23, 42);
  doc.text("Environmental Quality Report", MARGIN, y);
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...SLATE);
  const headerLines = [
    `${meta.deviceLabel}`,
    `${monthLabel} ${meta.year}`,
    `Timezone: Asia/Manila (UTC+8) | ${stats.reading_count.toLocaleString("en-US")} readings`,
  ];
  for (const line of headerLines) {
    doc.text(line, MARGIN, y);
    y += 5;
  }
  y += 1;

  const lastDay = stats.daily.length > 0 ? stats.daily[stats.daily.length - 1].day : null;
  const lastUpdated = lastDay ? String(lastDay).slice(0, 10) : "-";
  doc.setFontSize(9);
  doc.text(`Last updated: ${lastUpdated}`, MARGIN, y);
  y += 5;
  doc.text(`Filters: Device = ${meta.deviceLabel}; Month = ${monthLabel} ${meta.year}; Timezone = Asia/Manila (UTC+8)`, MARGIN, y);
  y += 5;
  doc.text(`Active filters in words: ${meta.deviceLabel}, ${monthLabel} ${meta.year}, Asia/Manila (UTC+8).`, MARGIN, y);
  y += 8;

  // Summary table
  sectionTitle("Summary (valid readings only)");
  y += 5;

  const body: string[][] = [];
  for (const m of METRIC_ORDER) {
    const s = stats.metrics[m];
    body.push([
      METRIC_LABEL_SHORT[m],
      s && s.count > 0 ? num(s.avg, m) : "-",
      s && s.count > 0 ? num(s.min, m) : "-",
      s && s.count > 0 ? num(s.max, m) : "-",
      METRIC_UNIT_SHORT[m],
    ]);
  }

  autoTable(doc, {
    startY: y,
    head: [["Metric", "Avg", "Min", "Max", "Unit"]],
    body,
    theme: "grid",
    headStyles: { fillColor: TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: [30, 41, 59] },
    margin: { left: MARGIN, right: MARGIN },
    showHead: "everyPage",
  });
  y = (doc as any).lastAutoTable.finalY + 4;

  // Excluded note
  const ex = stats.excluded ?? { co2: 0, lpg: 0, temp: 0, humidity: 0 };
  const faultCount = stats.sensor_fault_readings ?? 0;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...SLATE);
  const excludedLine = `Excluded from statistics: CO2 ${Number(ex.co2 ?? 0).toLocaleString("en-US")} readings outside 300-10000 ppm, LPG ${Number(ex.lpg ?? 0).toLocaleString("en-US")} readings outside 0-10000 ppm, Temperature ${Number(ex.temp ?? 0).toLocaleString("en-US")} readings outside 10-50 C, Humidity ${Number(ex.humidity ?? 0).toLocaleString("en-US")} readings outside 5-100% (values outside plausible range or suspected sensor fault). Raw data is unchanged.`;
  const exLines = doc.splitTextToSize(excludedLine, CONTENT_W) as string[];
  for (const ln of exLines) {
    ensure(5);
    doc.text(ln, MARGIN, y);
    y += 4.5;
  }
  y += 2;

  // Counts line
  ensure(8);
  doc.setFontSize(9);
  const countLine =
    `Readings: ${stats.reading_count.toLocaleString("en-US")} | Danger readings: ${stats.danger_readings.toLocaleString("en-US")} | Days with data: ${stats.days_with_data} | Suspected sensor-fault readings: ${faultCount.toLocaleString("en-US")}`;
  const countLines = doc.splitTextToSize(countLine, CONTENT_W) as string[];
  for (const ln of countLines) {
    doc.text(ln, MARGIN, y);
    y += 4.5;
  }
  y += 4;

  // Charts
  sectionTitle("Daily averages");
  y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...SLATE);
  doc.text("Solid line: daily average. Dots: days with data. Red dashed line: danger threshold.", MARGIN, y);
  y += 6;

  const CHART_RENDER_W = 700;
  const CHART_RENDER_H = 200;
  const CHART_W = CONTENT_W;
  const CHART_H = (CHART_RENDER_H / CHART_RENDER_W) * CHART_W;

  for (const m of METRIC_ORDER) {
    const points = toSeries(stats, m);
    const hasData = points.some((p) => p.value !== null);
    if (!hasData) continue;

    const thresholdHigh =
      m === "co2" || m === "lpg"
        ? stats.thresholds[`${m}_danger` as keyof typeof stats.thresholds]
        : stats.thresholds[m === "temp" ? "temp_heat_above" : "humidity_mold_above"];
    const thresholdLow = m === "temp" ? stats.thresholds.temp_freeze_below : m === "humidity" ? stats.thresholds.humidity_dry_below : null;

    const dataUrl = renderChartToDataUrl({
      points: points.map((p) => ({ day: p.day, value: p.value })),
      thresholdHigh: thresholdHigh ?? null,
      thresholdLow: thresholdLow ?? null,
      unit: METRIC_UNIT_SHORT[m],
      width: CHART_RENDER_W,
      height: CHART_RENDER_H,
      month: meta.month,
      year: meta.year,
    });
    if (!dataUrl) continue;

    const blockH = 6 + CHART_H + 6;
    ensure(blockH);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(METRIC_LABEL_SHORT[m], MARGIN, y + 4);
    doc.addImage(dataUrl, "PNG", MARGIN, y + 6, CONTENT_W, CHART_H, undefined, "FAST");
    y += 6 + CHART_H + 6;
  }

  // Daily summary table: every calendar day
  ensure(12);
  sectionTitle("Daily summary");
  y += 5;

  const days = daysInMonth(`${meta.year}-${String(meta.month).padStart(2, "0")}-01`);
  const byDay = new Map(stats.daily.map((d) => [String(d.day).slice(0, 10), d]));
  const dailyBody: string[][] = [];
  for (let d = 1; d <= days; d++) {
    const iso = `${meta.year}-${String(meta.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const row = byDay.get(iso);
    if (!row) {
      dailyBody.push([`${monthLabel.slice(0, 3)} ${d}`, "NO DATA", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
      continue;
    }
    dailyBody.push([
      `${monthLabel.slice(0, 3)} ${d}`,
      String(row.reading_count ?? 0),
      String(row.danger_readings ?? 0),
      num(row.co2_min, "co2"),
      num(row.co2_avg, "co2"),
      num(row.co2_max, "co2"),
      num(row.lpg_min, "lpg"),
      num(row.lpg_avg, "lpg"),
      num(row.lpg_max, "lpg"),
      num(row.temp_min, "temp"),
      num(row.temp_avg, "temp"),
      num(row.temp_max, "temp"),
      num(row.humidity_min, "humidity"),
      num(row.humidity_avg, "humidity"),
      num(row.humidity_max, "humidity"),
    ]);
  }

  autoTable(doc, {
    startY: y,
    head: [["Date", "Readings", "Danger", "CO2 Min", "CO2 Avg", "CO2 Max", "LPG Min", "LPG Avg", "LPG Max", "Temp Min", "Temp Avg", "Temp Max", "Hum Min", "Hum Avg", "Hum Max"]],
    body: dailyBody,
    theme: "grid",
    headStyles: { fillColor: TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 6.5 },
    bodyStyles: { fontSize: 6.5, textColor: [30, 41, 59] },
    margin: { left: MARGIN, right: MARGIN },
    showHead: "everyPage",
    columnStyles: {
      0: { cellWidth: 16 },
    },
  });
  y = (doc as any).lastAutoTable.finalY + 6;

  // Danger events
  ensure(12);
  sectionTitle("Danger events");
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...SLATE);
  doc.text("Consecutive danger readings grouped into events.", MARGIN, y);
  y += 5;

  let events: DangerEvent[] = [];
  try {
    events = await fetchMonthDangerEvents(meta.year, meta.month, stats.device_id, stats.thresholds as any);
  } catch (e) {
    events = [];
  }

  if (events.length === 0) {
    doc.text("No danger events.", MARGIN, y);
    y += 6;
  } else {
    const evBody = events.map((ev) => [
      fmtTimestamp(ev.started_at),
      fmtTimestamp(ev.ended_at),
      `${Math.max(0, ev.duration_seconds ?? 0)}s`,
      String(ev.reading_count ?? 0),
      (ev.sensors ?? []).join(", "),
      ev.peak_value == null ? "-" : `${num(ev.peak_value, (ev.peak_metric === "CO2" ? "co2" : ev.peak_metric === "LPG" ? "lpg" : ev.peak_metric === "Temperature" ? "temp" : "humidity") as MetricKey)} @ ${ev.peak_time ? fmtTimestamp(ev.peak_time) : "-"}`,
    ]);
    autoTable(doc, {
      startY: y,
      head: [["Started", "Ended", "Duration", "Readings", "Sensor(s)", "Peak value (time)"]],
      body: evBody,
      theme: "grid",
      headStyles: { fillColor: TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 7.5 },
      bodyStyles: { fontSize: 7.5, textColor: [30, 41, 59] },
      margin: { left: MARGIN, right: MARGIN },
      showHead: "everyPage",
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }

  // Optional raw danger table
  if (extra?.includeRawDanger && extra.rawDangerRows && extra.rawDangerRows.length > 0) {
    ensure(12);
    sectionTitle("Full raw danger readings");
    y += 5;
    const rawBody = extra.rawDangerRows.map((r) => [
      fmtTimestamp(r.created_at),
      (extra.rooms ?? []).find((rm) => String(rm.id) === String(r.device_id))?.name ?? r.device_id ?? "-",
      r.co2 == null ? "-" : num(r.co2, "co2"),
      r.lpg == null ? "-" : num(r.lpg, "lpg"),
      r.temp == null ? "-" : num(r.temp, "temp"),
      r.humidity == null ? "-" : num(r.humidity, "humidity"),
      (r.triggered_by ?? []).join(", "),
    ]);
    autoTable(doc, {
      startY: y,
      head: [["Time", "Room/Device", "CO2", "LPG", "Temp", "Humidity", "Triggered by"]],
      body: rawBody,
      theme: "grid",
      headStyles: { fillColor: TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 7 },
      bodyStyles: { fontSize: 7, textColor: [30, 41, 59] },
      margin: { left: MARGIN, right: MARGIN },
      showHead: "everyPage",
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }

  // Full readings table
  const readings = extra?.readings ?? [];
  const th = extra?.thresholds;
  if (readings.length > 0) {
    ensure(12);
    sectionTitle("Readings");
    y += 5;
    const normalCount = readings.filter((r) => monthlyReadingStatus(r, th) === "normal").length;
    const dangerCount = readings.filter((r) => monthlyReadingStatus(r, th) === "danger").length;
    const faultCount = readings.filter((r) => monthlyReadingStatus(r, th) === "fault").length;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...SLATE);
    doc.text(`Totals: Normal ${normalCount.toLocaleString("en-US")} | Danger ${dangerCount.toLocaleString("en-US")} | Sensor fault ${faultCount.toLocaleString("en-US")} | Total ${readings.length.toLocaleString("en-US")}`, MARGIN, y);
    y += 6;
    const body = readings.map((r) => [
      fmtTimestamp(r.created_at),
      (extra?.rooms ?? []).find((rm) => String(rm.id) === String(r.device_id))?.name ?? r.device_id ?? "-",
      r.co2 == null ? "-" : num(r.co2, "co2"),
      r.lpg == null ? "-" : num(r.lpg, "lpg"),
      r.temp == null ? "-" : num(r.temp, "temp"),
      r.humidity == null ? "-" : num(r.humidity, "humidity"),
      monthlyStatusLabel(monthlyReadingStatus(r, th)),
      monthlyTriggeredBy(r, th).join(", "),
    ]);
    autoTable(doc, {
      startY: y,
      head: [["Time", "Room/Device", "CO2", "LPG", "Temp", "Humidity", "Status", "Triggered By"]],
      body,
      theme: "grid",
      headStyles: { fillColor: TEAL, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 7 },
      bodyStyles: { fontSize: 7, textColor: [30, 41, 59] },
      margin: { left: MARGIN, right: MARGIN },
      showHead: "everyPage",
      didParseCell: (hookData: any) => {
        if (hookData.section !== "body") return;
        const row = readings[hookData.row.index];
        if (row && monthlyReadingStatus(row, th) === "danger") {
          hookData.cell.styles.textColor = [220, 38, 38];
          hookData.cell.styles.fillColor = [254, 226, 226];
        }
      },
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }

  // Interpretation
  const paragraphs = interpretMonth({
    year: meta.year,
    month: meta.month,
    monthLabel: `${monthLabel} ${meta.year}`,
    deviceLabel: meta.deviceLabel,
    readingCount: stats.reading_count,
    dangerReadings: stats.danger_readings,
    daysWithData: stats.days_with_data,
    daysWithDanger: stats.days_with_danger,
    metrics: stats.metrics,
    dangerByMetric: stats.danger_by_metric,
    daily: stats.daily,
    thresholds: stats.thresholds as any,
    daysInMonth: days,
  });

  ensure(12);
  sectionTitle("Interpretation");
  y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  for (const p of paragraphs) {
    const lines = doc.splitTextToSize(p, CONTENT_W) as string[];
    for (const line of lines) {
      ensure(5);
      doc.text(line, MARGIN, y);
      y += 4.6;
    }
    y += 3;
  }

  // Footer on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text("A.I.R. Sensor Monitoring System", MARGIN, PAGE_H - 8);
    doc.text(`Page ${p} of ${pages}`, MARGIN + CONTENT_W, PAGE_H - 8, { align: "right" });
  }

  const filename = `AIR-${meta.year}-${String(meta.month).padStart(2, "0")}-${meta.deviceLabel}`
    .replace(/[^\w.-]+/g, "-")
    .slice(0, 90);
  doc.save(`${filename}.pdf`);
}

