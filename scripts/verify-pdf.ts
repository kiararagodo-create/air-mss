// Smoke test for the PDF scaffolding in _shared/reporting.ts.
// Run: deno run --allow-env --allow-net scripts/verify-pdf.ts
import { COLORS, PdfBuilder, ThresholdNoteStub } from "./_pdf_probe.ts";

const th = {
  threshold_source: "current" as const,
  effective_from: "2026-08-01T00:00:00Z",
  co2_warning: 1000,
  co2_high: 3500,
  co2_danger: 3500,
  lpg_warning: 1000,
  lpg_high: 2000,
  lpg_danger: 5000,
  temp_freeze_below: 5,
  temp_cool_below: 18,
  temp_heat_above: 35,
  humidity_dry_below: 20,
  humidity_low_below: 30,
  humidity_mold_above: 80,
};

// 40 hourly buckets, with a deliberate gap in the middle (nulls preserved).
const series = Array.from({ length: 40 }, (_, i) => ({
  t: Date.UTC(2026, 7, 1, i),
  v: i >= 15 && i <= 20 ? null : 400 + Math.round(600 * Math.abs(Math.sin(i / 3))),
}));

const b = await PdfBuilder.create("A.I.R. Sensor Monitoring System", "Smoke test");

b.page.drawText("Monthly Environmental Report", {
  x: 40,
  y: b.y - 20,
  size: 20,
  font: b.bold,
  color: COLORS.ink,
});
b.space(30);

b.heading("Summary");
b.text("CO2 recorded minimum 401 ppm, maximum 999 ppm, average 700 ppm.", { size: 10 });

b.heading("Analysis");
b.text(
  "Danger-level readings. 12 recorded readings (0.14% of all recorded readings) had at least one " +
    "metric in the danger band. This is a count of reading rows, not a count of separate incidents.",
  { size: 9.3, indent: 6 }
);

b.heading("Sensor trends");
b.chart("CO2 trend", "co2", th, series, (t) => new Date(t).toISOString().slice(5, 10));
b.chart("Temperature trend", "temp", th, series, (t) => new Date(t).toISOString().slice(5, 10));

// An all-null series must render the "no data" state, not a flat zero line.
b.chart("Humidity trend (no data)", "humidity", th, series.map((p) => ({ t: p.t, v: null })), () => "-");

b.dangerBars(
  [
    { day: "2026-08-01", reading_count: 28800, coverage_pct: 100, danger_readings: 0, danger_by_metric: {} } as any,
    { day: "2026-08-02", reading_count: 28800, coverage_pct: 100, danger_readings: 7, danger_by_metric: { co2: 7 } } as any,
    { day: "2026-08-03", reading_count: 0, coverage_pct: 0, danger_readings: 0, danger_by_metric: {} } as any,
  ],
  (d) => d.slice(5)
);

// Table must paginate and repeat its header.
const rows = Array.from({ length: 260 }, (_, i) => [
  `2026-08-01 ${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
  "AIR-106",
  "Room 106 / Ground Floor",
  String(400 + i),
  "120",
  "27.5",
  "55",
  "0",
  i % 17 === 0 ? "DANGER: CO2" : "within thresholds",
]);

b.heading("Appendix - recorded readings");
b.table(
  [
    { header: "Timestamp (Asia/Manila)", width: 168, align: "left" },
    { header: "Device", width: 116, align: "left" },
    { header: "Room / Floor", width: 168, align: "left" },
    { header: "CO2 (ppm)", width: 74, align: "right" },
    { header: "LPG (ppm)", width: 74, align: "right" },
    { header: "Temp (C)", width: 68, align: "right" },
    { header: "Humidity (%)", width: 78, align: "right" },
    { header: "Severity", width: 62, align: "right" },
    { header: "Assessment", width: 84, align: "left" },
  ],
  rows,
  { headerRepeatLabel: "Appendix - recorded readings" }
);

const bytes = await b.finish();

console.log(`bytes: ${bytes.length}`);
console.log(`pages: ${b.pageNumber}`);
console.log(`header: ${new TextDecoder().decode(bytes.slice(0, 8))}`);

let ok = true;
function assert(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!cond) ok = false;
}

assert("produces a PDF", new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-", "header %PDF-");
assert("non-trivial size", bytes.length > 5000, `${bytes.length} bytes`);
assert("table pagination produced multiple pages", b.pageNumber >= 3, `${b.pageNumber} pages`);
assert("ends with EOF marker", new TextDecoder().decode(bytes.slice(-1024)).includes("%%EOF"));

console.log(ok ? "\nPDF SMOKE TEST PASSED\n" : "\nPDF SMOKE TEST FAILED\n");
if (!ok) Deno.exit(1);
void ThresholdNoteStub;