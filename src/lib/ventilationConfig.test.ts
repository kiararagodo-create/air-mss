/// <reference types="vitest" />
import { describe, it, expect } from "vitest";
import { roomVolumeM3 } from "./co2Occupancy";
import {
  validateVentilationConfig,
  getVentilationTypeLabel,
  getVolumeText,
} from "./ventilationConfig";

describe("validateVentilationConfig", () => {
  it("valid config: window_ac, ach=2, durationH=2", () => {
    const errors = validateVentilationConfig("window_ac", 2, 2);
    expect(errors).toHaveLength(0);
  });

  it("ach blank (undefined) is valid", () => {
    const errors = validateVentilationConfig("split_ac", undefined, 3);
    expect(errors).toHaveLength(0);
  });

  it("ach out of range (> 60) is invalid", () => {
    const errors = validateVentilationConfig("window_ac", 61, 2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ACH");
  });

  it("ach out of range (< 0) is invalid", () => {
    const errors = validateVentilationConfig("window_ac", -1, 2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ACH");
  });

  it("durationH too low (< 0.5) is invalid", () => {
    const errors = validateVentilationConfig("window_ac", 2, 0.3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Duration");
  });

  it("durationH too high (> 12) is invalid", () => {
    const errors = validateVentilationConfig("window_ac", 2, 13);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Duration");
  });

  it("invalid ventilation type is caught", () => {
    const errors = validateVentilationConfig("invalid_type", 2, 2);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("getVentilationTypeLabel", () => {
  it("returns correct label for known types", () => {
    expect(getVentilationTypeLabel("window_ac")).toBe("Window-type AC");
    expect(getVentilationTypeLabel("split_ac")).toBe("Split-type AC");
    expect(getVentilationTypeLabel("central_ac_outdoor_air")).toBe(
      "Central AC with outdoor-air supply",
    );
    expect(getVentilationTypeLabel("natural")).toBe("Natural ventilation");
    expect(getVentilationTypeLabel("mechanical")).toBe("Mechanical ventilation");
    expect(getVentilationTypeLabel("unknown")).toBe("Unknown");
  });

  it("returns the type string for unknown types", () => {
    expect(getVentilationTypeLabel("made_up")).toBe("made_up");
  });
});

describe("getVolumeText", () => {
  it("returns volume text for valid dimensions", () => {
    const result = getVolumeText(6, 5, 3, roomVolumeM3);
    expect(result).toBe("Room volume: 90 m3");
  });

  it("returns null for invalid dimensions (0)", () => {
    const result = getVolumeText(0, 5, 3, roomVolumeM3);
    expect(result).toBeNull();
  });

  it("returns null for negative dimensions", () => {
    const result = getVolumeText(-1, 5, 3, roomVolumeM3);
    expect(result).toBeNull();
  });

  it("returns null for NaN dimensions", () => {
    const result = getVolumeText(NaN, 5, 3, roomVolumeM3);
    expect(result).toBeNull();
  });
});

describe("Ventilation type labels cover all enum values", () => {
  it("all values have labels", () => {
    const types: string[] = [
      "window_ac",
      "split_ac",
      "central_ac_outdoor_air",
      "natural",
      "mechanical",
      "unknown",
    ];
    types.forEach((t) => {
      const label = getVentilationTypeLabel(t);
      expect(label).not.toBe("");
    });
  });
});