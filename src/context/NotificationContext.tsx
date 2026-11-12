import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";
import { useRooms } from "./RoomsContext";
import {
  hasAnyReading,
  metricSeverity,
  type MetricKey,
  type SeverityLevel,
} from "../lib/thresholdConfig";
import type { Thresholds } from "../data/Data";
import type { AirNotification } from "../lib/notifications";

// ---------------------------------------------------------------------------
// User mailbox (existing public.notifications: approval, report_ready, etc.)
// ---------------------------------------------------------------------------

export interface Notification {
  id: number;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Sensor alerts (new air_notifications). RLS already scopes rows to
// admin / addressed personnel, so the client just reads what it can see.
// The detail drawer on /notifications does its own richer fetch; this context
// is only for the bell (latest ~10 + unread badge).
// ---------------------------------------------------------------------------

export interface BellAlertItem {
  id: number;
  device_id: string;
  room_name: string;
  floor: string;
  sensor_type: string;
  level_label: string;
  severity: string;
  reading_value: number | null;
  reading_unit: string;
  message: string;
  status: string;
  handled_by_id: string | null;
  handled_by_name: string | null;
  handled_by_role: string | null;
  handled_at: string | null;
  handled_action: string | null;
  created_at: string;
  resolved_at: string | null;
  isRead: boolean;
}

export interface LatestAction {
  id: number;
  notification_id: number;
  personnel_name: string;
  personnel_role: string;
  action: string;
  note: string | null;
  taken_at: string;
}

// Live alert: a warning/high/danger condition computed client-side from the
// SAME live readings + saved thresholds the dashboard grades with. The bell
// previously counted ONLY rows in air_notifications, which are created
// server-side by the air-alerts Edge Function via a readings webhook. When
// that webhook/function is not deployed (or has not fired yet) the dashboard
// can show a red DANGER banner while the bell badge stays at 0. Deriving
// these here keeps the bell in lock-step with the banner it sits next to.
export interface LiveBellAlert {
  id: string;
  device_id: string;
  room_name: string;
  floor: string;
  sensor_type: string;
  level_label: string;
  severity: string;
  reading_value: number | null;
  reading_unit: string;
  message: string;
  status: string;
  created_at: string;
  isLive: true;
  handled_by_name: string | null;
  handled_by_role: string | null;
  handled_at: string | null;
  handled_action: string | null;
  /** Server row was resolved but the live condition is still present. */
  stillPresent?: boolean;
}

interface NotificationsContextValue {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
  // Sensor alerts for the bell.
  alerts: BellAlertItem[];
  alertUnreadCount: number;
  alertsLoading: boolean;
  markAlertRead: (id: number) => Promise<void>;
  markAllAlertsRead: () => Promise<void>;
  // Live (client-derived) alerts — see LiveBellAlert above.
  liveAlerts: LiveBellAlert[];
  liveUnreadCount: number;
  /** Latest personnel action per saved alert id + recent actions across alerts. */
  latestActionByNotification: Record<number, LatestAction>;
  recentActions: LatestAction[];
  dismissLiveAlert: (id: string) => void;
  dismissAllLiveAlerts: () => void;
  /** unreadCount + alertUnreadCount + liveUnreadCount. */
  totalUnread: number;
  /** Any visible danger/critical alert (live or server) — drives pulsing. */
  hasDangerAlert: boolean;
}

function labelForLive(
  metric: MetricKey,
  level: SeverityLevel,
  value: number,
  th: Thresholds
): { level_label: string; severity: string; reading_unit: string } {
  if (metric === "co2") {
    if (level === "danger") return { level_label: "Danger", severity: "danger", reading_unit: "ppm" };
    if (level === "high") return { level_label: "High", severity: "high", reading_unit: "ppm" };
    return { level_label: "Warning", severity: "warning", reading_unit: "ppm" };
  }
  if (metric === "lpg") {
    if (level === "danger") return { level_label: "Critical", severity: "critical", reading_unit: "ppm" };
    if (level === "high") return { level_label: "Alarm", severity: "high", reading_unit: "ppm" };
    return { level_label: "Low Leak", severity: "warning", reading_unit: "ppm" };
  }
  if (metric === "temp") {
    if (level === "danger")
      return { level_label: value < th.temp.freezeBelow ? "Freeze" : "Heat", severity: "danger", reading_unit: "°C" };
    return { level_label: "Cool", severity: "warning", reading_unit: "°C" };
  }
  if (level === "danger")
    return { level_label: value < th.humidity.dryBelow ? "Dry" : "Mold Risk", severity: "danger", reading_unit: "% RH" };
  return { level_label: "Low", severity: "warning", reading_unit: "% RH" };
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, danger: 3, high: 2, warning: 1, info: 0 };

const NotificationsContext = createContext<NotificationsContextValue | undefined>(
  undefined
);

export function NotificationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();
  const { rooms, thresholds } = useRooms();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<BellAlertItem[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [dismissedLive, setDismissedLive] = useState<Set<string>>(new Set());
  const [latestActionByNotification, setLatestActionByNotification] = useState<Record<number, LatestAction>>({});
  const [recentActions, setRecentActions] = useState<LatestAction[]>([]);

  async function fetchNotifications() {
    if (!user) {
      setNotifications([]);
      setLoading(false);
      return;
    }
    try {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        if (error.code === "PGRST205" || /could not find the table/i.test(error.message)) {
            setNotifications([]);
        } else {
            console.error("Failed to fetch notifications:", error.message);
        }
      } else {
        setNotifications((data as Notification[]) ?? []);
      }
    } catch (err) {
      console.error("Unexpected error fetching notifications:", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const fetchAlerts = useCallback(async () => {
    if (!user) {
      setAlerts([]);
      setAlertsLoading(false);
      return;
    }
    try {
      const [{ data: rows, error }, { data: reads, error: readsError }, { data: actionRows }] = await Promise.all([
        supabase
          .from("air_notifications")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(10),
        supabase.from("notification_reads").select("notification_id").eq("user_id", user.id),
        supabase.from("notification_actions")
          .select("id, notification_id, personnel_name, personnel_role, action, note, taken_at")
          .order("taken_at", { ascending: false })
          .limit(30),
      ]);
if (error) {
        if (error.code === "PGRST205" || /could not find the table/i.test(error.message)) {
            setAlerts([]);
            setLatestActionByNotification({});
            setRecentActions([]);
            return;
        } else {
            console.error("Failed to fetch sensor alerts:", error.message);
        }
        setLatestActionByNotification({});
        setRecentActions([]);
      } else {
        if (readsError) console.error("Failed to fetch notification reads:", readsError.message);
        const readSet = new Set((reads ?? []).map((r: any) => Number(r.notification_id)));
        const acts = ((actionRows as LatestAction[]) ?? []).filter((a) => a.action !== "sms_sent");
        const byNotif: Record<number, LatestAction> = {};
        for (const a of acts) {
          if (!(a.notification_id in byNotif)) byNotif[a.notification_id] = a;
        }
        setLatestActionByNotification(byNotif);
        setRecentActions(acts.slice(0, 10));
        setAlerts(
          ((rows as AirNotification[]) ?? []).map((a) => {
            const latest = byNotif[a.id];
            return {
              ...a,
              handled_action: latest?.action ?? null,
              isRead: readSet.has(a.id),
            };
          })
        );
      }
    } catch (err) {
      console.error("Unexpected error fetching sensor alerts:", err instanceof Error ? err.message : String(err));
    } finally {
      setAlertsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchNotifications();
    fetchAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, fetchAlerts]);

  // Realtime: new mailbox notifications (e.g. an admin just approved someone)
  // appear instantly without a page refresh.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("notifications-live")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          setNotifications((prev) => {
            const next = [payload.new as Notification, ...prev];
            return next.slice(0, 50);
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  // Realtime: sensor alerts + actions (handled-by) update the bell live.
  useEffect(() => {
    if (!user) return;
    const refresh = () => { fetchAlerts(); };
    const channel = supabase
      .channel("air-alerts-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "air_notifications" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "notification_actions" }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, fetchAlerts]);

  // Polling fallback (~10s) for missed realtime events.
  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => { fetchAlerts(); fetchNotifications(); }, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, fetchAlerts]);

  async function markRead(id: number) {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("id", id)
      .eq("user_id", user?.id ?? "");
    if (!error) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n))
      );
    }
  }

  async function markAllRead() {
    if (!user) return;
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("user_id", user.id)
      .eq("read", false);
    if (!error) {
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    }
  }

  async function markAlertRead(id: number) {
    if (!user) return;
    await supabase.from("notification_reads").upsert(
      { notification_id: id, user_id: user.id, read_at: new Date().toISOString() },
      { onConflict: "notification_id,user_id" }
    );
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, isRead: true } : a)));
  }

  async function markAllAlertsRead() {
    if (!user) return;
    const unread = alerts.filter((a) => !a.isRead).map((a) => a.id);
    if (unread.length === 0) return;
    await supabase.from("notification_reads").upsert(
      unread.map((id) => ({ notification_id: id, user_id: user.id, read_at: new Date().toISOString() })),
      { onConflict: "notification_id,user_id" }
    );
    setAlerts((prev) => prev.map((a) => ({ ...a, isRead: true })));
  }

  const liveAlerts = useMemo<LiveBellAlert[]>(() => {
    if (!rooms.length) return [];
    const serverCovered = new Set(
      alerts.filter((a) => a.status !== "resolved").map((a) => `${a.device_id}:${a.sensor_type}`)
    );
    // Resolved server rows per device+sensor: if the live condition is still
    // present after a resolve, keep showing it labelled with who resolved it.
    const resolvedByKey = new Map<string, BellAlertItem>();
    for (const a of alerts) {
      if (a.status === "resolved") resolvedByKey.set(`${a.device_id}:${a.sensor_type}`, a);
    }
    const out: LiveBellAlert[] = [];
    const metrics: MetricKey[] = ["co2", "lpg", "temp", "humidity"];
    for (const room of rooms) {
      const readings = { co2: room.co2, lpg: room.lpg, temp: room.temp, humidity: room.humidity };
      if (!hasAnyReading(readings)) continue;
      for (const m of metrics) {
        const value = readings[m];
        if (value == null || !Number.isFinite(value)) continue;
        const level = metricSeverity(m, value, thresholds);
        if (level === "ok") continue;
        if (serverCovered.has(`${room.id}:${m}`)) continue;
        const { level_label, severity, reading_unit } = labelForLive(m, level, value, thresholds);
        const resolved = resolvedByKey.get(`${room.id}:${m}`);
        out.push({
          id: `live-${room.id}-${m}-${level}`,
          device_id: room.id,
          room_name: room.name,
          floor: room.floor,
          sensor_type: m,
          level_label,
          severity,
          reading_value: value,
          reading_unit,
          message: `${room.name} ${m.toUpperCase()} ${value} ${reading_unit} — ${level_label}`,
          status: "open",
          created_at: room.lastReadingAt ?? new Date().toISOString(),
          isLive: true,
          handled_by_name: resolved?.handled_by_name ?? null,
          handled_by_role: resolved?.handled_by_role ?? null,
          handled_at: resolved?.handled_at ?? null,
          handled_action: resolved?.handled_action ?? null,
          stillPresent: !!resolved?.handled_by_name,
        });
      }
      if (!room.online && room.lastReadingAt && !serverCovered.has(`${room.id}:device`)) {
        const age = Date.now() - new Date(room.lastReadingAt).getTime();
        if (age > 30_000) {
          const resolvedOffline = resolvedByKey.get(`${room.id}:device`);
          out.push({
            id: `live-${room.id}-device-offline`,
            device_id: room.id,
            room_name: room.name,
            floor: room.floor,
            sensor_type: "device",
            level_label: "Offline",
            severity: "warning",
            reading_value: null,
            reading_unit: "",
            message: `${room.name} device offline`,
            status: "open",
            created_at: room.lastReadingAt,
            isLive: true,
            handled_by_name: resolvedOffline?.handled_by_name ?? null,
            handled_by_role: resolvedOffline?.handled_by_role ?? null,
            handled_at: resolvedOffline?.handled_at ?? null,
            handled_action: resolvedOffline?.handled_action ?? null,
            stillPresent: !!resolvedOffline?.handled_by_name,
          });
        }
      }
    }
    return out.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
  }, [rooms, thresholds, alerts]);

  const visibleLiveAlerts = useMemo(
    () => liveAlerts.filter((a) => !dismissedLive.has(a.id)),
    [liveAlerts, dismissedLive]
  );

  const dismissLiveAlert = useCallback((id: string) => {
    setDismissedLive((prev) => new Set(prev).add(id));
  }, []);

  const dismissAllLiveAlerts = useCallback(() => {
    setDismissedLive((prev) => {
      const next = new Set(prev);
      visibleLiveAlerts.forEach((a) => next.add(a.id));
      return next;
    });
  }, [visibleLiveAlerts]);

  const unreadCount = notifications.filter((n) => !n.read).length;
  const alertUnreadCount = alerts.filter((a) => !a.isRead).length;
  const liveUnreadCount = visibleLiveAlerts.length;
  const totalUnread = unreadCount + alertUnreadCount + liveUnreadCount;
  const hasDangerAlert =
    visibleLiveAlerts.some((a) => a.severity === "danger" || a.severity === "critical") ||
    alerts.some((a) => !a.isRead && (a.severity === "danger" || a.severity === "critical"));

  return (
    <NotificationsContext.Provider
      value={{
        notifications,
        unreadCount,
        loading,
        markRead,
        markAllRead,
        refresh: fetchNotifications,
        alerts,
        alertUnreadCount,
        alertsLoading,
        markAlertRead,
        markAllAlertsRead,
        liveAlerts: visibleLiveAlerts,
        liveUnreadCount,
        latestActionByNotification,
        recentActions,
        dismissLiveAlert,
        dismissAllLiveAlerts,
        totalUnread,
        hasDangerAlert,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error(
      "useNotifications must be used within a NotificationsProvider"
    );
  }
  return ctx;
}
