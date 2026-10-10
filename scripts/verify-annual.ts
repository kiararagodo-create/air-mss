// Smoke test for the yearly report: analysis wording + annual PDF rendering.
// Run: deno run --allow-env --allow-net scripts/verify-annual.ts
import {
  COLORS,
  PdfBuilder,
  buildAnnualAnalysis,
} from "./_annual_probe.ts";

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
function has(name: string, hay: string, needle: string) {
  const ok = hay.includes(needle);
  assert(name, ok, ok ? "" : `\n          missing: "${needle}"`);
}

const th = {
  threshold_source: "historical" as const,
  effective_from: "2026-01-01T00:00:00Z",
  co2_warning: 1000, co2_high: 3500, co2_danger: 3500,
  lpg_warning: 1000, lpg_high: 2000, lpg_danger: 5000,
  temp_freeze_below: 5, temp_cool_below: 18, temp_heat_above: 35,
  humidity_dry_below: 20, humidity_low_below: 30, humidity_mold_above: 80,
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const metric = (count: number, min: number|null, max: number|null, avg: number|null) =>
  ({ unit: "", count, min, max, avg });

function makeMonths(opts: {
  danger?: Record<number, number>;
  readings?: Record<number, number>;
  zero?: number[];
  coverage?: Record<number, number>;
  elapsedThrough?: number;
}) {
  const zero = new Set(opts.zero ?? []);
  const elapsedThrough = opts.elapsedThrough ?? 12;
  return MONTHS.map((label, i) => {
    const n = i + 1;
    const isElapsed = n <= elapsedThrough;
    const readings = isElapsed ? (zero.has(n) ? 0 : (opts.readings?.[n] ?? 800000)) : 0;
    const danger = isElapsed ? (opts.danger?.[n] ?? 0) : 0;
    return {
      month_number: n,
      month_start: `2026-${String(n).padStart(2, "0")}-01`,
      month_end: `2026-${String(n).padStart(2, "0")}-28`,
      label,
      is_elapsed: isElapsed,
      reading_count: readings,
      danger_readings: danger,
      devices_reporting: readings > 0 ? 3 : 0,
      days_with_data: readings > 0 ? 28 : 0,
      days_in_month: 28,
      coverage_pct: opts.coverage?.[n] ?? (readings > 0 ? 99.5 : 0),
      first_reading_at: readings > 0 ? `2026-${String(n).padStart(2, "0")}-01T00:00:00Z` : null,
      last_reading_at: readings > 0 ? `2026-${String(n).padStart(2, "0")}-28T00:00:00Z` : null,
      metrics: {
        co2: metric(readings > 0 ? readings : 0, readings > 0 ? 390 : null, readings > 0 ? 4100 : null, readings > 0 ? 820 : null),
        lpg: metric(0, null, null, null),
        temp: metric(readings > 0 ? readings : 0, readings > 0 ? 21 : null, readings > 0 ? 33 : null, readings > 0 ? 27.4 : null),
        humidity: metric(readings > 0 ? readings : 0, readings > 0 ? 38 : null, readings > 0 ? 79 : null, readings > 0 ? 58 : null),
      },
    };
  });
}

const baseMetrics = {
  co2: metric(8600000, 390, 4100, 820),
  lpg: metric(0, null, null, null),
  temp: metric(8600000, 21, 33, 27.4),
  humidity: metric(8600000, 38, 79, 58),
};

console.log("\n== Full year, all months with data ==");
{
  const a = buildAnnualAnalysis({
    year: 2026, isYearToDate: false,
    coverageStart: "2026-01-01T00:00:00Z", coverageEnd: "2026-12-28T16:00:00Z",
    coverageLastDay: "2026-12-31", today: "2027-01-05",
    readingCount: 8600000, dangerReadingCount: 420,
    months: makeMonths({ danger: { 3: 100, 7: 320 } }),
    monthsWithData: 12, metrics: baseMetrics,
    thresholds: th, thresholdChanges: [],
  });
  const t = a.paragraphs.join("\n");
  has("says full calendar year", t, "It is labelled a full calendar year");
  assert("does NOT say year to date", !t.includes("Year to date"));
  has("danger stated as rows", t, "not a count of separate incidents and not a duration");
  has("attention months listed", t, "March (100); July (320)");
  assert("no prediction language", !/will likely be|is expected to|forecast|going to/i.test(t));
  // Causal attribution about the READINGS is forbidden. A bare "because" is
  // allowed where it merely explains the document's own labelling, e.g.
  // "labelled a full calendar year because 2026 had fully elapsed".
  assert("no invented cause for readings",
    !/(caused by|due to|ventilation|occupancy|occupants|people were present)/i.test(t));
  has("peak volume hedged", t, "A higher reading count reflects more data recorded, not necessarily worse conditions");
  has("month comparison hedged", t, "may reflect how long a device was reporting rather than any change in conditions");
  has("LPG with no data not shown as zero", t, "LPG: no ppm measurements were recorded");
  assert("attentionMonths is 2", a.attentionMonths.length === 2);
}

console.log("\n== Current year is labelled Year to date with coverage dates ==");
{
  const a = buildAnnualAnalysis({
    year: 2026, isYearToDate: true,
    coverageStart: "2026-01-01T00:00:00Z", coverageEnd: "2026-09-30T16:00:00Z",
    coverageLastDay: "2026-09-30", today: "2026-10-05",
    readingCount: 6500000, dangerReadingCount: 90,
    months: makeMonths({ danger: { 5: 90 }, elapsedThrough: 9 }),
    monthsWithData: 9, metrics: baseMetrics,
    thresholds: th, thresholdChanges: [],
  });
  const t = a.paragraphs.join("\n");
  has("labels Year to date", t, 'It is labelled "Year to date"');
  has("states months after the cut-off are excluded", t, "had not occurred when this report was generated and are not included");
  has("reports 9 of 12 months", t, "9 months of 12 (9 months had elapsed)");
  assert("does not claim a full year", !t.includes("It is labelled a full calendar year"));
}

console.log("\n== Upcoming months are not treated as no-data ==");
{
  const a = buildAnnualAnalysis({
    year: 2026, isYearToDate: true,
    coverageStart: "2026-01-01T00:00:00Z", coverageEnd: "2026-06-28T16:00:00Z",
    coverageLastDay: "2026-06-30", today: "2026-07-02",
    readingCount: 10, dangerReadingCount: 0,
    months: makeMonths({ elapsedThrough: 6 }),
    monthsWithData: 6, metrics: baseMetrics,
    thresholds: th, thresholdChanges: [],
  });
  assert("no upcoming month is listed as having no data", a.zeroMonths.length === 0, `got ${a.zeroMonths.length}`);
  has("states it covers the elapsed part", t0(a), "the part of 2026 elapsed so far");
}
function t0(a: ReturnType<typeof buildAnnualAnalysis>) { return a.paragraphs.join("\n"); }

console.log("\n== Months with genuinely no data are called out ==");
{
  const a = buildAnnualAnalysis({
    year: 2026, isYearToDate: false,
    coverageStart: "2026-01-01T00:00:00Z", coverageEnd: "2026-12-28T16:00:00Z",
    coverageLastDay: "2026-12-31", today: "2027-01-05",
    readingCount: 5000, dangerReadingCount: 0,
    months: makeMonths({ zero: [2, 9], readings: { 1: 2500, 3: 2500 } }),
    monthsWithData: 2, metrics: baseMetrics,
    thresholds: th, thresholdChanges: [],
  });
  const t = t0(a);
  has("names the empty months", t, "February, September");
  has("does not call them safe", t, "they are not counted as safe");
  has("zero-danger is hedged", t, "not a claim that conditions were continuously safe throughout");
  assert("zeroMonths is 2", a.zeroMonths.length === 2);
}

console.log("\n== Mid-year threshold changes are disclosed ==");
{
  const a = buildAnnualAnalysis({
    year: 2026, isYearToDate: false,
    coverageStart: "2026-01-01T00:00:00Z", coverageEnd: "2026-12-28T16:00:00Z",
    coverageLastDay: "2026-12-31", today: "2027-01-05",
    readingCount: 100, dangerReadingCount: 0,
    months: makeMonths({}), monthsWithData: 12, metrics: baseMetrics,
    thresholds: th,
    thresholdChanges: [
      { effective_from: "2026-03-01T00:00:00Z", co2_danger: 3500, lpg_danger: 5000, temp_freeze_below: 5, temp_heat_above: 35, humidity_dry_below: 20, humidity_mold_above: 80 },
      { effective_from: "2026-08-01T00:00:00Z", co2_danger: 3000, lpg_danger: 5000, temp_freeze_below: 5, temp_heat_above: 35, humidity_dry_below: 20, humidity_mold_above: 80 },
    ],
  });
  has("discloses 2 configurations", t0(a), "2 threshold configurations took effect");
  has("warns months are not comparable", t0(a), "months with different configurations are not directly comparable");
}

console.log("\n== Annual PDF renders ==");
{
  const b = await PdfBuilder.create("A.I.R. Sensor Monitoring System", "Year to date 2026");
  b.page.drawText("Annual Environmental Report — Year to Date", {
    x: 40, y: b.y - 20, size: 20, font: b.bold, color: COLORS.ink,
  });
  b.space(30);
  b.heading("Monthly comparison");
  b.table(
    [
      { header: "Month", width: 84 }, { header: "Status", width: 86 },
      { header: "Readings", width: 88, align: "right" }, { header: "Coverage", width: 72, align: "right" },
      { header: "Danger", width: 72, align: "right" },
    ],
    makeMonths({ danger: { 3: 100 }, zero: [9], elapsedThrough: 9 }).map((m) => {
      if (!m.is_elapsed) return [m.label, "Upcoming", "-", "-", "-"];
      if (m.reading_count === 0) return [m.label, "No data", "No data", "-", "No data"];
      return [m.label, m.danger_readings > 0 ? "Attention" : "No danger readings",
        m.reading_count.toLocaleString(), `${Number(m.coverage_pct).toFixed(1)}%`, String(m.danger_readings)];
    }),
    { headerRepeatLabel: "Monthly comparison" }
  );
  b.heading("Recorded readings by month");
  b.monthBars(
    makeMonths({ zero: [9], elapsedThrough: 9 }).map((m) => ({ label: m.label, value: m.reading_count, hasData: m.reading_count > 0 })),
    "Reading rows recorded per month", "readings"
  );
  b.heading("Danger-level reading count by month");
  b.monthBars(
    makeMonths({ danger: { 3: 100, 7: 320 }, elapsedThrough: 9 }).map((m) => ({ label: m.label, value: m.danger_readings, hasData: m.reading_count > 0 })),
    "Count of reading rows in the danger band, per month", "readings",
    { emphasize: (m) => Number(m.value) > 0 }
  );
  b.heading("Monthly average trends");
  for (const m of ["co2", "temp"] as const) {
    b.chart(`${m} monthly average`, m, th,
      makeMonths({ zero: [9], elapsedThrough: 9 }).map((mo) => ({
        t: new Date(mo.month_start + "T00:00:00Z").getTime(),
        v: mo.reading_count > 0 && mo.metrics[m].avg != null ? Number(mo.metrics[m].avg) : null,
      })),
      (t) => new Date(t).toLocaleDateString("en-PH", { timeZone: "UTC", month: "short" })
    );
  }

  const bytes = await b.finish();
  console.log(`  bytes: ${bytes.length}, pages: ${b.pageNumber}`);
  assert("valid PDF header", new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-");
  assert("valid EOF", new TextDecoder().decode(bytes.slice(-1024)).includes("%%EOF"));
  assert("multi-page", b.pageNumber >= 2, `${b.pageNumber} pages`);

  // Rather than guess a byte floor, prove the drawing actually happened: build
  // the same document WITHOUT the charts and confirm the output is materially
  // smaller. If the charts were being silently skipped, the sizes would match.
  const bare = await PdfBuilder.create("A.I.R.", "Year to date 2026");
  bare.page.drawText("Annual Environmental Report — Year to Date", {
    x: 40, y: bare.y - 20, size: 20, font: bare.bold, color: COLORS.ink,
  });
  bare.space(30);
  bare.heading("Monthly comparison");
  const bareBytes = await bare.finish();

  console.log(`  bare (no charts): ${bareBytes.length} bytes, ${bare.pageNumber} pages`);
  assert("charts and bars materially add content", bytes.length > bareBytes.length * 1.3,
    `annual=${bytes.length} bare=${bareBytes.length}`);
  assert("charts add at least one page", b.pageNumber > bare.pageNumber,
    `annual=${b.pageNumber} bare=${bare.pageNumber}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
Deno.exit(fail ? 1 : 0);