// src/lib/thresholdConfig.ts
//
// THE single source of truth for every safety number the dashboard renders.
//
// Nothing in this file is a platform configuration value. Every threshold is
// read from the saved row in public.platform_thresholds and arrives here as a
// `Thresholds` object (see RoomsContext). This module owns three things:
//
//   1. Severity grading - ok / warning / high / danger - computed from RAW
//      readings and the saved thresholds. The ESP32 writes its own `severity`
//      with each reading and the dashboard deliberately ignores it: the
//      firmware's tiers are its own and do not change when an admin edits the
//      dashboard configuration, so trusting it would make the dashboard
//      contradict the reference guides it is displaying.
//
//   2. Reference-guide copy - every range string, label, standards name and
//      footnote is GENERATED from the saved values. There are no literals like
//      "1000-3500" or ">3500" anywhere in the UI, so editing a value on the
//      Settings page and saving rewrites the cards as well as the badges.
//
//   3. Validation - the ascending-order rule the Settings page enforces
//      inline, mirrored by CHECK constraints in the database.

import type { Thresholds } from "../data/Data";
import type { Tone } from "../ui";

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/** The four grades the dashboard displays. `ok` is the only non-alarming one. */
export type SeverityLevel = "ok" | "warning" | "high" | "danger";

export const SEVERITY_RANK: Record<SeverityLevel, number> = {
  ok: 0,
  warning: 1,
  high: 2,
  danger: 3,
};

/** Badge text per grade. Shared so a room badge and a per-metric chip agree. */
export const SEVERITY_LABEL: Record<SeverityLevel, string> = {
  ok: "OK",
  warning: "Monitor",
  high: "High",
  danger: "DANGER",
};

/** Tone per grade. Drives every colour in the app via ui.tsx's TONE_STYLES. */
export const SEVERITY_TONE: Record<SeverityLevel, Tone> = {
  ok: "success",
  warning: "warning",
  high: "high",
  danger: "danger",
};

/** The worse of two grades. */
export function worstSeverity(a: SeverityLevel, b: SeverityLevel): SeverityLevel {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * One-sided ascending scale (CO2, LPG).
 *
 * Boundaries are inclusive (`>=`), so a reading sitting exactly on a limit is
 * graded by that limit rather than the one below it. This matches the SQL in
 * public.report_is_danger() and the PDF generator, so the badge, the chart and
 * the PDF never disagree about a reading that lands precisely on a boundary.
 *
 * A null reading is NOT zero and is NOT safe: it grades as `ok` for the purpose
 * of combining with other metrics, but callers must render an explicit
 * no-data state instead of a passing one (see `hasAnyReading`).
 */
export function gasSeverity(
  value: number | null | undefined,
  tiers: { warning: number; high: number; danger: number }
): SeverityLevel {
  if (value == null || !Number.isFinite(value)) return "ok";
  if (value >= tiers.danger) return "danger";
  if (value >= tiers.high) return "high";
  if (value >= tiers.warning) return "warning";
  return "ok";
}

/**
 * Temperature (DHT22, ASHRAE 55): two-sided, three limits.
 *
 *   below freezeBelow  -> danger (freeze / pipe risk)
 *   below coolBelow    -> warning (cool)
 *   above heatAbove    -> danger (heat stress)
 *   in between         -> ok (comfortable)
 *
 * `coolBelow` is exclusive at the bottom edge: the band runs up to it, and
 * anything colder has already been caught by the freeze rule.
 */
export function tempSeverity(
  value: number | null | undefined,
  tiers: { freezeBelow: number; coolBelow: number; heatAbove: number }
): SeverityLevel {
  if (value == null || !Number.isFinite(value)) return "ok";
  // Strict `<` and `>` at both ends. This is the convention used by
  // public.report_is_danger() and by the daily/monthly reports, so a reading
  // sitting exactly on a limit grades identically on the dashboard and in the
  // PDF. It previously used `<=` here, which made the live badge call a
  // reading of exactly 5.0 °C a danger that the report for the same day did
  // not count.
  if (value < tiers.freezeBelow) return "danger";
  if (value <= tiers.coolBelow) return "warning";
  if (value > tiers.heatAbove) return "danger";
  return "ok";
}

/**
 * Humidity (DHT22, EPA & ASHRAE 62.1): two-sided, three limits.
 *
 *   below dryBelow   -> danger (too dry: irritation, static, wood damage)
 *   below lowBelow   -> warning (low)
 *   above moldAbove  -> danger (mould / condensation risk)
 */
export function humiditySeverity(
  value: number | null | undefined,
  tiers: { dryBelow: number; lowBelow: number; moldAbove: number }
): SeverityLevel {
  if (value == null || !Number.isFinite(value)) return "ok";
  // Strict comparison at the dry end, matching tempSeverity and the SQL -
  // see the note there.
  if (value < tiers.dryBelow) return "danger";
  if (value <= tiers.lowBelow) return "warning";
  if (value > tiers.moldAbove) return "danger";
  return "ok";
}

/** The four raw metrics a reading carries. */
export type MetricKey = "co2" | "lpg" | "temp" | "humidity";

export interface MetricReadings {
  co2: number | null | undefined;
  lpg: number | null | undefined;
  temp: number | null | undefined;
  humidity: number | null | undefined;
}

/** Grade one metric against the saved thresholds. */
export function metricSeverity(metric: MetricKey, value: number | null | undefined, th: Thresholds): SeverityLevel {
  switch (metric) {
    case "co2":
      return gasSeverity(value, th.co2);
    case "lpg":
      return gasSeverity(value, th.lpg);
    case "temp":
      return tempSeverity(value, th.temp);
    case "humidity":
      return humiditySeverity(value, th.humidity);
  }
}

/**
 * Grade a whole reading. The reported severity is the worst of the four
 * metrics, so a perfectly normal CO2 value cannot mask a dangerous LPG one.
 */
export function overallSeverity(readings: MetricReadings, th: Thresholds): SeverityLevel {
  return (["co2", "lpg", "temp", "humidity"] as MetricKey[]).reduce<SeverityLevel>(
    (worst, m) => worstSeverity(worst, metricSeverity(m, readings[m], th)),
    "ok"
  );
}

/**
 * True when at least one metric was actually measured.
 *
 * Every "safe" badge is gated on this. A device that has never reported is not
 * a device that is safe, and rendering it as green is the failure mode this
 * flag exists to prevent.
 */
export function hasAnyReading(readings: MetricReadings): boolean {
  return (["co2", "lpg", "temp", "humidity"] as MetricKey[]).some(
    (m) => readings[m] != null && Number.isFinite(readings[m] as number)
  );
}

// ---------------------------------------------------------------------------
// Standards metadata
// ---------------------------------------------------------------------------
//
// This is the ONLY place numbers appear that are NOT saved configuration, and
// they are facts about the published standards rather than platform settings:
//
//   * OSHA's 8-hour CO2 limit is a property of the regulation. The dashboard
//     does not configure it and no admin can change it; it is quoted in the CO2
//     footnote purely as the reference point that justifies our lower danger
//     tier.
//   * The LPG Lower Explosive Limit is a physical constant of propane.
//   * The device's own tier list (warning / alarm / critical) is firmware
//     behaviour and is described here so the UI can explain why the dashboard
//     has a tier the hardware does not.
//
// Everything a user can configure comes from `platform_thresholds`.

export interface Co2Standard {
  label: string;
  /** OSHA's 8-hour time-weighted exposure limit, ppm. Regulation, not config. */
  osha8HourLimitPpm: number;
  /** The three tiers the ESP32 firmware actually implements. */
  deviceTiers: { warning: number; alarm: number; critical: number };
  deviceTiersNote: string;
}

export interface LpgStandard {
  label: string;
  /** Lower Explosive Limit of LPG, ppm. Physical constant of the gas. */
  lelPpm: number;
  /** The same LEL, pre-formatted for display ("21,000 ppm"). */
  lelLabel: string;
  /** % of LEL each configured tier sits at, when it is a whole-number fraction. */
  percentLel: (ppm: number) => string | null;
}

export interface EnvStandard {
  label: string;
}

export const CO2_STANDARD: Co2Standard = {
  label: "ASHRAE 62.1 & OSHA",
  osha8HourLimitPpm: 5000,
  deviceTiers: { warning: 1000, alarm: 3500, critical: 5000 },
  deviceTiersNote:
    "The device implements warning, alarm and critical tiers only. The intermediate tier on this card is dashboard-only.",
};

export const LPG_STANDARD: LpgStandard = {
  label: "NFPA 54 / NFPA 715 & BS EN 50194-1",
  lelPpm: 21000,
  lelLabel: "21,000 ppm",
  percentLel: (ppm) => {
    const pct = (ppm / LPG_STANDARD.lelPpm) * 100;
    const rounded = Math.round(pct * 10) / 10;
    // Only report a clean integer percentage; "9.5% LEL" is noise in a card.
    return Number.isInteger(rounded) ? `${rounded}% LEL` : null;
  },
};

export const TEMP_STANDARD: EnvStandard = { label: "ASHRAE 55" };
export const HUMIDITY_STANDARD: EnvStandard = { label: "EPA & ASHRAE 62.1" };

// ---------------------------------------------------------------------------
// Generated reference-guide copy
// ---------------------------------------------------------------------------

export interface GuideRow {
  /** Band description, e.g. "1,000 - 2,000 ppm". Always generated. */
  range: string;
  /** What that band means. */
  label: string;
  tone: Tone;
}

export interface ReferenceCard {
  title: string;
  standard: string;
  rows: GuideRow[];
  /** Generated from the saved values; may be absent for a single-band card. */
  footnote?: string;
  /** Named device tiers, when the hardware has its own scale. */
  deviceNote?: string;
}

/**
 * Display formatting for a configured threshold value.
 *
 * Plain digits, no thousands separator, matching how the guides are written
 * ("1000 - 2000 ppm") and how the bands already read on screen. Separators are
 * only added for figures quoted from a standard, which carry their own
 * pre-formatted label (see LPG_STANDARD.lelLabel).
 */
function fmt(n: number): string {
  return String(Math.round(n));
}

function ppmRange(fromExclusive: number, toInclusive: number): string {
  return `${fmt(fromExclusive)} - ${fmt(toInclusive)} ppm`;
}

function ppmAtLeast(n: number): string {
  return `>= ${fmt(n)} ppm`;
}

function ppmBelow(n: number): string {
  return `< ${fmt(n)} ppm`;
}

/**
 * CO2 guide. All four bands come from the saved row, which is why the card has
 * an intermediate "High" band the firmware does not have.
 */
export function buildCo2Guide(th: Thresholds): ReferenceCard {
  const { warning, high, danger } = th.co2;
  return {
    title: "CO2 REFERENCE GUIDE",
    standard: CO2_STANDARD.label,
    rows: [
      { range: ppmBelow(warning), label: "Safe / Good", tone: "success" },
      { range: `${fmt(warning)} ppm${high > warning ? ` - ${fmt(high)} ppm` : ""}`, label: "Warning", tone: "warning" },
      { range: ppmRange(high, danger), label: "High", tone: "high" },
      { range: ppmAtLeast(danger), label: "Danger", tone: "danger" },
    ],
    // The leading number is the saved danger tier, so re-tuning the alarm in
    // Settings rewrites the footnote with it.
    footnote:
      `>${fmt(danger)} ppm triggers the physical alarm. OSHA's 8-hour limit is ` +
      `${fmt(CO2_STANDARD.osha8HourLimitPpm)} ppm; this threshold is set lower for earlier warning.`,
    deviceNote:
      `Device tiers: warning ${fmt(CO2_STANDARD.deviceTiers.warning)} ppm, ` +
      `alarm ${fmt(CO2_STANDARD.deviceTiers.alarm)} ppm, critical ${fmt(CO2_STANDARD.deviceTiers.critical)} ppm. ` +
      CO2_STANDARD.deviceTiersNote,
  };
}

/** LPG guide. Tier captions carry the %LEL when the value lands on a clean one. */
export function buildLpgGuide(th: Thresholds): ReferenceCard {
  const { warning, high, danger } = th.lpg;
  const annotate = (ppm: number, base: string) => {
    const pct = LPG_STANDARD.percentLel(ppm);
    return pct ? `${base} (${pct})` : base;
  };
  return {
    title: "LPG REFERENCE GUIDE",
    standard: LPG_STANDARD.label,
    rows: [
      { range: ppmBelow(warning), label: "Safe", tone: "success" },
      { range: ppmRange(warning, high), label: annotate(high, "Trace / Low Leak Warning"), tone: "warning" },
      { range: ppmRange(high, danger), label: annotate(danger, "Alarm Threshold / Danger"), tone: "high" },
      { range: ppmAtLeast(danger), label: annotate(danger, "Critical Hazard"), tone: "danger" },
    ],
    footnote: `${LPG_STANDARD.lelLabel} Lower Explosive Limit (100% LEL).`,
  };
}

export function buildTempGuide(th: Thresholds): GuideRow[] {
  const { freezeBelow, coolBelow, heatAbove } = th.temp;
  return [
    { range: `< ${fmt(freezeBelow)}°C`, label: "Freeze", tone: "danger" },
    { range: `${fmt(freezeBelow)}°C - ${fmt(coolBelow)}°C`, label: "Cool", tone: "warning" },
    { range: `${fmt(coolBelow)}°C - ${fmt(heatAbove)}°C`, label: "Comfortable", tone: "success" },
    { range: `> ${fmt(heatAbove)}°C`, label: "Heat", tone: "danger" },
  ];
}

export function buildHumidityGuide(th: Thresholds): GuideRow[] {
  const { dryBelow, lowBelow, moldAbove } = th.humidity;
  return [
    { range: `< ${fmt(dryBelow)}%`, label: "Dry", tone: "danger" },
    { range: `${fmt(dryBelow)}% - ${fmt(lowBelow)}%`, label: "Low", tone: "warning" },
    { range: `${fmt(lowBelow)}% - ${fmt(moldAbove)}%`, label: "Comfortable", tone: "success" },
    { range: `> ${fmt(moldAbove)}%`, label: "Mold Risk", tone: "danger" },
  ];
}

/** Every reference card for the current configuration, in one call. */
export function buildReferenceGuides(th: Thresholds) {
  return {
    co2: buildCo2Guide(th),
    lpg: buildLpgGuide(th),
    temp: { title: "TEMPERATURE REFERENCE GUIDE (DHT22)", standard: TEMP_STANDARD.label, rows: buildTempGuide(th) },
    humidity: { title: "HUMIDITY REFERENCE GUIDE (DHT22)", standard: HUMIDITY_STANDARD.label, rows: buildHumidityGuide(th) },
  };
}

/**
 * The "Active Configuration Overview" rows on the Settings page. Generated for
 * the same reason as the guides: the saved values must never be transcribed by
 * hand into a summary that could then drift from them.
 */
export function buildOverviewRows(th: Thresholds): { label: string; value: string }[] {
  return [
    { label: "CO2 tiers:", value: `${fmt(th.co2.warning)} / ${fmt(th.co2.high)} / ${fmt(th.co2.danger)} ppm` },
    { label: "LPG tiers:", value: `${fmt(th.lpg.warning)} / ${fmt(th.lpg.high)} / ${fmt(th.lpg.danger)} ppm` },
    { label: "Temp tiers:", value: `${fmt(th.temp.freezeBelow)}°C / ${fmt(th.temp.coolBelow)}°C / ${fmt(th.temp.heatAbove)}°C` },
    {
      label: "Humidity tiers:",
      value: `${fmt(th.humidity.dryBelow)}% / ${fmt(th.humidity.lowBelow)}% / ${fmt(th.humidity.moldAbove)}%`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ThresholdField =
  | "co2.warning"
  | "co2.high"
  | "co2.danger"
  | "lpg.warning"
  | "lpg.high"
  | "lpg.danger"
  | "temp.freezeBelow"
  | "temp.coolBelow"
  | "temp.heatAbove"
  | "humidity.dryBelow"
  | "humidity.lowBelow"
  | "humidity.moldAbove";

export type ValidationErrors = Partial<Record<ThresholdField, string>>;

export interface ValidationResult {
  valid: boolean;
  errors: ValidationErrors;
}

const METRIC_LABEL: Record<MetricKey, string> = {
  co2: "CO2",
  lpg: "LPG",
  temp: "Temperature",
  humidity: "Humidity",
};

/**
 * Plausible bounds for the temperature tiers, in °C.
 *
 * Sized around what an indoor DHT22 will report in a building: below -20 °C or
 * above 60 °C the reading itself is untrustworthy, so a danger limit set there
 * is a configuration mistake rather than a safety setting. These are deliberately
 * wider than the reference values so a genuinely hot site can still configure
 * them; they exist to stop a plausible-looking typo such as "40" for "14".
 */
export const TEMP_PLAUSIBLE_MIN = -20;
export const TEMP_PLAUSIBLE_MAX = 60;
/** A freeze/pipe-risk limit above this is higher than any sensible indoor setpoint. */
export const TEMP_PLAUSIBLE_FREEZE_MAX = 15;
/** A "too cool" advisory above this would fire on normal air conditioning. */
export const TEMP_PLAUSIBLE_COOL_MAX = 28;
/** A heat-stress limit below this would alarm on ordinary warm weather. */
export const TEMP_PLAUSIBLE_HEAT_MIN = 25;

function checkAscending(
  fields: Array<[ThresholdField, number]>,
  errors: ValidationErrors,
  subject: string
): void {
  for (let i = 0; i < fields.length - 1; i++) {
    const [key, value] = fields[i];
    const [nextKey, nextValue] = fields[i + 1];
    if (!Number.isFinite(value) || !Number.isFinite(nextValue)) {
      errors[key] = `${subject}: enter a number.`;
      continue;
    }
    if (value >= nextValue) {
      errors[key] = `Must be lower than ${nextKey.split(".")[1]} (${nextValue}).`;
    }
  }
  const [firstKey, firstValue] = fields[0];
  if (!Number.isFinite(firstValue)) {
    errors[firstKey] = `${subject}: enter a number.`;
  }
}

/**
 * Ascending-order validation for one tier group.
 *
 * Mirrors the CHECK constraints added in
 * supabase/migrations/20260915000000_reference_thresholds.sql, so the inline
 * message an admin sees is the same rule that would reject the write.
 */
export function validateThresholds(th: Thresholds): ValidationResult {
  const errors: ValidationErrors = {};

  checkAscending(
    [
      ["co2.warning", th.co2.warning],
      ["co2.high", th.co2.high],
      ["co2.danger", th.co2.danger],
    ],
    errors,
    METRIC_LABEL.co2
  );

  checkAscending(
    [
      ["lpg.warning", th.lpg.warning],
      ["lpg.high", th.lpg.high],
      ["lpg.danger", th.lpg.danger],
    ],
    errors,
    METRIC_LABEL.lpg
  );

  checkAscending(
    [
      ["temp.freezeBelow", th.temp.freezeBelow],
      ["temp.coolBelow", th.temp.coolBelow],
      ["temp.heatAbove", th.temp.heatAbove],
    ],
    errors,
    METRIC_LABEL.temp
  );

  checkAscending(
    [
      ["humidity.dryBelow", th.humidity.dryBelow],
      ["humidity.lowBelow", th.humidity.lowBelow],
      ["humidity.moldAbove", th.humidity.moldAbove],
    ],
    errors,
    METRIC_LABEL.humidity
  );

  // Physically meaningless values, beyond the ordering rule.
  if (Number.isFinite(th.co2.warning) && th.co2.warning < 0) {
    errors["co2.warning"] = "Cannot be negative.";
  }
  if (Number.isFinite(th.lpg.warning) && th.lpg.warning < 0) {
    errors["lpg.warning"] = "Cannot be negative.";
  }
  if (Number.isFinite(th.humidity.dryBelow) && (th.humidity.dryBelow < 0 || th.humidity.dryBelow > 100)) {
    errors["humidity.dryBelow"] = "Must be between 0 and 100 % RH.";
  }
  if (Number.isFinite(th.humidity.moldAbove) && (th.humidity.moldAbove <= 0 || th.humidity.moldAbove > 100)) {
    errors["humidity.moldAbove"] = "Must be between 0 and 100 % RH.";
  }

  // Temperature plausibility.
  //
  // Ordering alone is not a safety check. freezeBelow = 40, coolBelow = 45,
  // heatAbove = 50 is perfectly ascending, satisfies every database CHECK
  // constraint, and is accepted - after which tempSeverity grades a normal
  // 24 °C room as "danger", every room on the dashboard turns red and the
  // audible alarm starts on every open client at once. A false alarm that is
  // indistinguishable from a real one is itself a safety failure, so the tiers
  // are bounded to values the DHT22 can actually produce indoors.
  //
  // Each bound only reports when the ordering rule has not already flagged that
  // field: if the tiers are out of order, "must be lower than X" is the more
  // useful thing to tell the admin than a range complaint.
  if (
    !errors["temp.freezeBelow"] &&
    Number.isFinite(th.temp.freezeBelow) &&
    (th.temp.freezeBelow < TEMP_PLAUSIBLE_MIN || th.temp.freezeBelow > TEMP_PLAUSIBLE_FREEZE_MAX)
  ) {
    errors["temp.freezeBelow"] = `Must be between ${TEMP_PLAUSIBLE_MIN} and ${TEMP_PLAUSIBLE_FREEZE_MAX} °C.`;
  }
  if (
    !errors["temp.coolBelow"] &&
    Number.isFinite(th.temp.coolBelow) &&
    (th.temp.coolBelow < TEMP_PLAUSIBLE_MIN || th.temp.coolBelow > TEMP_PLAUSIBLE_COOL_MAX)
  ) {
    errors["temp.coolBelow"] = `Must be between ${TEMP_PLAUSIBLE_MIN} and ${TEMP_PLAUSIBLE_COOL_MAX} °C.`;
  }
  if (
    !errors["temp.heatAbove"] &&
    Number.isFinite(th.temp.heatAbove) &&
    (th.temp.heatAbove < TEMP_PLAUSIBLE_HEAT_MIN || th.temp.heatAbove > TEMP_PLAUSIBLE_MAX)
  ) {
    errors["temp.heatAbove"] = `Must be between ${TEMP_PLAUSIBLE_HEAT_MIN} and ${TEMP_PLAUSIBLE_MAX} °C.`;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}