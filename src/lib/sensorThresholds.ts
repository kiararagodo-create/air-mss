import type { DeviceReadings, SeverityLevel } from "../types";

/**
 * Threshold reference (derived from MH-Z19C and MQ-6 datasheets, tuned to
 * indoor classroom/lab safety guidance):
 *
 * CO2 (MH-Z19C, ppm)      LPG (MQ-6, ppm)
 * ------------------      ---------------
 * normal   : < 800        normal   : < 500
 * elevated : 800 - 1600   elevated : 500 - 1000
 * danger   : > 1600       danger   : > 1000
 */
export const CO2_THRESHOLDS = {
  elevated: 800,
  danger: 1600,
} as const;

export const LPG_THRESHOLDS = {
  elevated: 500,
  danger: 1000,
} as const;

export function getCo2Severity(ppm: number | null): SeverityLevel {
  if (ppm === null) return "normal";
  if (ppm > CO2_THRESHOLDS.danger) return "danger";
  if (ppm >= CO2_THRESHOLDS.elevated) return "elevated";
  return "normal";
}

export function getLpgSeverity(ppm: number | null): SeverityLevel {
  if (ppm === null) return "normal";
  if (ppm > LPG_THRESHOLDS.danger) return "danger";
  if (ppm >= LPG_THRESHOLDS.elevated) return "elevated";
  return "normal";
}

const SEVERITY_RANK: Record<SeverityLevel, number> = {
  normal: 0,
  elevated: 1,
  danger: 2,
};

/** Overall card severity is always the worse of the two readings. */
export function getOverallSeverity(readings: DeviceReadings): SeverityLevel {
  const co2 = getCo2Severity(readings.co2Ppm);
  const lpg = getLpgSeverity(readings.lpgPpm);
  return SEVERITY_RANK[co2] >= SEVERITY_RANK[lpg] ? co2 : lpg;
}

export function getSeverityBadgeLabel(severity: SeverityLevel): string | null {
  switch (severity) {
    case "danger":
      return "Danger";
    case "elevated":
      return "High Gas Detected";
    case "normal":
      return null; // no badge needed when readings are normal
  }
}
