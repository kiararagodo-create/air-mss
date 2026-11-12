// src/lib/chartCanvas.ts
//
// Draws the monthly charts on a canvas and returns a PNG data URL, which jsPDF
// embeds directly.

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
  month?: number;
  year?: number;
}

const TEAL = "#0d9488";
const RED = "#dc2626";
const GRID = "#e2e8f0";
const AXIS = "#94a3b8";
const TEXT = "#64748b";
const DOT = "#0d9488";

export function renderChartToDataUrl(opts: CanvasChartOptions): string {
  const { points, thresholdHigh, thresholdLow, unit, width, height } = opts;
  const month = opts.month ?? new Date().getMonth() + 1;
  const year = opts.year ?? new Date().getFullYear();

  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(dpr, dpr);

  const values = points
    .map((p) => p.value)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const thresholds = [thresholdHigh, thresholdLow].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  if (values.length === 0) return "";

  let lo = Math.min(...values, ...thresholds);
  let hi = Math.max(...values, ...thresholds);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;

  // Y tick labels first, so the left margin can be sized to the widest one.
  const ticks = 4;
  const tickVals: number[] = [];
  for (let t = 0; t <= ticks; t++) tickVals.push(lo + ((hi - lo) * t) / ticks);
  const labels = tickVals.map(formatTick);
  ctx.font = "10px sans-serif";
  let widest = 0;
  for (const lab of labels) widest = Math.max(widest, ctx.measureText(lab).width);
  const padL = Math.max(56, Math.ceil(widest + 10));
  const padR = 14;
  const padT = 24; // room for Y-axis title above plot
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

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
  for (let t = 0; t <= ticks; t++) {
    const v = tickVals[t];
    const py = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(width - padR, py);
    ctx.stroke();
    ctx.fillText(labels[t], padL - 6, py);
  }

  // Y-axis title above plot area
  ctx.fillStyle = AXIS;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(unit, padL, 4);

  // X labels: real dates for every ~5th day to avoid crowding, plus first/last
  ctx.fillStyle = TEXT;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const shortMonth = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "short" });
  const step = Math.max(1, Math.floor(days / 6));
  const shown = new Set<number>();
  shown.add(0);
  shown.add(days - 1);
  for (let i = 0; i < days; i += step) shown.add(i);
  for (const i of shown) {
    ctx.fillText(`${shortMonth} ${points[i].day}`, x(i), padT + plotH + 6);
  }

  // Threshold lines with labels
  const drawThreshold = (v: number, label: string) => {
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
    ctx.fillStyle = RED;
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${label} ${formatTick(v)}`, padL + 4, py - 2);
  };
  if (thresholdHigh !== null) drawThreshold(thresholdHigh, "Danger");
  if (thresholdLow !== null) drawThreshold(thresholdLow, "Low");

  // Series. Breaks wherever a day is missing.
  ctx.strokeStyle = TEAL;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let penDown = false;
  points.forEach((p, i) => {
    if (p.value == null || !Number.isFinite(p.value)) {
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

  // Dots at every day with data
  ctx.fillStyle = DOT;
  points.forEach((p, i) => {
    if (p.value == null || !Number.isFinite(p.value)) return;
    const px = x(i);
    const py = y(p.value);
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Warning threshold line? thresholdHigh already danger. If a separate warning passed? Not in options.

  // Unit label (already drawn). Keep nothing else.

  return canvas.toDataURL("image/png");
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString("en-US");
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return v.toFixed(1);
}

export interface TimeChartPoint { t: number; v: number | null; }

export function renderTimeChartToDataUrl(opts: {
  points: TimeChartPoint[];
  thresholdHigh: number | null;
  thresholdLow: number | null;
  unit: string;
  width: number;
  height: number;
  formatX?: (t: number) => string;
}): string {
  const { points, thresholdHigh, thresholdLow, unit, width, height } = opts;
  const fmtX = opts.formatX ?? ((t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }));
  const dpr = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(dpr, dpr);

  const vals = points.map((p) => p.v).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const ths = [thresholdHigh, thresholdLow].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return "";
  let lo = Math.min(...vals, ...ths);
  let hi = Math.max(...vals, ...ths);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1;
  lo -= pad; hi += pad;

  const times = points.map((p) => p.t);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tSpan = tMax - tMin || 1;

  const padL = 52;
  const padR = 14;
  const padT = 20;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const px = (t: number) => padL + ((t - tMin) / tSpan) * plotW;
  const py = (v: number) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  // grid
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#64748b";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const tickVals = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  for (const v of tickVals) {
    const y = Math.round(py(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    ctx.fillText(formatTick(v), padL - 6, y);
  }

  // threshold lines
  const drawTh = (v: number, label: string) => {
    ctx.save();
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    const y = Math.round(py(v)) + 0.5;
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#dc2626";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${label} ${formatTick(v)}`, padL + 4, y - 2);
  };
  if (thresholdHigh !== null) drawTh(thresholdHigh, "Danger");
  if (thresholdLow !== null) drawTh(thresholdLow, "Low");

  // series with gaps
  ctx.strokeStyle = "#0d9488";
  ctx.lineWidth = 1.75;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let penDown = false;
  let prevX: number | null = null;
  const nominal = tSpan / Math.max(1, points.length - 1);
  const gapLimit = nominal * 2.5;
  for (const p of points) {
    if (p.v == null || !Number.isFinite(p.v)) { penDown = false; prevX = null; continue; }
    const x = px(p.t);
    const y = py(p.v);
    if (!penDown || (prevX !== null && x - prevX > gapLimit)) {
      if (penDown) ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
      penDown = true;
    } else {
      ctx.lineTo(x, y);
    }
    prevX = x;
  }
  if (penDown) ctx.stroke();

  // dots
  ctx.fillStyle = "#0d9488";
  for (const p of points) {
    if (p.v == null || !Number.isFinite(p.v)) continue;
    const x = px(p.t);
    const y = py(p.v);
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // x labels (6)
  ctx.fillStyle = "#64748b";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 5; i++) {
    const t = tMin + (tSpan * i) / 5;
    const x = px(t);
    // find nearest point time? use t
    ctx.fillText(fmtX(t), x, padT + plotH + 6);
  }

  // unit label
  ctx.fillStyle = "#94a3b8";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(unit, 4, 2);

  return canvas.toDataURL("image/png");
}
