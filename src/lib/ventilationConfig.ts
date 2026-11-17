/** Ventilation configuration for the CO2 occupancy estimator.
 * Pure TypeScript: no React, no Supabase, no Date.now() inside the math.
 * All strings are plain labels; callers i18n/localise as needed.
 */

/** Ventilation type options with display labels. */
export type VentilationType =
  | "window_ac"
  | "split_ac"
  | "central_ac_outdoor_air"
  | "natural"
  | "mechanical"
  | "unknown";

/** Display label for each ventilation type. */
export const ventilationTypeLabels: Record<VentilationType, string> = {
  window_ac: "Window-type AC",
  split_ac: "Split-type AC",
  central_ac_outdoor_air: "Central AC with outdoor-air supply",
  natural: "Natural ventilation",
  mechanical: "Mechanical ventilation",
  unknown: "Unknown",
};

/** Validate a ventilation configuration object.
 * Returns an array of error messages (empty = valid).
 * - type must be one of the known VentilationType values.
 * - ach is optional; if given, must be a number in [0, 60].
 * - durationH must be in [0.5, 12] (step 0.5 recommended, integers ok).
 */
export function validateVentilationConfig(
  type: string,
  ach: number | undefined,
  durationH: number,
): string[] {
  const errors: string[] = [];

  // Validate type
  if (!Object.keys(ventilationTypeLabels).includes(type)) {
    errors.push(`Invalid ventilation type: "${type}". Must be one of: ${Object.values(ventilationTypeLabels).join(", ")}`);
  }

  // Validate ach (optional)
  if (ach !== undefined && ach !== null) {
    if (!Number.isFinite(ach)) {
      errors.push("ACH must be a finite number");
    } else if (ach < 0 || ach > 60) {
      errors.push("ACH must be between 0 and 60 (inclusive)");
    }
  }

  // Validate durationH
  if (!Number.isFinite(durationH)) {
    errors.push("Duration must be a finite number");
  } else if (durationH < 0.5 || durationH > 12) {
    errors.push("Duration must be between 0.5 and 12 hours");
  }

  return errors;
}

/** Get the display label for a ventilation type. */
export function getVentilationTypeLabel(type: string): string {
  const label = ventilationTypeLabels[type as keyof typeof ventilationTypeLabels];
  return label || type;
}

/** Return a human-readable volume line using roomVolumeM3.
 * Example: "Room volume: 90 m3"
 * Returns null if length, width, or height is not a valid positive number.
 */
export function getVolumeText(
  length: number,
  width: number,
  height: number,
  roomVolumeM3: (length: number, width: number, height: number) => number,
): string | null {
  try {
    const v = roomVolumeM3(length, width, height);
    return `Room volume: ${v} m3`;
  } catch {
    return null;
  }
}