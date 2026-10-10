import { useState } from "react";
import { Link } from "react-router-dom";
import { Bell, CheckCheck, FileBarChart2, Loader2, X } from "lucide-react";
import { useNotifications, type Notification } from "../context/NotificationContext";

/**
 * In-app notification bell.
 *
 * This is how the user learns that a monthly report finished generating while
 * they had the app closed - the archive job runs on the server on a schedule,
 * so there is no browser event to react to. It reads the `notifications` table
 * through NotificationContext, which is already subscribed to Postgres
 * realtime, so a report that finishes while the app is open appears
 * immediately without a refresh.
 */
export default function NotificationBell() {
  const { notifications, unreadCount, loading, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        className="relative w-9 h-9 rounded-lg border border-slate-200 flex items-center justify-center text-slate-600 hover:bg-slate-50"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 mt-2 w-80 max-w-[90vw] rounded-xl border border-slate-200 bg-white shadow-lg z-50 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <span className="text-sm font-semibold text-slate-800">Notifications</span>
              {unreadCount > 0 && (
                <button
                  onClick={() => markAllRead()}
                  className="text-[11px] font-medium text-teal-700 hover:text-teal-800 flex items-center gap-1"
                >
                  <CheckCheck className="w-3 h-3" />
                  Mark all read
                </button>
              )}
            </div>

            <div className="max-h-80 overflow-y-auto">
              {loading ? (
                <div className="px-4 py-8 flex items-center justify-center gap-2 text-slate-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading…
                </div>
              ) : notifications.length === 0 ? (
                <div className="px-4 py-8 text-center text-slate-400 text-sm">
                  No notifications yet.
                </div>
              ) : (
                notifications.map((n) => (
                  <NotificationRow
                    key={n.id}
                    n={n}
                    onRead={() => markRead(n.id)}
                  />
                ))
              )}
            </div>

            <Link
              to="/reports"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-2 px-4 py-2.5 border-t border-slate-100 text-xs font-semibold text-teal-700 hover:bg-slate-50"
            >
              <FileBarChart2 className="w-3.5 h-3.5" />
              Go to Reports
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function NotificationRow({ n, onRead }: { n: Notification; onRead: () => void }) {
  const [closed, setClosed] = useState(false);
  if (closed) return null;

  const isReport = n.kind === "report_ready";

  return (
    <div
      className={`px-4 py-3 border-b border-slate-50 flex items-start gap-2.5 ${
        n.read ? "bg-white" : "bg-teal-50/40"
      }`}
    >
      <button
        onClick={() => {
          if (!n.read) onRead();
          setClosed(true);
        }}
        className="flex-1 text-left min-w-0"
      >
        <div className="flex items-center gap-1.5">
          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-teal-600 shrink-0" />}
          <p
            className={`text-xs truncate ${n.read ? "text-slate-500" : "text-slate-800 font-semibold"}`}
          >
            {n.title}
          </p>
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{n.body}</p>
        <p className="text-[10px] text-slate-400 mt-1">
          {new Date(n.created_at).toLocaleString("en-PH", {
            timeZone: "Asia/Manila",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
          {isReport && " · Reports"}
        </p>
      </button>
      <button
        onClick={() => setClosed(true)}
        aria-label="Dismiss notification"
        className="text-slate-300 hover:text-slate-500 shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}