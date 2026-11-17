import { useState } from "react";
import { type VentilationType } from "../lib/ventilationConfig";
import { getVolumeText } from "../lib/ventilationConfig";
import { roomVolumeM3 } from "../lib/co2Occupancy";

interface VentilationFieldsProps {
  ventilationType: VentilationType | undefined;
  setVentilationType: (t: VentilationType | undefined) => void;
  ventilationAch: number | null | undefined;
  setVentilationAch: (a: number | null | undefined) => void;
  occupancyDurationHours: number | undefined;
  setOccupancyDurationHours: (d: number | undefined) => void;
  length: number | undefined;
  width: number | undefined;
  height: number | undefined;
  errors: string[];
  disabled: boolean;
}

export function VentilationFields({
  ventilationType,
  setVentilationType,
  ventilationAch,
  setVentilationAch,
  occupancyDurationHours,
  setOccupancyDurationHours,
  length,
  width,
  height,
  errors,
  disabled,
}: VentilationFieldsProps) {
  const [volumeVisible, setVolumeVisible] = useState(false);

  const volume = length !== undefined && width !== undefined && height !== undefined ? roomVolumeM3(length, width, height) : undefined;

  if (volume !== undefined) {
    setVolumeVisible(true);
  }

  return (
    <div className="space-y-4">
      {/* Ventilation Type Select */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Ventilation type
        </label>
        <select
          onChange={(e) => setVentilationType(e.target.value as VentilationType)}
          disabled={disabled}
          className={`block w-full rounded border border-slate-300 shadow-sm focus:ring-sky-500 focus:border-sky-500 sm:text-sm ${
            disabled ? "cursor-not-allowed opacity-50" : ""
          }`}
          value={ventilationType ?? "unknown"}
        >
          <option value="window_ac" disabled>
            -- Ventilation type --
          </option>
          <option value="window_ac">Window-type AC</option>
          <option value="split_ac">Split-type AC</option>
          <option value="central_ac_outdoor_air">
            Central AC with outdoor-air supply
          </option>
          <option value="natural">Natural ventilation</option>
          <option value="mechanical">Mechanical ventilation</option>
          <option value="unknown">Unknown</option>
        </select>
        {errors.length > 0 && (
          <p className="mt-1 text-xs text-red-600">{errors[0]}</p>
        )}
      </div>

      {/* ACH Number */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          ACH (outdoor air changes per hour)
        </label>
        <input
          type="number"
          step="0.1"
          onChange={(e) => {
            const num = Number(e.target.value);
            setVentilationAch(isNaN(num) ? undefined : num);
          }}
          disabled={disabled}
          className={`block w-full rounded border border-slate-300 shadow-sm focus:ring-sky-500 focus:border-sky-500 sm:text-sm ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
          placeholder="Leave blank if unknown"
          value={ventilationAch !== undefined ? String(ventilationAch) : ""}
        />
        {errors.length > 1 && (
          <p className="mt-1 text-xs text-red-600">{errors[1]}</p>
        )}
      </div>

      {/* Occupancy Duration */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Occupancy duration (hours)
        </label>
        <select
          onChange={(e) => setOccupancyDurationHours(Number(e.target.value))}
          disabled={disabled}
          className={`block w-full rounded border border-slate-300 shadow-sm focus:ring-sky-500 focus:border-sky-500 sm:text-sm ${
            disabled ? "cursor-not-allowed opacity-50" : ""
          }`}
          value={occupancyDurationHours !== undefined ? String(occupancyDurationHours) : "2"}
        >
          <option value="1">1 hour</option>
          <option value="2">2 hours</option>
          <option value="3">3 hours</option>
          <option value="4">4 hours</option>
          <option value="6">6 hours</option>
          <option value="8">8 hours</option>
        </select>
      </div>

      {/* Room volume helper (shown when dimensions are valid) */}
      {volumeVisible && (
        <div className="mt-2 p-3 bg-slate-50 rounded border border-slate-200">
          {getVolumeText(length ?? 6, width ?? 4, height ?? 3, roomVolumeM3)}
        </div>
      )}

      {/* Helper text */}
      <p className="mt-2 text-xs text-slate-500">
        AC type does not tell us how much outdoor air the room gets. Leave ACH blank
        unless it has been measured.
      </p>
    </div>
  );
}