import DeviceCard from "../../components/DeviceCard";
import SensorSpecCard from "../../components/SensorSpecCard";
import { SENSOR_INFO } from "../../data/Data";
import type { SensorInfo } from "../../data/Data";
import { useDevices } from "../../context/DeviceContext";
import { useAuth } from "../../context/AuthContext";
import { getPermissions } from "../../lib/permissions";
import type { UserRole, SensorSpec } from "../../types";

// Shared by security and maintenance - same layout for both, but the
// permission flags decide what's interactive. Maintenance can flip a
// device Online/Offline; security gets a read-only status pill. Neither
// can add or remove devices, and there's no "Add New IoT Device" button
// (that stays admin-only). Send the real screenshot and this gets rebuilt
// to match it exactly, keeping the same permission wiring underneath.
export default function StaffDevicesPage() {
  const { devices, setDeviceStatus } = useDevices();
  const { role } = useAuth();
  const permissions = role ? getPermissions(role as UserRole) : null;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">IoT Sensor Node Registry</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          {permissions?.canToggleDevice
            ? "View and toggle air monitoring hardware across Asian College campus"
            : "Monitor air monitoring hardware across Asian College campus"}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-10">
        {devices.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            onSetStatus={permissions?.canToggleDevice ? setDeviceStatus : undefined}
            canToggle={permissions?.canToggleDevice ?? false}
            canRemove={false}
          />
        ))}
        {devices.length === 0 && (
          <p className="text-sm text-slate-400 col-span-full text-center py-10">No devices registered yet.</p>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Hardware Sensor Technical Reference</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {SENSOR_INFO.map((info: SensorInfo) => {
            const spec: SensorSpec = {
              model: info.id as SensorSpec["model"],
              displayName: info.title,
              description: info.body,
              gasesMonitored: info.gases,
              sensingRange: info.range,
              accuracyRating: info.accuracy,
              keySpecs: info.specs,
            };
            return (
            <SensorSpecCard key={spec.model} spec={spec} />
            );
          })}
        </div>
      </div>
    </>
  );
}
