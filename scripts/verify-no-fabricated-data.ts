// Guards the "real sensor data only" rules at the source level.
//
// These are static assertions over the source tree: they fail if someone
// reintroduces a fabricated default, a null->0 coercion, or a missing-data
// path that renders as a number.
//
// Run: node --experimental-strip-types scripts/verify-no-fabricated-data.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git" || e === ".kilo") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const root = process.cwd();
const files = [
  ...walk(join(root, "src")),
  ...walk(join(root, "supabase", "functions")),
].map((p) => ({ path: relative(root, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));

const src = files.filter((f) => f.path.startsWith("src/"));
const fn = files.filter((f) => f.path.startsWith("supabase/functions"));

console.log(`\nscanning ${src.length} src + ${fn.length} edge-function files\n`);

console.log("== No generated/simulated sensor values anywhere ==");
const genPatterns: [string, RegExp][] = [
  ["Math.random", /Math\s*\.\s*random/],
  ["sin() data generator", /Math\s*\.\s*sin\s*\(/],
  ["mock/fake/dummy readings", /\b(mock|fake|dummy|fixture|synthetic)s?\s*[:=(]/i],
];
for (const [label, re] of genPatterns) {
  const hits = files.filter((f) => re.test(f.text)).map((f) => f.path);
  assert(`no ${label}`, hits.length === 0, hits.join(", "));
}

console.log("\n== Fabricated sample datasets removed ==");
const dataTs = readFileSync(join(root, "src", "data", "Data.ts"), "utf8");
assert("INITIAL_ROOMS export is gone", !/export const INITIAL_ROOMS/.test(dataTs));
assert("devices fixture export is gone", !/export const devices/.test(dataTs));
// Strip line comments so the note that explains what was deleted does not
// itself look like a live literal.
const dataCode = dataTs.replace(/\/\/[^\n]*/g, "");
assert("no hardcoded ppm/C/% reading literals left",
  !/\b(co2|temp|humidity)\s*:\s*\d+(\.\d+)?\s*,/.test(dataCode));
assert("Data.ts documents why", /deliberately contains NO sample or demo sensor data/i.test(dataTs));

console.log("\n== No co2/lpg seeded from the rooms table ==");
const roomsCtx = readFileSync(join(root, "src", "context", "RoomsContext.tsx"), "utf8");
// rowToRoom must not copy the rooms-table co2/lpg columns into the live values.
const rowToRoom = roomsCtx.slice(
  roomsCtx.indexOf("function rowToRoom"),
  roomsCtx.indexOf("function roomToInsertRow")
);
assert("rowToRoom does not read row.co2", !/\bco2:\s*row\.co2\b/.test(rowToRoom));
assert("rowToRoom does not read row.lpg", !/\blpg:\s*row\.lpg\b/.test(rowToRoom));
const insertRow = roomsCtx.slice(
  roomsCtx.indexOf("function roomToInsertRow"),
  roomsCtx.indexOf("/** Shape of a row in the Supabase")
);
assert("roomToInsertRow does not write form co2", !/co2:\s*form\.co2/.test(insertRow));
assert("roomToInsertRow does not write form lpg", !/lpg:\s*form\.lpg/.test(insertRow));
assert("live values start null", /co2:\s*null,/.test(rowToRoom) && /temp:\s*null,/.test(rowToRoom));

console.log("\n== No null->zero fallback on a reading ==");
const forbidden: [string, RegExp][] = [
  ["reading coalesced to previous value", /(co2|temp|humidity):\s*(data|row)\.\w+\s*\?\?\s*r\./],
  ["reading coalesced to 0", /(co2|temp|humidity|lpg):\s*(data|row)\.\w+\s*\?\?\s*0/],
  ["lpg ?? 0 in a severity calc", /lpg\s*=\s*\w+\.lpg\s*\?\?\s*0/],
  ["co2 ?? 0 in a severity calc", /co2\s*\??\s*0\b/],
];
for (const [label, re] of forbidden) {
  const hits = files.filter((f) => re.test(f.text)).map((f) => f.path);
  assert(`no ${label}`, hits.length === 0, hits.join(", "));
}

console.log("\n== Threshold boundaries agree across UI, SQL and PDF ==");
for (const f of [...src, ...fn]) {
  const t = f.text;
  if (/severity\s*=.*?\btemp\b[\s\S]{0,80}?>/.test(t) && />\s*t\.(danger|high|warning)/.test(t)) {
    assert(`${f.path} uses >= not >`, !/>\s*t\.(danger|high|warning)/.test(t));
  }
}
const dash = readFileSync(join(root, "src", "pages", "DashboardPage.tsx"), "utf8");
assert("DashboardPage gas tier uses >=", /value\s*>=\s*t\.danger/.test(dash));
assert("DashboardPage no longer does lpg ?? 0", !/const lpg = room\.lpg \?\? 0/.test(dash));

console.log("\n== Missing data renders as an explicit label, not a number ==");
assert("NO_DATA_LABEL is defined exactly once",
  (dataTs.match(/export const NO_DATA_LABEL/g) ?? []).length === 1);
assert("dashboard uses it", dash.includes("NO_DATA_LABEL"));
assert("devices page uses it", readFileSync(join(root, "src", "pages", "DevicesPage.tsx"), "utf8").includes("NO_DATA_LABEL"));
// The durable guard is the TYPE, not a regex: with `temp: number | null`,
// TypeScript itself rejects an unguarded `.toFixed()` at build time. Asserting
// the nullability is therefore a stronger check than scanning call sites.
assert("Room.temp is nullable (compiler-enforced)", /temp:\s*number\s*\|\s*null/.test(dataTs));
assert("Room.humidity is nullable (compiler-enforced)", /humidity:\s*number\s*\|\s*null/.test(dataTs));
assert("DashboardPage's own Room mirrors the nullability",
  /temp:\s*number\s*\|\s*null/.test(dash) && /humidity:\s*number\s*\|\s*null/.test(dash));
// And the display sites must use the label.
assert("dashboard guards temp before toFixed",
  /selected\.temp\s*!==\s*null\s*&&\s*selected\.temp\s*!==\s*undefined/.test(dash));
assert("dashboard guards humidity", /selected\.humidity\s*!==\s*null/.test(dash));

console.log("\n== Reports state their provenance ==");
const prov = readFileSync(join(root, "src", "components", "ReportProvenance.tsx"), "utf8");
for (const fact of ["Source device", "Covered dates", "Timezone", "Valid readings used", "Units"]) {
  assert(`provenance states "${fact}"`, prov.includes(fact));
}
for (const panel of ["DailyReportPanel", "MonthlyReportsPanel", "AnnualReportsPanel"]) {
  const t = readFileSync(join(root, "src", "components", `${panel}.tsx`), "utf8");
  assert(`${panel} renders provenance`, t.includes("<ReportProvenance"));
}
for (const f of ["daily-report/index.ts", "run-monthly-archive/index.ts", "annual-report/index.ts"]) {
  const t = readFileSync(join(root, "supabase", "functions", f), "utf8");
  assert(`${f} names the source device`, /Device:|device_name|Source data|room_name/.test(t));
  assert(`${f} states Asia/Manila`, /Asia\/Manila/.test(t));
  assert(`${f} reports measurement counts`, /Measurements|measurement/i.test(t));
}

console.log("\n== Raw CSV export preserves the original measurements ==");
const shared = readFileSync(join(root, "supabase", "functions", "_shared", "reporting.ts"), "utf8");
assert("CSV has a preamble describing provenance", /CSV_PREAMBLE/.test(shared));
assert("preamble states values are verbatim", /copied verbatim/.test(shared));
assert("preamble states empty means not zero", /does NOT mean zero/i.test(shared));
assert("CSV records which thresholds were applied", /thresholds_applied/.test(shared));
const csvRow = shared.slice(shared.indexOf("export function csvRow"));
assert("csvRow does not round measurement columns", !/Math\.round/.test(csvRow.slice(0, csvRow.indexOf("\n}\n"))));
assert("csvRow writes empty for null", /r\.co2 \?\? ""/.test(csvRow));

console.log("\n== Aggregates never coerce a missing average to zero ==");
const daily = readFileSync(join(root, "src", "components", "DailyReportPanel.tsx"), "utf8");
// Strip line comments so an explanatory mention of the old pattern does not
// count as a live use of it.
const dailyCode = daily.replace(/\/\/[^\n]*/g, "");
assert("no `avg ?? 0` weighting", !/Number\(avg\s*\?\?\s*0\)/.test(dailyCode));
assert("null average is skipped", /avg\s*!==\s*null/.test(dailyCode));
assert("coverage is weighted, not a plain mean", /coverageWeight/.test(dailyCode));
assert("threshold divergence is surfaced", /thresholdsDiffer/.test(daily));

console.log("\n== Durable aggregates, not raw rows, drive yearly reporting ==");
const annualSql = readFileSync(join(root, "supabase", "migrations", "20260913000000_annual_reporting.sql"), "utf8");
const bundleStart = annualSql.indexOf("create or replace function public.annual_report_bundle");
const bundleBody = annualSql.slice(bundleStart, annualSql.indexOf("create or replace function public.metric_obj", bundleStart));
assert("annual bundle reads daily_summaries", /from public\.daily_summaries/.test(bundleBody));
assert("annual bundle does NOT read readings", !/from public\.readings/.test(bundleBody));
assert("annual bundle names contributing devices", /'devices'/.test(bundleBody));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);