import { AlertTriangle, VolumeX, Volume2 } from "lucide-react";
import { useDangerAlarm } from "../hooks/useDangerAlarm";

interface DangerAlarmBannerProps {
  isDanger: boolean;
}

export default function DangerAlarmBanner({ isDanger }: DangerAlarmBannerProps) {
  const { isMuted, toggleMute } = useDangerAlarm(isDanger);

  if (!isDanger) return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-red-600 text-white px-4 py-3 rounded-xl mb-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-5 h-5 shrink-0" />
        <span className="font-semibold text-sm">
          DANGER — gas levels exceed safe limits in one or more rooms
        </span>
      </div>
      <button
        onClick={toggleMute}
        className="flex items-center gap-1.5 shrink-0 bg-white/15 hover:bg-white/25 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
      >
        {isMuted ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
        {isMuted ? "Unmute Alarm" : "Mute Alarm"}
      </button>
    </div>
  );
}
