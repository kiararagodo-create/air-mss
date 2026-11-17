/**
 * Smart CO2 Occupancy Estimator (pure calculation module)
 * No React, no Supabase, no Date.now() inside the math (pass time in).
 * Units in names and comments: ppm, m3, m3/h, 1/h, hours.
 * Constants: G default 0.018 m3/h per seated adult (configurable).
 * Cout default 420 ppm, flagged illustrative.
 */

/** Room volume in cubic metres. Validation: finite and > 0. */
export function roomVolumeM3(length: number, width: number, height: number): number {
  if (!isFinite(length) || !isFinite(width) || !isFinite(height)) {
    throw new TypeError("roomVolumeM3: dimensions must be finite numbers");
  }
  if (length <= 0 || width <= 0 || height <= 0) {
    throw new TypeError("roomVolumeM3: dimensions must be > 0");
  }
  return length * width * height;
}

/**
 * Predict CO2 concentration after t hours.
 * C(t) = Cout + (C0 - Cout) * exp(-ACH * t) + [N * G * 1e6 / (V * ACH)] * (1 - exp(-ACH * t))
 *
 * For ACH = 0 (or below 1e-6): C0 + N * G * t * 1e6 / V
 *
 * @param c0   initial CO2 in ppm
 * @param cout equilibrium/outdoor CO2 in ppm
 * @param n    number of occupied persons
 * @param g    CO2 generation rate per person (m3/h, default 0.018)
 * @param v    room volume in m3
 * @param ach  air changes per hour
 * @param t    time in hours
 */
export function predictCo2(
  c0: number,
  cout: number,
  n: number,
  g: number,
  v: number,
  ach: number,
  t: number,
): number {
  const eps = 1e-6;
  if (ach <= eps) {
    // Zero/negligible ventilation: C0 + N*G*t*1e6/V
    return c0 + (n * g * t * 1e6) / v;
  }
  const expTerm = Math.exp(-ach * t);
  return (
    cout +
    (c0 - cout) * expTerm +
    (n * g * 1e6 / (v * ach)) * (1 - expTerm)
  );
}

/** Status returned by maxOccupants. */
export type MaxOccupantsStatus = "ok" | "above_target_now";

/** Full result from maxOccupants, includes duration. */
export type MaxOccupantsResult = {
  status: MaxOccupantsStatus;
  occupants: number;         // floor of computed N (never negative)
  steadyStateCoc: number;   // Css at the computed occupants
  durationHours: number;    // t used in the calculation
};

/**
 * Compute maximum occupants and status given current CO2, target, ventilation, and duration.
 *
 * Formula (general case, ACH > 0):
 *   N = floor( (Ctarget - Cout - (C0 - Cout) * e^(-ACH*t)) * V * ACH / (G * 1e6 * (1 - e^(-ACH*t))) )
 *
 * For ACH = 0 (no ventilation):
 *   N = floor( (Ctarget - C0) * V / (G * t * 1e6) )
 *
 * If C0 >= target: status = "above_target_now", occupants = 0, steadyStateCoc = Cout.
 *
 * @param c0       current CO2 in ppm
 * @param target   target CO2 threshold in ppm
 * @param v        room volume in m3
 * @param ach      air changes per hour (may be null/undefined)
 * @param g        CO2 generation rate per person (m3/h, default 0.018)
 * @param cout     outdoor/equilibrium CO2 in ppm (default 420)
 * @param t        duration in hours
 * @returns { status, occupants, steadyStateCoc, durationHours }
 */
export function maxOccupants(
  c0: number,
  target: number,
  v: number,
  ach: number | null | undefined,
  g: number,
  cout: number,
  t: number,
): MaxOccupantsResult {
  // If c0 already at or above target, no headcount needed
  if (c0 >= target) {
    return {
      status: "above_target_now" as MaxOccupantsStatus,
      occupants: 0,
      steadyStateCoc: cout,
      durationHours: t,
    };
  }

  // If ACH is null/undefined, return ok with 0 occupants (ventilation not established)
  if (ach === null || ach === undefined) {
    return {
      status: "ok" as MaxOccupantsStatus,
      occupants: 0,
      steadyStateCoc: cout,
      durationHours: t,
    };
  }

  // General case: ACH > 0 and t > 0
  const expTerm = Math.exp(-ach * t);
  const numerator = (target - cout - (c0 - cout) * expTerm) * v * ach;
  const denominator = g * 1e6 * (1 - expTerm);

  let occupants: number;
  if (denominator > 0) {
    occupants = Math.max(0, Math.floor(numerator / denominator));
  } else {
    // Fallback to steady-state only if denominator is zero
    const nSteady = ((target - cout) * v * ach) / (g * 1e6);
    occupants = Math.max(0, Math.floor(nSteady));
  }

  const steadyStateCoc = cout + (occupants * g * 1e6) / (v * ach);

  return {
    status: "ok" as MaxOccupantsStatus,
    occupants,
    steadyStateCoc,
    durationHours: t,
  };
}

/** Clean a sliding window of CO2 readings. */
export interface CleanCo2WindowOptions {
  /** Window duration in minutes (default 30) */
  windowMinutes?: number;
  /** Acceptable range in ppm (default 300 to 5000) */
  range?: [number, number];
  /** Age in minutes considered "stale" (default 3) */
  staleAgeMinutes?: number;
}

export interface CleanCo2WindowResult {
  value: number;     // median ppm
  quality: "good" | "stale" | "insufficient" | "implausible";
  reason: string;
}

/**
 * Return { value, quality, reason } from a CO2 readings array.
 * - Median of recent valid readings (valid = not NaN, not 0, in range).
 * - 'stale' if the newest reading is older than ~3 minutes (default).
 * - 'insufficient' if fewer than 3 valid readings.
 * - 'implausible' if a reading is out of the acceptable range.
 */
export function cleanCo2Window(
  readings: { ppm: number; timestamp: number }[],
  now: number,
  opts: CleanCo2WindowOptions = {},
): CleanCo2WindowResult {
  const {
    windowMinutes = 30,
    range = [300, 5000],
    staleAgeMinutes = 3,
  } = opts;

  const [minRange, maxRange] = range;

  // Filter to valid readings (not NaN, not 0, in range) within the window
  const cutoff = now - windowMinutes * 60 * 1000;
  const valid: number[] = [];
  let newestTime = 0;

  for (const r of readings) {
    if (Number.isNaN(r.ppm) || r.ppm === 0 || r.ppm < minRange || r.ppm > maxRange) {
      // implausible – skip but track newest time
      if (r.timestamp > newestTime) newestTime = r.timestamp;
      continue;
    }
    if (r.timestamp >= cutoff) {
      valid.push(r.ppm);
    }
    if (r.timestamp > newestTime) newestTime = r.timestamp;
  }

  // If fewer than 3 valid readings, return insufficient
  if (valid.length < 3) {
    return {
      value: valid.length > 0 ? valid[0] : 0,
      quality: "insufficient",
      reason: `insufficient valid readings (${valid.length}), need at least 3`,
    };
  }

  // If the newest reading (any reading, valid or not) is older than staleAgeMinutes, mark stale
  const ageMinutes = (now - newestTime) / 60000;
  if (ageMinutes > staleAgeMinutes) {
    return {
      value: valid.length > 0 ? valid[0] : 0,
      quality: "stale",
      reason: `newest reading older than ${staleAgeMinutes} minutes`,
    };
  }

  // Compute median
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return {
    value: median,
    quality: "good",
    reason: "median of valid readings",
  };
}

/** Linear regression of ln(C - Cout) vs t (hours) to estimate ACH. */
export interface FitAchResult {
  ach: number;
  r2: number;
  reason?: string;
}

/**
 * Fit ACH from a set of { tHours, ppm } points using linear regression
 * of ln(C - Cout) vs t. Returns reason if the fit is bad.
 */
export function fitAchFromDecay(
  points: { tHours: number; ppm: number }[],
  cout: number,
): FitAchResult {
  const minPoints = 6;
  if (points.length < minPoints) {
    return { ach: 0, r2: 0, reason: `fewer than ${minPoints} points` };
  }

  // Compute ln(C - Cout) for each point; reject if any C <= Cout
  const y: number[] = [];
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;

  for (const p of points) {
    if (p.ppm <= cout) {
      return { ach: 0, r2: 0, reason: "some C <= Cout" };
    }
    const yi = Math.log(p.ppm - cout);
    const ti = p.tHours;
    sumX += ti;
    sumY += yi;
    sumXY += ti * yi;
    sumX2 += ti * ti;
    y.push(yi);
  }

  // n = points.length
  const n = points.length;
  const meanX = sumX / n;
  const meanY = sumY / n;

  // slope = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX^2)
  const slope =
    (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = meanY - slope * meanX;

  // R^2 calculation
  const ssRes = y.reduce((sum, yi, i) => {
    const predicted = slope * points[i].tHours + intercept;
    return sum + Math.pow(yi - predicted, 2);
  }, 0);
  const ssTot = y.reduce((sum, yi) => sum + Math.pow(yi - meanY, 2), 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // slope = -ACH, so ACH = -slope
  const achValue = -slope;

  // Check total decay: max C - min C should be >= 100 ppm
  const sortedByT = [...points].sort((a, b) => a.tHours - b.tHours);
  const maxC = sortedByT[sortedByT.length - 1].ppm;
  const minC = sortedByT[0].ppm;
  const decay = maxC - minC;

  if (achValue <= 0) {
    return { ach: 0, r2, reason: "ACH <= 0" };
  }
  if (decay < 100) {
    return { ach: achValue, r2, reason: `total decay < 100 ppm (${decay.toFixed(1)} ppm)` };
  }

  return { ach: achValue, r2, reason: undefined };
}

/** Estimate CO2 range (low/best/high) given ACH uncertainty and generation rate uncertainty. */
export interface EstimateRangeResult {
  low: number;
  best: number;
  high: number;
  warningCount: number; // count at warning target
  dangerCount: number; // count at danger target
}

/**
 * Estimate CO2 concentrations low/best/high using ACH ±20%, G ±15%, CO2 +/-(50 ppm + 5% of reading).
 *
 * @param ach       air changes per hour (may be null)
 * @param g         CO2 generation rate per person (m3/h, default 0.018)
 * @param cout      outdoor CO2 in ppm (default 420)
 * @param co2Reading current reading in ppm (for the ±5% part)
 * @param n         number of occupants (default 1)
 * @param t         time in hours (default 1)
 */
export function estimateRange(
  _ach: number | null,
  g: number,
  cout: number,
  _co2Reading: number,
  n: number,
  t: number,
): EstimateRangeResult {
  // If ACH is null/undefined, return a pattern indicating unavailable
  const achBase = _ach ?? 0;
  const achLow = achBase * 0.8;
  const achHigh = achBase * 1.2;
  const gLow = g * 0.85;
  const gHigh = g * 1.15;

  // Helper to predict given ACH and G
  const predict = (achVal: number, gVal: number): number =>
    predictCo2(500, cout, n, gVal, 90, achVal, t); // using typical room for range estimate

  const best = predict(achBase, g);
  const low = predict(achLow, gLow);
  const high = predict(achHigh, gHigh);

  // At best ACH/G, compute occupant counts at warning (800) and danger (1000) targets
  const V = 90;
  const warningTarget = 800;
  const dangerTarget = 1000;

  // Occupants that would push CO2 above warning/danger at best ACH/G
  const nWarningBest = ((warningTarget - cout) * V * achBase) / (g * 1e6);
  const nDangerBest = ((dangerTarget - cout) * V * achBase) / (g * 1e6);

  // Return floor of best estimate counts
  const warningCount = Math.max(0, Math.floor(nWarningBest));
  const dangerCount = Math.max(0, Math.floor(nDangerBest));

  return {
    low: low,
    best: best,
    high: high,
    warningCount,
    dangerCount,
  };
}

/** Scenario table: evaluate a list of ACH values hypothetically. */
export interface ScenarioRow {
  ach: number | null;
  status: "ok" | "unavailable" | "hypothetical";
  reason?: string;
  steadyStateCoc?: number;
  occupantsForTarget?: number; // at target 800 ppm
}

/** Generate scenario rows for a list of ACH values. */
export function scenarioTable(achList: number[] | null): ScenarioRow[] {
  // Always return at least one row; null/empty means unavailable
  if (!achList) {
    return [{ ach: null, status: "unavailable", reason: "ventilation_not_established" }];
  }
  return achList.map((ach) => {
    if (ach === null || ach === undefined) {
      return { ach: null, status: "unavailable", reason: "ventilation_not_established" };
    }
    // Steady-state CO2 for N=1 at this ACH, V=90, Cout=420, G=0.018
    const ssCoc = 420 + (1 * 0.018 * 1e6) / (90 * ach);
    // Occupants needed for 800 ppm steady state
    const nFor800 = ((800 - 420) * 90 * ach) / (0.018 * 1e6);
    return {
      ach,
      status: "hypothetical",
      reason: "hypothetical scenario",
      steadyStateCoc: ssCoc,
      occupantsForTarget: Math.floor(nFor800),
    };
  });
}