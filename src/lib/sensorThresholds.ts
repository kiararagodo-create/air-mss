// src/lib/sensorThresholds.ts
//
// Legacy adapter. Severity grading now lives in src/lib/thresholdConfig.ts,
// which every other caller uses, so a card can no longer disagree with the
// badge beside it or with the reference guide below it.
//
// This module previously carried its own CO2_THRESHOLDS / LPG_THRESHOLDS
// constants (elevated 800 / danger 1600, elevated 500 / danger 1000). Those
// were left over from an earlier datasheet-derived scale, had never been
// updated when the saved configuration changed, and would have graded every
// reading differently from the rest of the app. They are gone: the thresholds
// now come from the caller, which reads them from public.platform_thresholds.

import type { Thresholds } from "../data/Data";
import {
  SEVERITY_LABEL,
  SEVERITY_RANK,
  SEVERITY_TONE,
  gasSeverity,
  hasAnyReading,
  overallSeverity,
  worstSeverity,
  type MetricReadings,
  type SeverityLevel,
} from "./thresholdConfig";

export type { SeverityLevel };
export { SEVERITY_RANK, SEVERITY_TONE };

/** Grade a CO2 reading against the saved configuration. */
export function getCo2Severity(ppm: number | null, thresholds: Thresholds): SeverityLevel {
  return gasSeverity(ppm, thresholds.co2);
}

/** Grade an LPG reading against the saved configuration. */
export function getLpgSeverity(ppm: number | null, thresholds: Thresholds): SeverityLevel {
  return gasSeverity(ppm, thresholds.lpg);
}

/** Grade a whole reading: the worst of all four metrics. */
export function getOverallSeverity(readings: Partial<MetricReadings>, thresholds: Thresholds): SeverityLevel {
  return overallSeverity(
    { co2: null, lpg: null, temp: null, humidity: null, ...readings },
    thresholds
  );
}

/**
 * Badge text for a grade, or null when nothing needs saying.
 *
 * A grade of "ok" is the only silent case, and only when something was
 * actually measured - a device that has never reported returns the same grade
 * but must be rendered as a no-data state, which is why callers also need
 * hasAnyReading().
 */
export function getSeverityBadgeLabel(severity: SeverityLevel): string | null {
  return severity === "ok" ? null : SEVERITY_LABEL[severity];
}

export { hasAnyReading, worstSeverity };