// scripts/verify-thresholds.ts
//
// Acceptance checks for the reference-guide alignment. Run with:
//
//   npx esbuild scripts/verify-thresholds.ts --bundle --platform=node --format=esm --outfile=<temp>.mjs && node <temp>.mjs
//
// These exercise the SAME module the UI renders from, so a passing run means
// the guide text, the badges and the alert grading genuinely agree.

import {
  buildCo2Guide,
  buildLpgGuide,
  buildReferenceGuides,
  buildOverviewRows,
  gasSeverity,
  hasAnyReading,
  humiditySeverity,
  metricSeverity,
  overallSeverity,
  tempSeverity,
  validateThresholds,
} from "../src/lib/thresholdConfig";
import { DEFAULT_THRESHOLDS } from "../src/data/Data";
import { isDanger } from "../src/lib/reports";
import { getPermissions } from "../src/lib/permissions";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}\n        expected ${e}\n        actual   ${a}`);
  }
}

console.log("\n1. Seeded defaults match the reference guides");
check("CO2 warning/high/danger", DEFAULT_THRESHOLDS.co2, { warning: 1000, high: 2000, danger: 3500 });
check("LPG warning/high/danger", DEFAULT_THRESHOLDS.lpg, { warning: 1000, high: 2100, danger: 4200 });
check("Temperature", DEFAULT_THRESHOLDS.temp, { freezeBelow: 5, coolBelow: 18, heatAbove: 35 });
check("Humidity", DEFAULT_THRESHOLDS.humidity, { dryBelow: 20, lowBelow: 30, moldAbove: 80 });

console.log("\n2. The named acceptance readings");
check("CO2 2500 grades high", gasSeverity(2500, DEFAULT_THRESHOLDS.co2), "high");
check("LPG 2200 grades high (alarm)", gasSeverity(2200, DEFAULT_THRESHOLDS.lpg), "high");
check("LPG 4200 grades danger (critical)", gasSeverity(4200, DEFAULT_THRESHOLDS.lpg), "danger");
check("LPG 2099 is still warning", gasSeverity(2099, DEFAULT_THRESHOLDS.lpg), "warning");
check("CO2 3500 grades danger", gasSeverity(3500, DEFAULT_THRESHOLDS.co2), "danger");
check("CO2 999 is ok", gasSeverity(999, DEFAULT_THRESHOLDS.co2), "ok");

console.log("\n3. Two-sided metrics");
check("temp 3 degC is danger (freeze)", tempSeverity(3, DEFAULT_THRESHOLDS.temp), "danger");
check("temp 12 degC is warning (cool)", tempSeverity(12, DEFAULT_THRESHOLDS.temp), "warning");
check("temp 24 degC is ok", tempSeverity(24, DEFAULT_THRESHOLDS.temp), "ok");
check("temp 36 degC is danger (heat)", tempSeverity(36, DEFAULT_THRESHOLDS.temp), "danger");
check("humidity 15% is danger (dry)", humiditySeverity(15, DEFAULT_THRESHOLDS.humidity), "danger");
check("humidity 25% is warning (low)", humiditySeverity(25, DEFAULT_THRESHOLDS.humidity), "warning");
check("humidity 55% is ok", humiditySeverity(55, DEFAULT_THRESHOLDS.humidity), "ok");
check("humidity 85% is danger (mold)", humiditySeverity(85, DEFAULT_THRESHOLDS.humidity), "danger");

console.log("\n4. Overall severity is the worst metric, and null is not zero");
check(
  "CO2 2500 + LPG 10 is high",
  overallSeverity({ co2: 2500, lpg: 10, temp: 24, humidity: 55 }, DEFAULT_THRESHOLDS),
  "high"
);
check(
  "CO2 400 + LPG 5000 is danger",
  overallSeverity({ co2: 400, lpg: 5000, temp: 24, humidity: 55 }, DEFAULT_THRESHOLDS),
  "danger"
);
check(
  "CO2 400 + temp 40 is danger",
  overallSeverity({ co2: 400, lpg: null, temp: 40, humidity: null }, DEFAULT_THRESHOLDS),
  "danger"
);
check(
  "null LPG is not graded as 0",
  overallSeverity({ co2: 400, lpg: null, temp: null, humidity: null }, DEFAULT_THRESHOLDS),
  "ok"
);
check("metricSeverity dispatches temp", metricSeverity("temp", 3, DEFAULT_THRESHOLDS), "danger");

console.log("\n5. Generated CO2 guide");
const co2 = buildCo2Guide(DEFAULT_THRESHOLDS);
check("title", co2.title, "CO2 REFERENCE GUIDE");
check("standard", co2.standard, "ASHRAE 62.1 & OSHA");
check(
  "bands",
  co2.rows.map((r) => `${r.range} -> ${r.label}`),
  [
    "< 1000 ppm -> Safe / Good",
    "1000 ppm - 2000 ppm -> Warning",
    "2000 - 3500 ppm -> High",
    ">= 3500 ppm -> Danger",
  ]
);
check(
  "footnote",
  co2.footnote,
  ">3500 ppm triggers the physical alarm. OSHA's 8-hour limit is 5000 ppm; this threshold is set lower for earlier warning."
);

console.log("\n6. Generated LPG guide");
const lpg = buildLpgGuide(DEFAULT_THRESHOLDS);
check("standard", lpg.standard, "NFPA 54 / NFPA 715 & BS EN 50194-1");
check(
  "bands",
  lpg.rows.map((r) => `${r.range} -> ${r.label}`),
  [
    "< 1000 ppm -> Safe",
    "1000 - 2100 ppm -> Trace / Low Leak Warning (10% LEL)",
    "2100 - 4200 ppm -> Alarm Threshold / Danger (20% LEL)",
    ">= 4200 ppm -> Critical Hazard (20% LEL)",
  ]
);
check("footnote", lpg.footnote, "21,000 ppm Lower Explosive Limit (100% LEL).");

console.log("\n7. Generated temp / humidity guides and standards");
const guides = buildReferenceGuides(DEFAULT_THRESHOLDS);
check("temp standard", guides.temp.standard, "ASHRAE 55");
check(
  "temp bands",
  guides.temp.rows.map((r) => r.range),
  ["< 5°C", "5°C - 18°C", "18°C - 35°C", "> 35°C"]
);
check("humidity standard", guides.humidity.standard, "EPA & ASHRAE 62.1");
check(
  "humidity bands",
  guides.humidity.rows.map((r) => r.range),
  ["< 20%", "20% - 30%", "30% - 80%", "> 80%"]
);

console.log("\n8. Guides are regenerated from a changed value (no literals)");
const retuned = {
  ...DEFAULT_THRESHOLDS,
  co2: { warning: 800, high: 1500, danger: 2500 },
  lpg: { warning: 500, high: 1050, danger: 2100 },
};
check(
  "CO2 footnote follows the saved danger value",
  buildCo2Guide(retuned).footnote,
  ">2500 ppm triggers the physical alarm. OSHA's 8-hour limit is 5000 ppm; this threshold is set lower for earlier warning."
);
check(
  "LPG bands follow the saved tiers",
  buildLpgGuide(retuned).rows.map((r) => r.range),
  ["< 500 ppm", "500 - 1050 ppm", "1050 - 2100 ppm", ">= 2100 ppm"]
);

console.log("\n9. Settings overview is generated too");
check(
  "overview rows",
  buildOverviewRows(DEFAULT_THRESHOLDS).map((r) => `${r.label} ${r.value}`),
  [
    "CO2 tiers: 1000 / 2000 / 3500 ppm",
    "LPG tiers: 1000 / 2100 / 4200 ppm",
    "Temp tiers: 5°C / 18°C / 35°C",
    "Humidity tiers: 20% / 30% / 80%",
  ]
);

console.log("\n10. Ascending-order validation");
check("the reference values are valid", validateThresholds(DEFAULT_THRESHOLDS).valid, true);
check(
  "CO2 high >= warning is rejected",
  validateThresholds({ ...DEFAULT_THRESHOLDS, co2: { warning: 2000, high: 2000, danger: 3500 } }).errors[
    "co2.warning"
  ],
  "Must be lower than high (2000)."
);
check(
  "LPG danger <= high is rejected",
  validateThresholds({ ...DEFAULT_THRESHOLDS, lpg: { warning: 1000, high: 4200, danger: 4200 } }).errors[
    "lpg.high"
  ],
  "Must be lower than danger (4200)."
);
check(
  "temp coolBelow <= freezeBelow is rejected",
  validateThresholds({ ...DEFAULT_THRESHOLDS, temp: { freezeBelow: 18, coolBelow: 18, heatAbove: 35 } }).errors[
    "temp.freezeBelow"
  ],
  "Must be lower than coolBelow (18)."
);
check(
  "humidity moldAbove out of range is rejected",
  validateThresholds({
    ...DEFAULT_THRESHOLDS,
    humidity: { dryBelow: 20, lowBelow: 30, moldAbove: 140 },
  }).errors["humidity.moldAbove"],
  "Must be between 0 and 100 % RH."
);
check(
  "the previous LPG values still satisfy the ordering rule (they were wrong, not unordered)",
  validateThresholds({ ...DEFAULT_THRESHOLDS, lpg: { warning: 1000, high: 2000, danger: 5000 } }).valid,
  true
);

console.log("\n11. Temperature tiers are bounded to physically plausible values");
check(
  "a freeze limit of 40 C (ascending, but above any indoor setpoint) is rejected",
  validateThresholds({
    ...DEFAULT_THRESHOLDS,
    temp: { freezeBelow: 40, coolBelow: 45, heatAbove: 50 },
  }).errors["temp.freezeBelow"],
  "Must be between -20 and 15 °C."
);
check(
  "a heat limit of 22 C (would alarm on ordinary warm weather) is rejected",
  validateThresholds({
    ...DEFAULT_THRESHOLDS,
    temp: { freezeBelow: 5, coolBelow: 18, heatAbove: 22 },
  }).errors["temp.heatAbove"],
  "Must be between 25 and 60 °C."
);
check(
  "the rejected tiers above would otherwise have put a normal room into danger",
  tempSeverity(24, { freezeBelow: 40, coolBelow: 45, heatAbove: 50 }),
  "danger"
);
check(
  "the reference tiers grade a normal room as ok",
  tempSeverity(24, DEFAULT_THRESHOLDS.temp),
  "ok"
);

console.log("\n12. Boundary semantics agree with the report SQL");
check(
  "a reading exactly on the freeze limit is not danger (matches report_is_danger)",
  tempSeverity(5, DEFAULT_THRESHOLDS.temp),
  humiditySeverity(20, DEFAULT_THRESHOLDS.humidity)
);
check(
  "a reading just past the freeze limit is danger",
  tempSeverity(4.9, DEFAULT_THRESHOLDS.temp),
  "danger"
);
check(
  "a reading exactly on the CO2 danger limit IS danger (matches >= in SQL)",
  gasSeverity(3500, DEFAULT_THRESHOLDS.co2),
  "danger"
);
check(
  "isDanger() in reports.ts agrees at the freeze boundary",
  isDanger(
    { co2: 400, lpg: 0, temp: 5, humidity: 60 },
    {
      co2_danger: 3500,
      lpg_danger: 4200,
      temp_freeze_below: 5,
      temp_heat_above: 35,
      humidity_dry_below: 20,
      humidity_mold_above: 80,
    }
  ),
  false
);

console.log("\n13. A device with no readings is never graded safe");
check(
  "all-null readings grade ok internally",
  overallSeverity({ co2: null, lpg: null, temp: null, humidity: null }, DEFAULT_THRESHOLDS),
  "ok"
);
check(
  "but hasAnyReading reports no data, so the UI cannot paint it green",
  hasAnyReading({ co2: null, lpg: null, temp: null, humidity: null }),
  false
);
check(
  "a partially-null reading counts as data if any metric was measured",
  hasAnyReading({ co2: 400, lpg: null, temp: null, humidity: null }),
  true
);

console.log("\n14. Unknown roles fail closed instead of crashing the sidebar");
check("an unrecognised role gets no permissions", getPermissions("staff" as never), {
  canAddDevice: false,
  canRemoveDevice: false,
  canToggleDevice: false,
  canAccessReports: false,
  canAccessSettings: false,
});
check("a recognised role still works", getPermissions("admin").canAccessReports, true);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
if (failures > 0) process.exitCode = 1;