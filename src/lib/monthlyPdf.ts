// src/lib/monthlyPdf.ts
//
// Builds the monthly PDF entirely in the browser with jsPDF. There is no edge
// function, no monthly_reports table and no storage bucket.
//
// Layout: A4 portrait, teal accent, matching the on-screen cards.
//   1. Header - title, device/room, month/year, timezone
//   2. Summary table - avg/min/max per metric, reading + danger counts
//   3. One chart per metric with the danger threshold drawn in
//   4. Interpretation - rule-based paragraphs from interpretation.ts

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { renderChartToDataUrl, type CanvasSeriesPoint } from "./chartCanvas";
import { interpretMonth } from "./interpretation";
import {
  METRIC_LABEL_SHORT,
  METRIC_ORDER,
  METRIC_UNIT_SHORT,
  MONTH_NAMES,
  type DailyMetricField,
  type MetricKey,
  type MonthStats,
} from "./reportQueries";

const TEAL: [number, number, number] = [13, 148, 136];
const SLATE: [number, number, number] = [100, 116, 139];
const LINE: [number, number, number] = [226, 232, 240];

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 16;
const CONTENT_W = PAGE_W - MARGIN * 2;

function num(n: number | null | undefined, metric: MetricKey): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return metric === "temp" ? n.toFixed(1) : Math.round(n).toLocaleString("en-US");
}

/** Daily rows -> one point per day of month, in calendar order. */
function toSeries(stats: MonthStats, metric: MetricKey): CanvasSeriesPoint[] {
  const avgKey: DailyMetricField = `${metric}_avg`;
  const byDay = new Map(stats.daily.map((d) => [Number(d.day.slice(8, 10)), d]));
  const daysInMonth = new Date(Date.UTC(stats.year, stats.month, 0)).getUTCDate();
  const points: CanvasSeriesPoint[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const row = byDay.get(d);
    points.push({ day: d, value: row ? row[avgKey] : null });
  }
  return points;
}

export interface MonthlyPdfMeta {
  deviceLabel: string;
  year: number;
  month: number;
}

/**
 * Renders and downloads the monthly PDF. Returns nothing; triggers a download.
 */
export function downloadMonthlyPdf(stats: MonthStats, meta: MonthlyPdfMeta): void {
  const monthLabel = MONTH_NAMES[meta.month - 1];
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  // ---------------------------------------------------------------- header --
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(15, 23, 42);
  doc.text("Environmental Quality Report", MARGIN, y);
  y += 7;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...SLATE);
  const th = stats.thresholds as unknown as Record<string, number>;
  const headerLines = [
    `${meta.deviceLabel}`,
    `${monthLabel} ${meta.year}`,
    `Timezone: Asia/Manila (UTC+8)  ·  ${stats.reading_count.toLocaleString("en-US")} readings`,
  ];
  for (const line of headerLines) {
    doc.text(line, MARGIN, y);
    y += 5;
  }
  y += 2;

  // Teal rule under the header.
  doc.setDrawColor(...TEAL);
  doc.setLineWidth(0.8);
  doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
  y += 8;

  // ----------------------------------------------------------- summary ------
  sectionTitle(doc, "Summary", MARGIN, y);
  y += 2;

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
    columnStyles: {
      1: { halign: "right" },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "left" },
    },
    margin: { left: MARGIN, right: MARGIN },
    didDrawCell: (d) => {
      if (d.section === "body") doc.setDrawColor(...LINE);
    },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;

  // Counts row.
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...SLATE);
  const countLine =
    `Readings: ${stats.reading_count.toLocaleString("en-US")}   ·   ` +
    `Danger readings: ${stats.danger_readings.toLocaleString("en-US")}   ·   ` +
    `Days with data: ${stats.days_with_data}   ·   ` +
    `Days with a danger reading: ${stats.days_with_danger}`;
  doc.text(countLine, MARGIN, y);
  y += 9;

  // -------------------------------------------------------------- charts ----
  sectionTitle(doc, "Daily averages", MARGIN, y);
  y += 1;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...SLATE);
  doc.text(
    "Solid line: daily average.  Red dashed line: danger threshold.",
    MARGIN,
    y + 3
  );
  y += 9;

  const CHART_W = CONTENT_W;
  const CHART_H = 46;
  const CHART_GAP = 6;
  const CHART_LABEL = 6;

  for (const m of METRIC_ORDER) {
    const points = toSeries(stats, m);
    const hasData = points.some((p) => p.value !== null);
    if (!hasData) continue;

    const thresholdHigh =
      m === "co2" || m === "lpg" ? th[`${m}_danger`] : th[`${m === "temp" ? "temp_heat_above" : "humidity_mold_above"}`];
    const thresholdLow = m === "temp" ? th.temp_freeze_below : m === "humidity" ? th.humidity_dry_below : null;

    const dataUrl = renderChartToDataUrl({
      points,
      thresholdHigh: thresholdHigh ?? null,
      thresholdLow: thresholdLow ?? null,
      unit: METRIC_UNIT_SHORT[m],
      width: 700,
      height: 200,
    });
    if (!dataUrl) continue;

    // Keep the chart and its label together on one page.
    const blockH = CHART_LABEL + CHART_H;
    if (y + blockH > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text(METRIC_LABEL_SHORT[m], MARGIN, y + 4);

    const drawH = (CHART_H / CHART_W) * CONTENT_W;
    doc.addImage(dataUrl, "PNG", MARGIN, y + CHART_LABEL, CONTENT_W, drawH, undefined, "FAST");
    y += CHART_LABEL + drawH + CHART_GAP;
  }

  // ------------------------------------------------------- interpretation ----
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
    thresholds: th,
    daysInMonth: new Date(Date.UTC(meta.year, meta.month, 0)).getUTCDate(),
  });

  if (y + 26 > PAGE_H - MARGIN) {
    doc.addPage();
    y = MARGIN;
  }
  y += 4;
  sectionTitle(doc, "Interpretation", MARGIN, y);
  y += 3;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(51, 65, 85);
  for (const p of paragraphs) {
    const lines = doc.splitTextToSize(p, CONTENT_W) as string[];
    for (const line of lines) {
      if (y > PAGE_H - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(line, MARGIN, y);
      y += 4.6;
    }
    y += 3;
  }

  // --------------------------------------------------------------- footer ---
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text("A.I.R. air quality monitoring", MARGIN, PAGE_H - 8);
    doc.text(`Page ${p} of ${pages}`, MARGIN + CONTENT_W, PAGE_H - 8, { align: "right" });
  }

  const filename = `AIR-${meta.year}-${String(meta.month).padStart(2, "0")}-${meta.deviceLabel}`
    .replace(/[^\w.-]+/g, "-")
    .slice(0, 90);
  doc.save(`${filename}.pdf`);
}

function sectionTitle(doc: jsPDF, text: string, x: number, y: number): void {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...TEAL);
  doc.text(text, x, y);
}