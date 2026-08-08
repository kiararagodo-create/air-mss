import { AlertTriangle, Radio, ServerCog } from "lucide-react";
import { useDevices } from "../../context/DeviceContext";
import { getOverallSeverity } from "../../lib/sensorThresholds";

// Shared overview for security and maintenance. Same component for both
// roles - if their screenshots turn out to need different content per
// role, split this the same way AdminDashboardPage is split out.
export default function StaffDashboardPage() {
  const { devices } = useDevices();
  const onlineCount = devices.filter((d) => d.connectionStatus === "online").length;
  const alertCount = devices.filter((d) => getOverallSeverity(d.readings) !== "normal").length;

  const stats = [
    { label: "Registered devices", value: devices.length, icon: ServerCog },
    { label: "Online now", value: onlineCount, icon: Radio },
    { label: "Active alerts", value: alertCount, icon: AlertTriangle },
  ];

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Monitoring Dashboard</h1>
        <p className="text-sm text-slate-500 mt-0.5">Campus-wide air quality summary</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {stats.map(({ label, value, icon: Icon }) => (
          <div key={label} className="bg-white rounded-xl border border-slate-200 p-4">
            <Icon className="w-4 h-4 text-teal-600 mb-2" />
            <p className="text-2xl font-semibold text-slate-900">{value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      <p className="text-sm text-slate-400">
        Send over the security/maintenance dashboard screenshot and this page will be rebuilt to match it exactly.
      </p>
    </>
  );
}
