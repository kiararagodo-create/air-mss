import { useMemo } from "react";
import {
  METRIC_LABEL,
  METRIC_UNIT,
  MetricKey,
  ReportThresholds,
  dangerHigh,
  dangerLow,
  fmtNumber,
  metricDigits,
  warnLine,
} from "../lib/reports";

export interface ChartPoint {
  t: number;
  /** null = no reading in this bucket. Rendered as a gap, never as zero. */
  v: number | null;
}

interface ReportChartProps {
  title: string;
  metric: MetricKey;
  thresholds: ReportThresholds | null;
  points: ChartPoint[];
  /** Always shown under the title so nobody mistakes aggregates for raw rows. */
  dataLabel: string;
  height?: number;
  /** Formats the X axis. Receives epoch ms. */
  formatX: (t: number) => string;
}

const W = 720;
const PAD_L = 74;
const PAD_R = 18;
const PAD_T = 16;
const PAD_B = 46;

const TEAL = "#0d9488";
const AMBER = "#d97706";
const RED = "#dc2626";
const GRID = "#e9edf1";
const FAINT = "#94a3b8";
const INK = "#0f172a";

export default function ReportChart({
  title,
  metric,
  thresholds,
  points,
  dataLabel,
  height = 240,
  formatX,
}: ReportChartProps) {
  const H = height;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const model = useMemo(() => {
    const values = points
      .map((p) => p.v)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    if (values.length === 0) {
      return { kind: "empty" as const };
    }

    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);

    const hi = thresholds ? dangerHigh(thresholds, metric) : null;
    const lo = thresholds ? dangerLow(thresholds, metric) : null;
    const warn = thresholds ? warnLine(thresholds, metric) : null;

    let yMin = Math.min(dataMin, lo ?? Infinity, warn ?? Infinity);
    let yMax = Math.max(dataMax, hi ?? 0, warn ?? 0);
    const pad = (yMax - yMin) * 0.1 || Math.max(1, Math.abs(yMax) * 0.1);
    yMin -= pad;
    yMax += pad;
    if (metric !== "temp") yMin = Math.max(0, yMin);

    const times = points.map((p) => p.t);
    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    const tSpan = tMax - tMin || 1;

    const px = (t: number) => PAD_L + ((t - tMin) / tSpan) * innerW;
    const py = (v: number) => PAD_T + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

    // A gap is drawn when consecutive buckets are more than ~2.5x the
    // nominal spacing apart, i.e. readings are missing in between.
    const nominal = tSpan / Math.max(1, points.length - 1);
    const gapLimit = nominal * 2.5;

    const segments: string[] = [];
    let current: string[] = [];
    let prevX: number | null = null;

    for (const p of points) {
      if (p.v === null || !Number.isFinite(p.v)) {
        if (current.length > 1) segments.push(current.join(" "));
        current = [];
        prevX = null;
        continue;
      }
      const x = px(p.t);
      const y = py(p.v);
      if (prevX === null || x - prevX > gapLimit) {
        if (current.length > 1) segments.push(current.join(" "));
        current = [];
      }
      current.push(`${current.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
      prevX = x;
    }
    if (current.length > 1) segments.push(current.join(" "));

    const yTicks = Array.from({ length: 5 }, (_, i) => {
      const v = yMin + ((yMax - yMin) * i) / 4;
      return { v, y: py(v) };
    });

    const xTicks = Array.from({ length: 6 }, (_, i) => {
      const t = tMin + (tSpan * i) / 5;
      return { t, x: px(t) };
    });

    const peakIndex = points.findIndex((p) => p.v === dataMax);

    return {
      kind: "ok" as const,
      segments,
      yTicks,
      xTicks,
      peak:
        peakIndex >= 0
          ? { x: px(points[peakIndex].t), y: py(dataMax), v: dataMax }
          : null,
      px,
      py,
      yMin,
      yMax,
      hi,
      lo,
      warn,
    };
  }, [points, thresholds, metric, innerW, innerH]);

  const unit = METRIC_UNIT[metric];

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 800, fontSize: 14, color: INK }}>{title}</span>
        <span
          style={{
            fontSize: 10.5,
            color: FAINT,
            fontWeight: 700,
            background: "#f1f5f9",
            border: "1px solid #e2e8f0",
            padding: "2px 7px",
            borderRadius: 4,
          }}
        >
          {dataLabel}
        </span>
      </div>

      {model.kind === "empty" ? (
        // "No data" is stated plainly and is visually distinct from a flat
        // line at zero, which would imply a measured value of zero.
        <div
          style={{
            marginTop: 8,
            height: 110,
            border: "1px dashed #cbd5e1",
            borderRadius: 10,
            background: "#fafbfc",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#64748b" }}>No data</span>
          <span style={{ fontSize: 11.5, color: FAINT, textAlign: "center", maxWidth: 380 }}>
            No {METRIC_LABEL[metric].toLowerCase()} measurements were recorded for this period. This is
            an absence of data, not a measurement of zero.
          </span>
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: "100%", height: "auto", display: "block", marginTop: 8 }}
          role="img"
          aria-label={`${title} graph`}
        >
          <rect x={0} y={0} width={W} height={H} fill="#fcfdfe" stroke={GRID} rx={8} />

          {/* Y grid + labels */}
          {model.yTicks.map((t, i) => (
            <g key={`y${i}`}>
              <line
                x1={PAD_L}
                y1={t.y}
                x2={PAD_L + innerW}
                y2={t.y}
                stroke={GRID}
                strokeWidth={1}
              />
              <text x={PAD_L - 6} y={t.y + 3.5} fontSize={10} fill={FAINT} textAnchor="end">
                {fmtNumber(t.v, metric === "temp" ? 1 : 0)}
              </text>
            </g>
          ))}
          <text x={4} y={PAD_T - 4} fontSize={9.5} fill={FAINT}>
            {METRIC_LABEL[metric]} ({unit})
          </text>

          {/* Threshold lines - only when a threshold record exists */}
          {model.warn !== null && (
            <line
              x1={PAD_L}
              y1={model.py(model.warn)}
              x2={PAD_L + innerW}
              y2={model.py(model.warn)}
              stroke={AMBER}
              strokeWidth={1.4}
              strokeDasharray="4,3"
            />
          )}
          {model.hi !== null && (
            <>
              <line
                x1={PAD_L}
                y1={model.py(model.hi)}
                x2={PAD_L + innerW}
                y2={model.py(model.hi)}
                stroke={RED}
                strokeWidth={1.6}
                strokeDasharray="6,3"
              />
              <text
                x={PAD_L + innerW - 118}
                y={model.py(model.hi) - 4}
                fontSize={9.5}
                fill={RED}
                fontWeight={700}
              >
                Danger {fmtNumber(model.hi, metricDigits(metric))}
              </text>
            </>
          )}
          {model.lo !== null && (
            <>
              <line
                x1={PAD_L}
                y1={model.py(model.lo)}
                x2={PAD_L + innerW}
                y2={model.py(model.lo)}
                stroke={RED}
                strokeWidth={1.6}
                strokeDasharray="6,3"
              />
              <text
                x={PAD_L + innerW - 118}
                y={model.py(model.lo) + 11}
                fontSize={9.5}
                fill={RED}
                fontWeight={700}
              >
                Low danger {fmtNumber(model.lo, metricDigits(metric))}
              </text>
            </>
          )}

          {/* Series, broken wherever readings are missing */}
          {model.segments.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={TEAL}
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* Peak marker */}
          {model.peak && (
            <>
              <circle cx={model.peak.x} cy={model.peak.y} r={3.4} fill={RED} />
              <text
                x={Math.min(model.peak.x + 6, W - PAD_R - 96)}
                y={Math.max(model.peak.y - 6, PAD_T + 10)}
                fontSize={10}
                fill={RED}
                fontWeight={700}
              >
                Peak {fmtNumber(model.peak.v, metric === "temp" ? 1 : 0)}
              </text>
            </>
          )}

          {/* X axis */}
          {model.xTicks.map((t, i) => (
            <text
              key={`x${i}`}
              x={Math.min(t.x, W - PAD_R - 52)}
              y={H - PAD_B + 16}
              fontSize={10}
              fill={FAINT}
              textAnchor="start"
            >
              {formatX(t.t)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}