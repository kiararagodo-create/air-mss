import { AlertTriangle, Clock, MessageCircle, ShieldAlert } from "lucide-react";

export type StatKey = "open" | "unhandled" | "sms_sent" | "smsSkipped";

export interface SummaryStats {
  open: number;
  unhandled: number;
  sms_sent: number;
  smsSkipped: number;
}

interface Props {
  stats: SummaryStats;
  active: StatKey | null;
  onSelect: (kind: StatKey) => void;
}

const CARDS: { key: StatKey; label: string; icon: typeof AlertTriangle; tone: string }[] = [
  { key: "open", label: "Open alerts", icon: AlertTriangle, tone: "text-red-600" },
  { key: "unhandled", label: "Unhandled > 10 min", icon: Clock, tone: "text-amber-600" },
  { key: "sms_sent", label: "Automatic SMS sent (24h)", icon: MessageCircle, tone: "text-teal-600" },
  { key: "smsSkipped", label: "SMS skipped (24h)", icon: ShieldAlert, tone: "text-slate-500" },
];

export default function SummaryStrip({ stats, active, onSelect }: Props) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {CARDS.map(({ key, label, icon: Icon, tone }) => {
        const value = stats[key];
        const isActive = active === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            aria-pressed={isActive}
            className={`rounded-xl border bg-white px-3.5 py-3 text-left transition-colors motion-reduce:transition-none hover:border-teal-300 ${
              isActive ? "border-teal-400 ring-1 ring-teal-200" : "border-slate-200"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <Icon size={14} className={tone} />
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
            </div>
            <div className="mt-1 text-[22px] font-extrabold leading-none text-slate-900">{value}</div>
          </button>
        );
      })}
    </div>
  );
}
