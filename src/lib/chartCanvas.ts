// src/lib/chartCanvas.ts
//
// Draws the monthly charts on a canvas and returns a PNG data URL, which jsPDF
// embeds directly. Doing the drawing on a canvas rather than re-implementing a
// vector chart in jsPDF keeps the chart code in one place and matches how the
// on-screen chart is built.
//
// The project has no charting library - src/components/ReportChart.tsx is
// hand-rolled SVG - so this is deliberately small and self-contained.

export interface CanvasSeriesPoint {
  /** Day of month, 1-based. */
  day: number;
  /** Null when that day had no readings. The line breaks over the gap. */
  value: number | null;
}

export interface CanvasChartOptions {
  points: CanvasSeriesPoint[];
  thresholdHigh: number | null;
  thresholdLow: number | null;
  unit: string;
  width: number;
  height: number;
}

const TEAL = "#0d9488";
const RED = "#dc2626";
const GRID = "#e2e8f0";
const AXIS = "#94a3b8";
const TEXT = "#64748b";

/**
 * Renders a line chart as a PNG.
 * The danger threshold is drawn as a horizontal dashed red line so it can be
 * read against the daily averages.
 */
export function renderChartToDataUrl(opts: CanvasChartOptions): string {
  const { points, thresholdHigh, thresholdLow, unit, width, height } = opts;

  // devicePixelRatio keeps the embedded image sharp in the PDF.
  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(dpr, dpr);

  const padL = 52;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const thresholds = [thresholdHigh, thresholdLow].filter(
    (v): v is number => v !== null && v !== undefined
  );
  if (values.length === 0) return "";

  // Always include the thresholds in the y-range so the limit line is visible
  // even when the data never approaches it.
  let lo = Math.min(...values, ...thresholds);
  let hi = Math.max(...values, ...thresholds);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;

  const days = points.length;
  const x = (i: number) => padL + (days <= 1 ? plotW / 2 : (i / (days - 1)) * plotW);
  const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  // Grid + y labels
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.fillStyle = TEXT;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = lo + ((hi - lo) * t) / ticks;
    const py = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(width - padR, py);
    ctx.stroke();
    ctx.fillText(formatTick(v), padL - 6, py);
  }

  // X labels: first, middle, last day of month
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelAt = [0, Math.floor((days - 1) / 2), days - 1];
  for (const i of labelAt) {
    ctx.fillText(String(points[i].day), x(i), padT + plotH + 6);
  }

  // Threshold lines
  const drawThreshold = (v: number) => {
    ctx.save();
    ctx.strokeStyle = RED;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    const py = Math.round(y(v)) + 0.5;
    ctx.moveTo(padL, py);
    ctx.lineTo(width - padR, py);
    ctx.stroke();
    ctx.restore();
  };
  if (thresholdHigh !== null) drawThreshold(thresholdHigh);
  if (thresholdLow !== null) drawThreshold(thresholdLow);

  // Series. Breaks wherever a day is missing, so gaps are visible as gaps
  // rather than being bridged into a line that implies data.
  ctx.strokeStyle = TEAL;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let penDown = false;
  points.forEach((p, i) => {
    if (p.value === null) {
      penDown = false;
      return;
    }
    const px = x(i);
    const py = y(p.value);
    if (!penDown) {
      ctx.moveTo(px, py);
      penDown = true;
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.stroke();

  // Unit label
  ctx.fillStyle = AXIS;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(unit, 4, 2);

  return canvas.toDataURL("image/png");
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 10000) return `${Math.round(v / 1000)}k`;
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return v.toFixed(1);
}