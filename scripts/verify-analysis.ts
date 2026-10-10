// Verification of the report narrative and CSV helpers.
// Run: deno run --allow-env --allow-net scripts/verify-analysis.ts
import {
  buildAnalysis,
  concatBytes,
  csvCell,
  isDangerRow,
  thresholdNote,
} from "./_pdf_probe.ts";

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
function assertContains(name: string, hay: string, needle: string) {
  const ok = hay.includes(needle);
  assert(name, ok, ok ? "" : `\n          missing: "${needle}"`);
  if (ok) console.log(`          -> "${needle.slice(0, 96)}${needle.length > 96 ? "..." : ""}"`);
}

const th = {
  threshold_source: "historical" as const,
  effective_from: "2026-07-01T00:00:00Z",
  co2_warning: 1000, co2_high: 3500, co2_danger: 3500,
  lpg_warning: 1000, lpg_high: 2000, lpg_danger: 5000,
  temp_freeze_below: 5, temp_cool_below: 18, temp_heat_above: 35,
  humidity_dry_below: 20, humidity_low_below: 30, humidity_mold_above: 80,
};
const cur = { ...th, threshold_source: "current" as const };

const stats = (danger: number, readings = 1000) => ({
  reading_count: readings,
  danger_reading_count: danger,
  first_reading_at: "2026-08-01T00:00:00Z",
  last_reading_at: "2026-08-31T16:00:00Z",
  metrics: {
    co2: { unit: "ppm", count: readings, min: 400, max: 3600, avg: 800 },
    lpg: { unit: "ppm", count: 0, min: null, max: null, avg: null },
    temp: { unit: "\u00b0C", count: readings, min: 22, max: 31, avg: 26 },
    humidity: { unit: "%", count: readings, min: 40, max: 70, avg: 55 },
  },
});

const day = (d: string, over: Partial<any> = {}) => ({
  day: d, reading_count: 28800, coverage_pct: 100, expected_count: 28800,
  first_reading_at: null, last_reading_at: null,
  co2_avg: 800, co2_max: 900, lpg_avg: null, lpg_max: null,
  temp_avg: 26, temp_max: 30, humidity_avg: 55, humidity_max: 60,
  danger_readings: 0, danger_by_metric: {}, ...over,
});

console.log("\n== Danger readings are described as ROWS, not incidents ==");
const a1 = buildAnalysis({
  scopeLabel: "August 2026", deviceName: "Room 106", deviceFloor: "Ground",
  stats: stats(12), daily: [day("2026-08-01", { danger_readings: 12, danger_by_metric: { co2: 12 } })],
  thresholds: th, totalDays: 31, daysWithData: 31,
});
const t1 = a1.paragraphs.join("\n");
assertContains("states it is a count of reading rows", t1, "This is a count of reading rows, not a count of separate incidents and not a duration");
assert("does not invent a health cause", !/because|caused by|due to|ventilation|occupan/i.test(t1));
assert("does not predict", !/will likely be|is expected to|forecast|going to|next month|should (?:rise|fall|increase|decrease)/i.test(t1));
assertContains("danger count is a lower bound", t1, "not a measure of how long any condition persisted");

console.log("\n== Zero danger readings != safe conditions ==");
const a2 = buildAnalysis({
  scopeLabel: "August 2026", deviceName: "Room 106", deviceFloor: "Ground",
  stats: stats(0), daily: [day("2026-08-01")], thresholds: th,
  totalDays: 31, daysWithData: 30,
});
const t2 = a2.paragraphs.join("\n");
assertContains("zero-danger wording is hedged", t2, "it is a statement about the readings that exist");
assertContains("missing days are called out", t2, "1 day in this period have no recorded readings at all");
// The low-coverage branch only fires when a day is actually under-covered;
// give it one so the "missing readings are not safe" wording is exercised.
const a2b = buildAnalysis({
  scopeLabel: "August 2026", deviceName: "Room 106", deviceFloor: "Ground",
  stats: stats(0), daily: [day("2026-08-01", { coverage_pct: 62 })], thresholds: th,
  totalDays: 31, daysWithData: 30,
});
assertContains("gaps are not called safe", a2b.paragraphs.join("\\n"), "not counted as safe");

console.log("\n== Zero readings entirely ==");
const a3 = buildAnalysis({
  scopeLabel: "August 2026", deviceName: "Room 106", deviceFloor: "Ground",
  stats: stats(0, 0), daily: [], thresholds: th, totalDays: 31, daysWithData: 0,
});
const t3 = a3.paragraphs.join("\n");
assertContains("says nothing can be concluded", t3, "No recorded reading reached a danger threshold");
assert("no invented extreme", !/maximum 0|average 0/.test(t3));

console.log("\n== Metric with no measurements is not shown as zero ==");
assertContains("LPG reported as no measurements", t3, "LPG: no ppm measurements were recorded");
assert("no fabricated 0 for LPG", !/LPG recorded minimum 0/.test(t3));

console.log("\n== Threshold provenance is always stated ==");
assertContains("historical source", thresholdNote(th), "recorded as in effect at the time");
assertContains("current source warns values may differ", thresholdNote(cur), "may have differed");
assertContains("current source does not claim to be historical", thresholdNote(cur), "No historical threshold record exists");

console.log("\n== Danger evaluation matches the SQL reading_is_danger() ==");
const cases: [string, any, boolean][] = [
  ["CO2 above danger", { co2: 3500, lpg: null, temp: null, humidity: null }, true],
  ["CO2 exactly at danger", { co2: 3500, lpg: null, temp: null, humidity: null }, true],
  ["CO2 below danger", { co2: 3499, lpg: null, temp: null, humidity: null }, false],
  ["temp above heat", { co2: null, lpg: null, temp: 35.1, humidity: null }, true],
  ["temp at heat boundary is NOT danger", { co2: null, lpg: null, temp: 35, humidity: null }, false],
  ["temp below freeze", { co2: null, lpg: null, temp: 4.9, humidity: null }, true],
  ["humidity above mold", { co2: null, lpg: null, temp: null, humidity: 80.1 }, true],
  ["humidity below dry", { co2: null, lpg: null, temp: null, humidity: 19.9 }, true],
  ["all null is not danger", { co2: null, lpg: null, temp: null, humidity: null }, false],
  ["lpg below danger", { co2: null, lpg: 4999, temp: null, humidity: null }, false],
];
for (const [name, row, expected] of cases) {
  assert(name, isDangerRow(row, th) === expected);
}

console.log("\n== CSV escaping ==");
assert("quotes commas", csvCell("a,b") === '"a,b"');
assert("doubles quotes", csvCell('say "hi"') === '"say ""hi"""');
assert("escapes newlines", csvCell("a\nb") === '"a\nb"');
assert("leaves plain text", csvCell("plain") === "plain");
assert("null becomes empty", csvCell(null) === "");
assert("undefined becomes empty", csvCell(undefined) === "");
assert("preserves a minus sign", csvCell("-12.5") === "-12.5");

console.log("\n== Byte concatenation for large CSV ==");
const chunks = ["a", "bb", "ccc", ""].map((s) => new TextEncoder().encode(s));
assert("concatenates in order", new TextDecoder().decode(concatBytes(chunks)) === "abbccc");

console.log(`\n${pass} passed, ${fail} failed\n`);
Deno.exit(fail ? 1 : 0);