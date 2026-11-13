import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell, CheckCheck, FileBarChart2, Loader2, X, BellRing, Volume2, VolumeX,
} from "lucide-react";
import { useNotifications } from "../context/NotificationContext";
import { useAlarm, MUTE_SNOOZE_MINUTES } from "../context/AlarmContext";
import { useRooms } from "../context/RoomsContext";
import {
  ACTION_LABEL, handledByLine, SENSOR_LABEL, relativeTime, SEVERITY_TONE,
  type AirSeverity, type SensorType,
} from "../lib/notifications";
import AlertActionBar from "./AlertActionBar";
import { Badge } from "../ui";

export default function NotificationBell() {
  const {
    notifications, loading, markRead, markAllRead,
    alerts, alertsLoading, markAlertRead, markAllAlertsRead,
    liveAlerts, dismissLiveAlert, dismissAllLiveAlerts,
    recentActions,
    totalUnread, hasDangerAlert,
  } = useNotifications();
  const { setSelectedId } = useRooms();
  const { muteAll, unmuteAll, muteAllActive } = useAlarm();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 8 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  const openAlertCount = alerts.filter((a) => a.status === "open").length;

  function place() {
    const el = btnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth * 0.92);
    setPos({
      top: rect.bottom + 8,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    });
  }

  useEffect(() => {
    if (!open) return;
    place();
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  function gotoAlert(id: number) {
    markAlertRead(id);
    setOpen(false);
    navigate(`/notifications?id=${id}`);
  }

  function gotoLive(deviceId: string) {
    setSelectedId(deviceId);
    setOpen(false);
    navigate("/dashboard");
  }

  async function onMarkAll() {
    dismissAllLiveAlerts();
    await Promise.all([markAllRead(), markAllAlertsRead()]);
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => { setOpen((o) => !o); }}
        aria-label={`Notifications${totalUnread > 0 ? ` (${totalUnread} unread)` : ""}`}
        className={`relative w-9 h-9 rounded-lg border flex items-center justify-center hover:bg-slate-50 ${
          hasDangerAlert
            ? "border-red-300 bg-red-50 text-red-600"
            : totalUnread > 0
            ? "border-red-200 bg-red-50/60 text-red-600"
            : "border-slate-200 text-slate-600"
        }`}
      >
        <Bell className={`w-4 h-4 ${hasDangerAlert ? "animate-pulse" : ""}`} />
        {totalUnread > 0 && (
          <>
            {hasDangerAlert && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-400 animate-ping" aria-hidden="true" />
            )}
            <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-bold border-2 border-white shadow flex items-center justify-center z-10">
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          </>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            className="fixed w-[min(360px,92vw)] rounded-xl border border-slate-200 bg-white shadow-xl z-50 overflow-hidden"
            style={{ top: pos.top, left: pos.left }}
            role="dialog"
            aria-label="Notifications"
          >
            <div className="border-b border-slate-100">
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                  <BellRing className="w-4 h-4 text-teal-700" />
                  Notifications
                </span>
                {totalUnread > 0 && (
                  <button onClick={onMarkAll} className="text-[11px] font-medium text-teal-700 hover:text-teal-800 flex items-center gap-1">
                    <CheckCheck className="w-3 h-3" />
                    Mark all as read
                  </button>
                )}
              </div>
              {(openAlertCount > 0 || muteAllActive) && (
                <div className="px-4 pb-3">
                  <button
                    onClick={muteAllActive ? unmuteAll : muteAll}
                    title={muteAllActive ? "Unmute" : `Mute all for ${MUTE_SNOOZE_MINUTES} minutes`}
                    aria-label={muteAllActive ? "Unmute" : `Mute all for ${MUTE_SNOOZE_MINUTES} minutes`}
                    aria-pressed={muteAllActive}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                  >
                    {muteAllActive ? <VolumeX className="w-3.5 h-3.5" aria-hidden="true" /> : <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />}
                    {muteAllActive ? "Unmute all" : `Mute all for ${MUTE_SNOOZE_MINUTES} minutes`}
                  </button>
                </div>
              )}
            </div>

            <div className="max-h-[55vh] overflow-y-auto">
              {(loading && alertsLoading) ? (
                <div className="px-4 py-8 flex items-center justify-center gap-2 text-slate-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading…
                </div>
              ) : alerts.length === 0 && liveAlerts.length === 0 && notifications.length === 0 ? (
                <div className="px-4 py-8 text-center text-slate-400 text-sm">No notifications yet.</div>
              ) : (
                <>
                  {liveAlerts.length > 0 && (
                    <div className="px-4 pt-2 pb-1 text-[10px] font-bold tracking-wide text-red-500 uppercase flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />
                      Live alerts — act now
                    </div>
                  )}
                  {liveAlerts.map((a) => (
                    <AlertRow
                      key={a.id}
                      a={{
                        id: 0, room_name: a.room_name, floor: a.floor, sensor_type: a.sensor_type,
                        level_label: a.level_label, severity: a.severity, reading_value: a.reading_value,
                        reading_unit: a.reading_unit, status: a.status,
                        handled_by_name: a.handled_by_name, handled_by_role: a.handled_by_role,
                        handled_at: a.handled_at, handled_action: a.handled_action,
                        stillPresent: a.stillPresent,
                        created_at: a.created_at, isRead: false,
                        saturationNote: (a as any).saturationNote,
                      }}
                      liveRef={{ live: { device_id: a.device_id, room_name: a.room_name, floor: a.floor, sensor_type: a.sensor_type, level_label: a.level_label, severity: a.severity, reading_value: a.reading_value, reading_unit: a.reading_unit, message: a.message } }}
                      onClick={() => gotoLive(a.device_id)}
                      onRead={() => dismissLiveAlert(a.id)}
                    />
                  ))}
                  {alerts.length > 0 && (
                    <div className="px-4 pt-2 pb-1 text-[10px] font-bold tracking-wide text-slate-400 uppercase">Sensor alerts</div>
                  )}
                  {alerts.map((a) => (
                    <AlertRow
                      key={`a-${a.id}`}
                      a={a}
                      notificationId={a.id}
                      onClick={() => gotoAlert(a.id)}
                      onRead={() => markAlertRead(a.id)}
                    />
                  ))}
                  {recentActions.length > 0 && (
                    <>
                      <div className="px-4 pt-2 pb-1 text-[10px] font-bold tracking-wide text-slate-400 uppercase">Recent actions</div>
                      {recentActions.slice(0, 3).map((act) => {
                        const target = alerts.find((x) => x.id === act.notification_id);
                        const label = ACTION_LABEL[(act.action as import("../lib/notifications").AlertAction)] ?? act.action.replace("_", " ");
                        return (
                          <div key={act.id} className="px-4 py-2 border-b border-slate-50 text-[11px] text-slate-600">
                            <b>{act.personnel_name}</b> took action: <span className="font-semibold text-slate-800">{label}</span>
                            {target ? ` - ${target.room_name} ${target.sensor_type.toUpperCase()}` : ""}
                            <span className="text-slate-400"> · {relativeTime(act.taken_at)}</span>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {notifications.length > 0 && (
                    <div className="px-4 pt-2 pb-1 text-[10px] font-bold tracking-wide text-slate-400 uppercase">Messages</div>
                  )}
                  {notifications.slice(0, 5).map((n) => (
                    <MailboxRow
                      key={n.id}
                      n={n}
                      onRead={() => markRead(n.id)}
                      onOpen={() => { markRead(n.id); setOpen(false); navigate(n.kind === "report_ready" ? "/reports" : "/notifications"); }}
                    />
                  ))}
                </>
              )}
            </div>

            <button
              onClick={() => { setOpen(false); navigate("/notifications"); }}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border-t border-slate-100 text-xs font-semibold text-teal-700 hover:bg-slate-50"
            >
              <BellRing className="w-3.5 h-3.5" />
              View all notifications
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface AlertRowProps {
  a: {
    id: number; room_name: string; floor: string; sensor_type: string;
    level_label: string; severity: string; reading_value: number | null;
    reading_unit: string; status: string; handled_by_name: string | null;
    handled_by_role: string | null; handled_at: string | null;
    handled_action?: string | null; stillPresent?: boolean;
    created_at: string; isRead: boolean; saturationNote?: string | null;
  };
  notificationId?: number;
  liveRef?: import("../lib/alertActions").AlertRef;
  onClick: () => void;
  onRead: () => void;
}

function AlertRow({ a, notificationId, liveRef, onClick, onRead }: AlertRowProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const tone = SEVERITY_TONE[(a.severity as AirSeverity) || "warning"];
  const isCritical = a.severity === "danger" || a.severity === "critical";
  const sensor = SENSOR_LABEL[(a.sensor_type as SensorType) || "device"] ?? a.sensor_type;
  const outOfRange = a.reading_value != null && ((a.sensor_type === "co2" && (a.reading_value < 0 || a.reading_value > 10000)) || (a.sensor_type === "lpg" && (a.reading_value < 0 || a.reading_value > 10000)) || (a.sensor_type === "temp" && (a.reading_value < -40 || a.reading_value > 80)) || (a.sensor_type === "humidity" && (a.reading_value < 0 || a.reading_value > 100)));
  const reading = outOfRange ? "Sensor error" : a.reading_value != null ? `${a.sensor_type === "temp" ? a.reading_value.toFixed(1) : Math.round(a.reading_value)} ${a.reading_unit}` : a.level_label === "Offline" ? "no recent reading" : "—";
  const handled = handledByLine(a as any);
  const sat = a.saturationNote ?? ((a.sensor_type === "co2" && a.reading_value != null && a.reading_value >= 5000) ? "At sensor max (5000 ppm)" : null);

  return (
    <div
      className={`px-4 py-3 border-b border-slate-50 flex items-start gap-2.5 cursor-pointer ${
        isCritical ? "bg-red-50/70 border-l-2 border-l-red-500" : a.isRead ? "bg-white" : "bg-teal-50/40"
      }`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}
    >
      <span
        className="mt-1.5 w-2 h-2 rounded-full shrink-0"
        style={{ background: tone === "danger" ? "#dc2626" : tone === "high" ? "#EA6C2E" : tone === "warning" ? "#d97706" : tone === "success" ? "#0d9488" : "#94a3b8" }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge label={a.level_label} tone={tone} />
          {!a.isRead && <span className="w-1.5 h-1.5 rounded-full bg-teal-600 shrink-0" />}
          <p className={`text-xs truncate ${a.isRead ? "text-slate-500" : "text-slate-800 font-semibold"}`}>
            {a.room_name}{a.floor ? ` · ${a.floor}` : ""}
          </p>
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">{sensor} · {reading}</p>
        {sat && <p className="text-[10px] text-amber-700 mt-0.5">{sat}</p>}
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <p className="text-[10px] text-slate-400">{relativeTime(a.created_at)}</p>
          <span className={`text-[10px] font-medium ${handled.unhandled ? "text-red-600 font-bold" : a.handled_by_name ? "text-teal-700" : "text-slate-400"}`}>
            {a.stillPresent && a.handled_by_name ? `Resolved by ${a.handled_by_name} - condition still present` : handled.text}
          </span>
        </div>
        {(notificationId != null || liveRef) && (
          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
            <AlertActionBar
              ref_={liveRef ?? { notificationId }}
              sensorType={a.sensor_type}
              levelLabel={a.level_label}
              compact
            />
          </div>
        )}
      </div>
      <button onClick={(e) => { e.stopPropagation(); if (!a.isRead) onRead(); setDismissed(true); }} aria-label="Dismiss" className="text-slate-300 hover:text-slate-500 shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function MailboxRow({ n, onRead, onOpen }: { n: any; onRead: () => void; onOpen: () => void }) {
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  const isReport = n.kind === "report_ready";
  return (
    <div className={`px-4 py-3 border-b border-slate-50 flex items-start gap-2.5 ${n.read ? "bg-white" : "bg-teal-50/40"}`}>
      <button onClick={onOpen} className="flex-1 text-left min-w-0">
        <div className="flex items-center gap-1.5">
          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-teal-600 shrink-0" />}
          <p className={`text-xs truncate ${n.read ? "text-slate-500" : "text-slate-800 font-semibold"}`}>{n.title}</p>
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{n.body}</p>
        <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
          {isReport && <FileBarChart2 className="w-3 h-3" />}
          {new Date(n.created_at).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
          {isReport && " · Reports"}
        </p>
      </button>
      <button onClick={() => { onRead(); setClosed(true); }} aria-label="Dismiss notification" className="text-slate-300 hover:text-slate-500 shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
