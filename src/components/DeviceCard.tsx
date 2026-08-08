import { Maximize2, Users, Circle } from "lucide-react";
import type { IoTDevice } from "../types";
import { getCo2Severity, getLpgSeverity, getOverallSeverity, getSeverityBadgeLabel } from "../lib/sensorThresholds";

interface DeviceCardProps {
  device: IoTDevice;
  onSetStatus?: (id: string, status: "online" | "offline") => void;
  onRemove?: (id: string) => void;
  canToggle?: boolean;
  canRemove?: boolean;
}

const BORDER_BY_SEVERITY: Record<string, string> = {
  normal: "border-l-emerald-400",
  elevated: "border-l-amber-400",
  danger: "border-l-red-500",
};

const BADGE_BY_SEVERITY: Record<string, string> = {
  elevated: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
};

export default function DeviceCard({
  device,
  onSetStatus,
  onRemove,
  canToggle = true,
  canRemove = true,
}: DeviceCardProps) {
  const { readings } = device;
  const overallSeverity = getOverallSeverity(readings);
  const badgeLabel = getSeverityBadgeLabel(overallSeverity);
  const isOnline = device.connectionStatus === "online";

  return (
    <div
      className={`bg-white rounded-xl border border-slate-200 border-l-4 ${BORDER_BY_SEVERITY[overallSeverity]} p-4 flex flex-col gap-3`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-wide text-slate-400">{device.floor.toUpperCase()}</p>
          <h3 className="text-sm font-semibold text-slate-900 mt-0.5 truncate">{device.roomName}</h3>
        </div>
        <span className="text-[11px] text-slate-400 font-medium shrink-0">{device.id}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {device.hasCo2Sensor && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600">
            CO2: {device.co2SensorModel}
          </span>
        )}
        {device.hasLpgSensor && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600">
            Gas: {device.lpgSensorModel}
          </span>
        )}
        {badgeLabel && (
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-md ${BADGE_BY_SEVERITY[overallSeverity]}`}>
            {badgeLabel}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
        <span className="flex items-center gap-1">
          <Maximize2 className="w-3 h-3" />
          {device.dimensions.lengthM}m x {device.dimensions.widthM}m x {device.dimensions.heightM}m ·{" "}
          {device.dimensions.lengthM * device.dimensions.widthM * device.dimensions.heightM} m3
        </span>
        <span className="flex items-center gap-1">
          <Users className="w-3 h-3" />
          {device.occupants} occupants
        </span>
      </div>

      <div className="space-y-1.5 pt-1 border-t border-slate-100">
        <div className="flex items-center justify-between text-xs gap-2">
          <span className="text-slate-500">CO2 Reading:</span>
          <span
            className={`font-semibold text-right ${
              getCo2Severity(readings.co2Ppm) === "danger"
                ? "text-red-600"
                : getCo2Severity(readings.co2Ppm) === "elevated"
                ? "text-amber-600"
                : "text-slate-800"
            }`}
          >
            {readings.co2Ppm !== null ? `${readings.co2Ppm} ppm` : "N/A (no CO2 sensor)"}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs gap-2">
          <span className="text-slate-500">LPG Gas Reading:</span>
          <span
            className={`font-semibold text-right ${
              getLpgSeverity(readings.lpgPpm) === "danger"
                ? "text-red-600"
                : getLpgSeverity(readings.lpgPpm) === "elevated"
                ? "text-amber-600"
                : "text-slate-800"
            }`}
          >
            {readings.lpgPpm !== null ? `${readings.lpgPpm} ppm` : "N/A (no gas sensor)"}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs gap-2">
          <span className="text-slate-500">Temp / Humidity:</span>
          <span className="font-semibold text-slate-800 text-right">
            {readings.temperatureC}°C / {readings.humidityPct}%
          </span>
        </div>
      </div>

      {canToggle && onSetStatus ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={() => onSetStatus(device.id, "online")}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              isOnline ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
            }`}
          >
            Online
          </button>
          <button
            onClick={() => onSetStatus(device.id, "offline")}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              !isOnline ? "border-slate-300 bg-slate-100 text-slate-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
            }`}
          >
            Offline
          </button>
          {canRemove && onRemove && (
            <button
              onClick={() => onRemove(device.id)}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors sm:ml-auto"
            >
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 pt-1">
          <Circle
            className={`w-2 h-2 ${isOnline ? "text-emerald-500 fill-emerald-500" : "text-slate-300 fill-slate-300"}`}
          />
          <span className="text-xs font-medium text-slate-500">{isOnline ? "Online" : "Offline"}</span>
        </div>
      )}
    </div>
  );
}