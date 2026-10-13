// src/hooks/useThresholdConfig.ts
//
// The one entry point for safety configuration in the React tree.
//
// Components call this instead of reading threshold numbers themselves. It
// resolves the saved configuration from RoomsContext - which loads it from
// public.platform_thresholds, keeps it in sync across sessions over realtime,
// and falls back to DEFAULT_THRESHOLDS only when the fetch fails - and returns
// every derived value the UI needs, already computed:
//
//   * `guides`         - the reference cards, ranges, labels and footnotes
//   * `overviewRows`   - the Settings page's "Active Configuration Overview"
//   * `severity`       - ok / warning / high / danger from raw readings
//   * `validation`     - the ascending-order rule, for inline form errors
//
// Nothing downstream re-derives a range string or a badge tone from a literal,
// so there is exactly one place where a saved value becomes something a person
// reads.

import { useMemo } from "react";
import { useRooms } from "../context/RoomsContext";
import type { Thresholds } from "../data/Data";
import {
  buildOverviewRows,
  buildReferenceGuides,
  hasAnyReading,
  metricSeverity,
  overallSeverity,
  validateThresholds,
  type GuideRow,
  type MetricKey,
  type ReferenceCard,
  type SeverityLevel,
  type ThresholdField,
  type ValidationErrors,
} from "../lib/thresholdConfig";

export interface ThresholdConfig {
  /** The saved configuration. Never a locally-held copy. */
  thresholds: Thresholds;

  // ---- Reference copy, generated ----
  guides: {
    co2: ReferenceCard;
    lpg: ReferenceCard;
    temp: { title: string; standard: string; rows: GuideRow[] };
    humidity: { title: string; standard: string; rows: GuideRow[] };
  };
  /** Rows for the "Active Configuration Overview" card. */
  overviewRows: { label: string; value: string }[];

  // ---- Severity, computed from raw readings ----
  /** Grade one metric (co2 | lpg | temp | humidity) for a set of readings. */
  severity: (metric: MetricKey, value: number | null | undefined) => SeverityLevel;
  /** Grade a whole reading; the worst of the four metrics. */
  overall: (readings: {
    co2?: number | null;
    lpg?: number | null;
    temp?: number | null;
    humidity?: number | null;
  }) => SeverityLevel;
  /** False when nothing at all has been measured. Never true for a zero. */
  hasData: (readings: {
    co2?: number | null;
    lpg?: number | null;
    temp?: number | null;
    humidity?: number | null;
  }) => boolean;

  // ---- Validation ----
  /** Ascending-order rule for a candidate configuration. */
  validate: (candidate: Thresholds) => { valid: boolean; errors: ValidationErrors };
  /** Whether the currently saved configuration is itself valid. */
  savedIsValid: boolean;
}

export function useThresholdConfig(): ThresholdConfig {
  const { thresholds } = useRooms();

  const guides = useMemo(() => buildReferenceGuides(thresholds), [thresholds]);
  const overviewRows = useMemo(() => buildOverviewRows(thresholds), [thresholds]);
  const savedValidation = useMemo(() => validateThresholds(thresholds), [thresholds]);

  return {
    thresholds,
    guides,
    overviewRows,
    severity: (metric, value) => metricSeverity(metric, value, thresholds),
    overall: (readings) =>
      overallSeverity(
        { co2: null, lpg: null, temp: null, humidity: null, ...readings },
        thresholds
      ),
    hasData: (readings) =>
      hasAnyReading({ co2: null, lpg: null, temp: null, humidity: null, ...readings }),
    validate: validateThresholds,
    savedIsValid: savedValidation.valid,
  };
}

export type { ThresholdField, ValidationErrors, SeverityLevel, MetricKey, ReferenceCard, GuideRow };