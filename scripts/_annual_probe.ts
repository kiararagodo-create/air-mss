// Re-export shim so the annual smoke test imports the real shared module.
export {
  COLORS,
  PdfBuilder,
  buildAnnualAnalysis,
  buildAnalysis,
  concatBytes,
  csvCell,
  csvRow,
  CSV_HEADER,
  dangerHigh,
  dangerLow,
  fmtTs,
  humanDate,
  isDangerRow,
  manilaDateString,
  manilaDayEndIso,
  manilaDayStartIso,
  monthLabel,
  num,
  parseManilaDate,
  streamReadings,
  thresholdNote,
  triggeredBy,
  uploadAndVerify,
  warnLine,
  METRIC_LABEL,
  METRIC_UNIT,
} from "../supabase/functions/_shared/reporting.ts";

export type {
  AnnualAnalysis,
  AnnualMonth,
  ThresholdChange,
  Thresholds,
  MetricStat,
} from "../supabase/functions/_shared/reporting.ts";

export const ThresholdNoteStub = undefined;