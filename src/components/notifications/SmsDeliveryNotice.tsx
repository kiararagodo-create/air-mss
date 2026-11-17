import { useState } from "react";
import { AlertTriangle, ChevronDown, Info, X } from "lucide-react";
import { manilaTime } from "../../lib/notifications";
import { skipStatusLabel, type SmsSkipSummary } from "../../lib/smsAutoSettings";

interface Props {
  summary: SmsSkipSummary;
  expanded: boolean;
  onToggleExpanded: () => void;
  dismissed: boolean;
  onDismiss: () => void;
  onOpenAlert: (notificationId: number) => void;
}

const COLLAPSED_ROWS = 5;
const MAX_ROWS = 50;

/** One calm notice replacing the old yellow banner + red "Skipped SMS" panel. */
export default function SmsDeliveryNotice({
  summary,
  expanded,
  onToggleExpanded,
  dismissed,
  onDismiss,
  onOpenAlert,
}: Props) {
  const [showAll, setShowAll] = useState(false);

  if (summary.total === 0) return null;

  const danger = summary.danger > 0;
  if (dismissed && !danger) return null;

  const summaryText = `${summary.total} automatic SMS skipped in the last 24h: low credits ${summary.lowCredits} · rate limit ${summary.rateLimited} · auto SMS off ${summary.autoOff} · danger ${summary.danger}`;
  const visibleRows = expanded ? (showAll ? summary.rows.slice(0, MAX_ROWS) : summary.rows.slice(0, COLLAPSED_ROWS)) : [];

  const container = danger
    ? "border-red-200 bg-red-50 text-red-800"
    : "border-amber-200 bg-amber-50 text-amber-800";
  const subtle = danger ? "text-red-600" : "text-amber-600";

  return (
    <div role={danger ? "alert" : "status"} className={`mt-4 rounded-xl border px-4 py-3 text-[13px] ${container}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          {danger ? <AlertTriangle size={16} /> : <Info size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug">{danger ? summaryText : summaryText}</div>
          {danger && (
            <div className="mt-1 font-bold">
              {summary.danger} danger alert{summary.danger === 1 ? "" : "s"} were NOT texted. Top up your iProgSMS credits now.
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => {
                setShowAll(false);
                onToggleExpanded();
              }}
              aria-expanded={expanded}
              className={`inline-flex items-center gap-1 text-[12px] font-semibold underline-offset-2 hover:underline ${subtle}`}
            >
              {expanded ? "Hide details" : "Show details"}
              <ChevronDown size={13} className={`transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
            </button>
            {!danger && (
              <button
                type="button"
                onClick={onDismiss}
                className={`text-[12px] font-semibold underline-offset-2 hover:underline ${subtle}`}
              >
                Dismiss for this session
              </button>
            )}
          </div>

          {expanded && (
            <ul className="mt-2.5 space-y-1.5">
              {visibleRows.map((row) => (
                <li key={row.id} className="text-[12px] leading-snug">
                  <span className="font-semibold">{manilaTime(row.sent_at)}</span>
                  {" — "}
                  {skipStatusLabel(row.status)}
                  {row.room_name ? ` · ${row.room_name}` : ""}
                  {row.sensor_type ? ` · ${row.sensor_type}` : ""}
                  {row.provider_response ? ` · ${row.provider_response}` : ""}
                  {row.notification_id != null && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        onClick={() => onOpenAlert(row.notification_id as number)}
                        className={`font-semibold underline underline-offset-2 ${subtle}`}
                      >
                        open
                      </button>
                    </>
                  )}
                </li>
              ))}
              {summary.rows.length > COLLAPSED_ROWS && !showAll && (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className={`text-[12px] font-semibold underline underline-offset-2 ${subtle}`}
                  >
                    View all ({summary.rows.length})
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
        {!danger && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss SMS delivery notice"
            className="shrink-0 rounded-md p-1 hover:bg-black/5"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
