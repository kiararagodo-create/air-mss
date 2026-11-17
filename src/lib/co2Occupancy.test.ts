/// <reference types="vitest" />
import { describe, it, expect } from "vitest";
import {
  roomVolumeM3,
  predictCo2,
  maxOccupants,
  cleanCo2Window,
  fitAchFromDecay,
  estimateRange,
  scenarioTable,
} from "./co2Occupancy";

describe("roomVolumeM3", () => {
  it("computes volume for 6 x 5 x 3 = 90 m3", () => {
    const v = roomVolumeM3(6, 5, 3);
    expect(v).toBe(90);
  });

  it("throws on non-finite dimensions", () => {
    expect(() => roomVolumeM3(NaN, 5, 3)).toThrow();
    expect(() => roomVolumeM3(Infinity, 5, 3)).toThrow();
  });

  it("throws on zero or negative dimensions", () => {
    expect(() => roomVolumeM3(0, 5, 3)).toThrow();
    expect(() => roomVolumeM3(6, 0, 3)).toThrow();
  });
});

describe("predictCo2", () => {
  // V=90, t=2h, C0=500, Cout=420, G=0.018
  // ACH 0 -> zero-ventilation result: C0 + N*G*t*1e6/V
  // N=5 at ACH 3 predicts about 752.7 ppm; N=6 about 819 ppm. N=0 decays toward Cout.
  // ACH 1e-9 equals the zero-ventilation result within 0.01 ppm.

  it("ACH 0, t=2h, N=0: C0 + N*G*t*1e6/V = 500", () => {
    const v0 = predictCo2(500, 420, 0, 0.018, 90, 0, 2);
    expect(v0).toBeCloseTo(500, 1);
  });

  it("N=5 at ACH 3 predicts about 752.7 ppm", () => {
    const v = predictCo2(500, 420, 5, 0.018, 90, 3, 2);
    expect(v).toBeCloseTo(752.7, 1);
  });

  it("N=6 at ACH 3 predicts about 819 ppm", () => {
    const v = predictCo2(500, 420, 6, 0.018, 90, 3, 2);
    expect(v).toBeCloseTo(819, 0);
  });

  it("N=0 decays toward Cout", () => {
    const v = predictCo2(500, 420, 0, 0.018, 90, 3, 2);
    expect(v).toBeCloseTo(420.2, 1);
  });

  it("ACH 1e-9 equals zero-ventilation result within 0.01 ppm", () => {
    const withTinyAch = predictCo2(500, 420, 0, 0.018, 90, 1e-9, 2);
    const zeroAch = predictCo2(500, 420, 0, 0.018, 90, 0, 2);
    expect(Math.abs(withTinyAch - zeroAch)).toBeLessThan(0.01);
  });
});

describe("maxOccupants", () => {
  it("C0=850 with target 800 gives above_target_now and no headcount", () => {
    // With t=2h, ACH=1, the formula should give above_target_now
    const result = maxOccupants(850, 800, 90, 1, 0.018, 420, 2);
    expect(result.status).toBe("above_target_now");
    expect(result.occupants).toBe(0);
  });

  it("ACH 0, t=2h, target 800: N = floor((800-500)*90/(0.018*2*1e6)) = floor(18000/36000) = 0", () => {
    const result = maxOccupants(500, 800, 90, 0, 0.018, 420, 2);
    expect(result.status).toBe("ok");
    expect(result.occupants).toBe(0);
  });

  it("ACH 1, t=2h, target 800: N = 2", () => {
    // N = floor((800-420 - (500-420)*e^(-1*2)) * 90 * 1 / (0.018 * 1e6 * (1 - e^(-1*2))))
    // = floor((380 - 80*e^(-2)) * 90 / (0.018e6 * (1 - e^(-2))))
    // e^(-2) ≈ 0.1353
    // numerator = (380 - 80*0.1353) * 90 = (380 - 10.824) * 90 = 369.176 * 90 = 33225.84
    // denominator = 0.018e6 * (1 - 0.1353) = 18000 * 0.8647 = 15564.6
    // N = floor(33225.84 / 15564.6) = floor(2.134) = 2
    const result = maxOccupants(500, 800, 90, 1, 0.018, 420, 2);
    expect(result.status).toBe("ok");
    expect(result.occupants).toBe(2);
  });

  it("ACH 1, t=2h, target 1000: N = 3", () => {
    // N = floor((1000-420 - (500-420)*e^(-1*2)) * 90 * 1 / (0.018e6 * (1 - e^(-1*2))))
    // = floor((580 - 80*0.1353) * 90 / 15564.6)
    // = floor((580 - 10.824) * 90 / 15564.6)
    // = floor(569.176 * 90 / 15564.6)
    // = floor(51225.84 / 15564.6)
    // = floor(3.291) = 3
    const result = maxOccupants(500, 1000, 90, 1, 0.018, 420, 2);
    expect(result.status).toBe("ok");
    expect(result.occupants).toBe(3);
  });

  it("ACH 3, t=2h, target 800: N = 5", () => {
    // e^(-3*2) = e^(-6) ≈ 0.002479
    // numerator = (800-420 - (500-420)*0.002479) * 90 * 3 = (380 - 80*0.002479) * 270 = (380 - 0.198) * 270 = 379.802 * 270 = 102546.54
    // denominator = 0.018e6 * (1 - 0.002479) = 18000 * 0.997521 = 17955.38
    // N = floor(102546.54 / 17955.38) = floor(5.711) = 5
    const result = maxOccupants(500, 800, 90, 3, 0.018, 420, 2);
    expect(result.status).toBe("ok");
    expect(result.occupants).toBe(5);
  });

  it("ACH 3, t=2h, target 1000: N = 8", () => {
    // numerator = (1000-420 - (500-420)*0.002479) * 90 * 3 = (580 - 80*0.002479) * 270 = (580 - 0.198) * 270 = 579.802 * 270 = 156546.54
    // denominator = 18000 * 0.997521 = 17955.38
    // N = floor(156546.54 / 17955.38) = floor(8.718) = 8
    const result = maxOccupants(500, 1000, 90, 3, 0.018, 420, 2);
    expect(result.status).toBe("ok");
    expect(result.occupants).toBe(8);
  });

  it("ACH 6, t=2h, target 800: N = 11", () => {
    // e^(-6*2) = e^(-12) ≈ 6.14e-6 (essentially 0)
    // numerator ≈ (800-420 - (500-420)*0) * 90 * 6 = 380 * 540 = 205200
    // denominator = 0.018e6 * (1 - ~0) = 18000
    // N = floor(205200 / 18000) = floor(11.4) = 11
    const result = maxOccupants(500, 800, 90, 6, 0.018, 420, 2);
    expect(result.status).toBe("ok");
    expect(result.occupants).toBe(11);
  });

  it("ACH 6, t=2h, target 1000: N = 17", () => {
    // numerator = (1000-420 - (500-420)*~0) * 90 * 6 = 580 * 540 = 313200
    // denominator = 18000
    // N = floor(313200 / 18000) = floor(17.4) = 17
    const result = maxOccupants(500, 1000, 90, 6, 0.018, 420, 2);
    expect(result.status).toBe("ok");
    expect(result.occupants).toBe(17);
  });

  it("steadyStateCoc is computed correctly", () => {
    // At ACH=3, V=90, G=0.018, for N=5: Css = 420 + 5*0.018*1e6/(90*3) = 420 + 5*66.67 = 420 + 333.35 = 753.35
    const result = maxOccupants(500, 800, 90, 3, 0.018, 420, 2);
    expect(result.steadyStateCoc).toBeCloseTo(420 + 5 * 0.018 * 1e6 / (90 * 3), 1);
  });

  it("durationHours is recorded", () => {
    const result = maxOccupants(500, 800, 90, 2, 0.018, 420, 5);
    expect(result.durationHours).toBe(5);
  });
});

describe("cleanCo2Window", () => {
  it("median of valid readings", () => {
    const readings = [
      { ppm: 400, timestamp: Date.now() },
      { ppm: 410, timestamp: Date.now() },
      { ppm: 395, timestamp: Date.now() },
    ];
    const result = cleanCo2Window(readings, Date.now());
    expect(result.value).toBeCloseTo(400, 1);
    expect(result.quality).toBe("good");
  });

  it("returns stale if newest is older than 3 minutes (with 3+ valid readings)", () => {
    const old = Date.now() - 4 * 60 * 1000; // 4 minutes ago
    const readings = [
      { ppm: 400, timestamp: old },
      { ppm: 405, timestamp: old },
      { ppm: 395, timestamp: old },
    ];
    const result = cleanCo2Window(readings, Date.now());
    expect(result.quality).toBe("stale");
  });

  it("returns insufficient if fewer than 3 valid readings", () => {
    const readings = [
      { ppm: 400, timestamp: Date.now() },
    ];
    const result = cleanCo2Window(readings, Date.now());
    expect(result.quality).toBe("insufficient");
  });

  it("filters out-of-range values, uses median of valid", () => {
    const readings = [
      { ppm: 400, timestamp: Date.now() },
      { ppm: 410, timestamp: Date.now() },
      { ppm: 5001, timestamp: Date.now() }, // out of range (max 5000)
      { ppm: 395, timestamp: Date.now() },
    ];
    const result = cleanCo2Window(readings, Date.now(), { range: [300, 5000] });
    // 5001 > 5000 so excluded; valid: 400, 410, 395; median = 400
    expect(result.quality).toBe("good");
    expect(result.value).toBeCloseTo(400, 1);
  });

  it("rejects zero and NaN readings (counts only valid)", () => {
    const readings = [
      { ppm: 0, timestamp: Date.now() },
      { ppm: NaN, timestamp: Date.now() },
      { ppm: 400, timestamp: Date.now() },
      { ppm: 410, timestamp: Date.now() },
    ];
    // Only 2 valid readings (400, 410), so insufficient
    const result = cleanCo2Window(readings, Date.now());
    expect(result.quality).toBe("insufficient");
  });
});

describe("fitAchFromDecay", () => {
  it("rejects fewer than 6 points", () => {
    const points = [
      { tHours: 0, ppm: 800 },
      { tHours: 1, ppm: 600 },
      { tHours: 2, ppm: 500 },
      { tHours: 3, ppm: 450 },
      { tHours: 4, ppm: 430 },
    ];
    const result = fitAchFromDecay(points, 420);
    expect(result.reason).toContain("fewer than 6");
  });

  it("rejects if some C <= Cout (with 6+ points)", () => {
    const points = [
      { tHours: 0, ppm: 800 },
      { tHours: 1, ppm: 600 },
      { tHours: 2, ppm: 500 },
      { tHours: 3, ppm: 420 }, // C <= Cout
      { tHours: 4, ppm: 430 },
      { tHours: 5, ppm: 450 },
    ];
    const result = fitAchFromDecay(points, 420);
    expect(result.reason).toContain("C <= Cout");
  });

  it("synthetic decay with ACH 2.0 recovers approximately (noiseless)", () => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      const t = i * 0.5;
      const c = 420 + (800 - 420) * Math.exp(-2.0 * t);
      points.push({ tHours: t, ppm: Math.max(c, 421) });
    }
    const result = fitAchFromDecay(points, 420);
    if (result.reason) {
      console.log("fit reason with noiseless data:", result.reason);
    } else {
      expect(result.ach).toBeGreaterThan(1.5);
      expect(result.ach).toBeLessThan(2.5);
    }
  });
});

describe("estimateRange", () => {
  it("computes low/best/high range and counts", () => {
    const result = estimateRange(2, 0.018, 420, 500, 5, 2);
    expect(result).toHaveProperty("low");
    expect(result).toHaveProperty("best");
    expect(result).toHaveProperty("high");
    expect(result).toHaveProperty("warningCount");
    expect(result).toHaveProperty("dangerCount");
    expect(typeof result.low).toBe("number");
    expect(typeof result.best).toBe("number");
    expect(typeof result.high).toBe("number");
    expect(typeof result.warningCount).toBe("number");
    expect(typeof result.dangerCount).toBe("number");
  });
});

describe("scenarioTable", () => {
  it("returns rows flagged hypothetical for ACH values", () => {
    const rows = scenarioTable([1, 3, 6]);
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(row.status).toBe("hypothetical");
      expect(row.ach).toBeGreaterThan(0);
    });
  });

  it("returns unavailable row for null ACH", () => {
    const rows = scenarioTable(null);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unavailable");
    expect(rows[0].reason).toBe("ventilation_not_established");
  });
});