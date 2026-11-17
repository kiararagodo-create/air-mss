import {
  roomVolumeM3,
  maxOccupants,
  OCCUPANCY_TARGET_COMFORT_PPM,
  OCCUPANCY_TARGET_LIMIT_PPM,
} from "../lib/co2Occupancy";
import { ventilationTypeLabels } from "../lib/ventilationConfig";
import { type Room } from "../data/Data";

const OUTDOOR_CO2_PPM = 420;
const CO2_GENERATION_M3_PER_H = 0.018; // per person, same value the tests use
const ASSUMED_ACH = 0.5;

const validDim = (n: number | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

const fmtPpm = (n: number) => n.toLocaleString("en-US") + " ppm";

interface OccupancyEstimatorCardProps {
  room: Room;
}

function peopleLabel(n: number): string {
  return n === 1 ? "1 person" : n + " people";
}

export function OccupancyEstimatorCard({ room }: OccupancyEstimatorCardProps) {
  const dimsOk = validDim(room.length) && validDim(room.width) && validDim(room.height);
  const volume = dimsOk ? roomVolumeM3(room.length, room.width, room.height) : undefined;

  const manualAch =
    typeof room.ventilationAch === "number" &&
    Number.isFinite(room.ventilationAch) &&
    room.ventilationAch >= 0
      ? room.ventilationAch
      : undefined;
  const canAssume = room.ventilationType === "window_ac" || room.ventilationType === "split_ac";

  let ach: number | undefined;
  let sourceLabel = "";
  if (manualAch !== undefined) {
    ach = manualAch;
    sourceLabel = "Manual";
  } else if (canAssume) {
    ach = ASSUMED_ACH;
    sourceLabel = "Assumed " + ASSUMED_ACH + " ACH, not measured";
  }

  const duration =
    typeof room.occupancyDurationHours === "number" && room.occupancyDurationHours > 0
      ? room.occupancyDurationHours
      : 2;

  let comfortable: number | undefined;
  let upperLimit: number | undefined;
  if (volume !== undefined && ach !== undefined) {
    try {
      comfortable = maxOccupants(
        OUTDOOR_CO2_PPM, OCCUPANCY_TARGET_COMFORT_PPM, volume, ach,
        CO2_GENERATION_M3_PER_H, OUTDOOR_CO2_PPM, duration,
      ).occupants;
      upperLimit = maxOccupants(
        OUTDOOR_CO2_PPM, OCCUPANCY_TARGET_LIMIT_PPM, volume, ach,
        CO2_GENERATION_M3_PER_H, OUTDOOR_CO2_PPM, duration,
      ).occupants;
    } catch {
      comfortable = undefined;
      upperLimit = undefined;
    }
  }

  const typeLabel = room.ventilationType
    ? (ventilationTypeLabels as Record<string, string>)[room.ventilationType] ?? "Not set"
    : "Not set";
  const achLine =
    manualAch !== undefined ? manualAch + " air changes per hour" : "Outdoor airflow unknown";
  const volumeText = volume !== undefined ? volume + " m\u00b3" : "Not set";
  const dimsText = dimsOk
    ? room.length + " \u00d7 " + room.width + " \u00d7 " + room.height + " meters"
    : "Not set";

  return (
    <div className="w-full max-w-full rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <p className="text-xs uppercase text-slate-500">
        {(room.name ?? "") + " \u00b7 " + (room.floor ?? "")}
      </p>
      <h3 className="mt-1 text-sm font-medium text-slate-800">{"CO\u2082 Occupancy Estimator"}</h3>

      <div className="grid grid-cols-2 gap-3 py-2">
        <div>
          <p className="text-xs font-medium text-slate-500">Room volume</p>
          <p className="mt-0.5 text-sm font-bold text-slate-700">{volumeText}</p>
          <p className="mt-0.5 text-xs text-slate-400">{dimsText}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-slate-500">Ventilation</p>
          <p className="mt-0.5 text-sm font-bold text-slate-700">{typeLabel}</p>
          <p className="mt-0.5 text-xs text-slate-400">{achLine}</p>
        </div>
      </div>

      <div className="mt-1 rounded border border-slate-200 bg-slate-50 p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-slate-500">Estimated occupant capacity</p>
          <span
            className={
              comfortable !== undefined
                ? "rounded bg-teal-100 px-1.5 py-0.5 text-xs text-teal-800"
                : "rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500"
            }
          >
            {comfortable !== undefined ? "Estimated" : "Not determined"}
          </span>
        </div>
        {comfortable !== undefined && upperLimit !== undefined ? (
          <div className="mt-1">
            <p className="text-lg font-bold text-slate-800">
              {"Comfortable capacity: " + peopleLabel(comfortable)}
            </p>
            <p className="text-sm text-slate-600">{"Upper limit: " + peopleLabel(upperLimit)}</p>
            <p className="mt-1 text-xs text-slate-500">
              {sourceLabel + ". " + duration + "-hour scenario, starting from outdoor-air CO\u2082."}
            </p>
          </div>
        ) : (
          <p className="mt-1 text-xs text-slate-500">
            {volume === undefined
              ? "Set the room length, width and height to calculate capacity."
              : "Configure measured or explicitly assumed outdoor-air ventilation to calculate a " +
                duration + "-hour CO\u2082 scenario."}
          </p>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <p className="text-xs text-slate-500">Planning target (comfort)</p>
        <p className="text-right text-xs font-bold text-slate-700">{fmtPpm(OCCUPANCY_TARGET_COMFORT_PPM)}</p>
        <p className="text-xs text-slate-500">Planning target (upper limit)</p>
        <p className="text-right text-xs font-bold text-slate-700">{fmtPpm(OCCUPANCY_TARGET_LIMIT_PPM)}</p>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Planning targets for the occupancy estimate. Live alert levels are set in Settings.
      </p>
    </div>
  );
}