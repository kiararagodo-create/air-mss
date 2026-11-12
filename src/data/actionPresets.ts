export type ActionPreset = string;

export const ACTION_PRESETS = {
  acknowledge: [
    "Alert received, checking the room",
    "Noted, will monitor the reading",
    "Other…",
  ] as const,
  on_my_way: [
    "Heading to the room now",
    "Technician dispatched",
    "Other…",
  ] as const,
  resolved: [
    "Ventilated the room, reading back to normal",
    "Closed the gas valve and ventilated the area",
    "Cleared the sensor area, reading normal",
    "Reading returned to normal on its own",
    "Other…",
  ] as const,
  false_alarm: [
    "Cooking or steam near the sensor",
    "Sensor reading spike, no actual hazard found",
    "Sensor warm-up or calibration",
    "Other…",
  ] as const,
  repaired: [
    "Replaced sensor",
    "Reconnected wiring / power",
    "Restored Wi-Fi connection",
    "Restarted device",
    "Other…",
  ] as const,
} as const;

export type ActionPresets = typeof ACTION_PRESETS;

export const hasOtherOption = (action: keyof ActionPresets) => {
  const presets = ACTION_PRESETS[action];
  return presets[presets.length - 1] === "Other…";
};

export const isOtherOption = (preset: ActionPreset | undefined) =>
  preset === "Other…";