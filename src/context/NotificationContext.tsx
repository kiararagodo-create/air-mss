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

export interface Notification {
  id: number;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}

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

// Live alert derived from the same readings/thresholds the dashboard uses.
// This keeps the bell/action plan live even if server-side alert creation is delayed/misconfigured.
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
  stillPresent?: boolean;
  saturationNote?: string | null;
}

interface NotificationsContextValue {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
  alerts: BellAlertItem[];
  alertUnreadCount: number;
  alertsLoading: boolean;
  markAlertRead: (id: number) => Promise<void>;
  markAllAlertsRead: () => Promise<void>;
  liveAlerts: LiveBellAlert[];
  liveUnreadCount: number;
  latestActionByNotification: Record<number, LatestAction>;
  recentActions: LatestAction[];
  dismissLiveAlert: (id: string) => void;
  dismissAllLiveAlerts: () => void;
  totalUnread: number;
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
    return { level_label: value < th.humidity.dryBelow ? "Dry" : "Mold Risk", severity: "danger", reading_unit: "%RH" };
  return { level_label: "Low", severity: "warning", reading_unit: "%RH" };
}

function formatLiveReading(sensor: string, value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  if (sensor === "temp") return `${value.toFixed(1)} °C`;
  if (sensor === "humidity") return `${Math.round(value)} %RH`;
  return `${Math.round(value)} ppm`;
}

function saturationNote(sensor: string, value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (sensor === "co2" && value >= 5000) return "At sensor max (5000 ppm)";
  if (sensor === "lpg" && value >= 10000) return "At sensor max (10000 ppm)";
  return null;
}

const NotificationsContext = createContext<NotificationsContextValue | undefined>(undefined);

export function NotificationsProvider({ children }: { children: ReactNode }) {
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
        supabase.from("air_notifications").select("*").order("created_at", { ascending: false }).limit(20),
        supabase.from("notification_reads").select("notification_id").eq("user_id", user.id),
        supabase.from("notification_actions")
          .select("id, notification_id, personnel_name, personnel_role, action, note, taken_at")
          .order("taken_at", { ascending: false })
          .limit(30),
      ]);
      if (error) {
        if (error.code === "PGRST205" || /could not find the table/i.test(error.message)) {
          setAlerts([]);
        } else {
          console.error("Failed to fetch sensor alerts:", error.message);
          setAlerts([]);
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
              handled_action: latest?.action ?? (a as any).handled_action ?? null,
              isRead: readSet.has(a.id),
            } as BellAlertItem;
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

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("notifications-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
        (payload) => { setNotifications((prev) => [payload.new as Notification, ...prev].slice(0, 50)); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const refresh = () => { fetchAlerts(); };
    const channel = supabase
      .channel("air-alerts-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "air_notifications" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "notification_actions" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "sms_logs" }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user?.id, fetchAlerts]);

  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => { fetchAlerts(); fetchNotifications(); }, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, fetchAlerts]);

  async function markRead(id: number) {
    const { error } = await supabase.from("notifications").update({ read: true }).eq("id", id).eq("user_id", user?.id ?? "");
    if (!error) setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }
  async function markAllRead() {
    if (!user) return;
    const { error } = await supabase.from("notifications").update({ read: true }).eq("user_id", user.id).eq("read", false);
    if (!error) setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
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
    // Prefer server alert rows when present (open). If no open server row exists for a room+sensor,
    // show a live alert so dashboard/bell/action plan stay in sync with the status card.
    const serverCovered = new Set(
      alerts.filter((a) => a.status !== "resolved").map((a) => `${a.device_id}:${a.sensor_type}`)
    );
    const resolvedByKey = new Map<string, BellAlertItem>();
    for (const a of alerts) {
      if (a.status === "resolved") resolvedByKey.set(`${a.device_id}:${a.sensor_type}`, a);
    }
    const out: LiveBellAlert[] = [];
    const metrics: MetricKey[] = ["co2", "lpg", "temp", "humidity"];
    for (const room of rooms) {
      const readings = { co2: room.co2, lpg: room.lpg, temp: room.temp, humidity: room.humidity };
      if (!hasAnyReading(readings)) continue;
      const allZero = readings.co2 === 0 && readings.lpg === 0 && readings.temp === 0 && readings.humidity === 0;
      if (allZero) continue; // likely sensor fault/disconnect
      for (const m of metrics) {
        const value = readings[m];
        if (value == null || !Number.isFinite(value)) continue;
        if (m === "co2" || m === "lpg") { if (value < 0 || value > 10000) continue; }
        if (m === "temp") { if (value < -40 || value > 80 || (value === 0 && readings.humidity === 0)) continue; }
        if (m === "humidity") { if (value < 0 || value > 100 || (value === 0 && readings.temp === 0)) continue; }
        const level = metricSeverity(m, value, thresholds);
        if (level === "ok") continue;
        if (serverCovered.has(`${room.id}:${m}`)) continue; // server alert already covers it
        const { level_label, severity, reading_unit } = labelForLive(m, level, value, thresholds);
        const resolved = resolvedByKey.get(`${room.id}:${m}`);
        const sat = saturationNote(m, value);
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
          message: `${room.name} ${m.toUpperCase()} ${formatLiveReading(m, value)} - ${level_label}${sat ? ` (${sat})` : ""}`,
          status: "open",
          created_at: room.lastReadingAt ?? new Date().toISOString(),
          isLive: true,
          handled_by_name: resolved?.handled_by_name ?? null,
          handled_by_role: resolved?.handled_by_role ?? null,
          handled_at: resolved?.handled_at ?? null,
          handled_action: resolved?.handled_action ?? null,
          stillPresent: !!resolved?.handled_by_name,
          saturationNote: sat,
        });
      }
      // Offline live alert (if no open server offline alert)
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
            message: `${room.name} sensor is offline (no recent reading).`,
            status: "open",
            created_at: room.lastReadingAt ?? new Date().toISOString(),
            isLive: true,
            handled_by_name: resolvedOffline?.handled_by_name ?? null,
            handled_by_role: resolvedOffline?.handled_by_role ?? null,
            handled_at: resolvedOffline?.handled_at ?? null,
            handled_action: resolvedOffline?.handled_action ?? null,
            stillPresent: !!resolvedOffline?.handled_by_name,
            saturationNote: null,
          });
        }
      }
    }
    out.sort((a, b) => {
      const rank = (s: string) => (s === "critical" ? 4 : s === "danger" ? 3 : s === "high" ? 2 : s === "warning" ? 1 : 0);
      return rank(b.severity) - rank(a.severity) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    return out;
  }, [rooms, thresholds, alerts]);

  const visibleLiveAlerts = useMemo(
    () => liveAlerts.filter((a) => !dismissedLive.has(a.id)),
    [liveAlerts, dismissedLive]
  );

  function dismissLiveAlert(id: string) {
    setDismissedLive((prev) => new Set(prev).add(id));
  }
  function dismissAllLiveAlerts() {
    setDismissedLive((prev) => {
      const next = new Set(prev);
      liveAlerts.forEach((a) => next.add(a.id));
      return next;
    });
  }

  const unreadCount = notifications.filter((n) => !n.read).length;
  const alertUnreadCount = alerts.filter((a) => !a.isRead && a.status !== "resolved").length;
  const liveUnreadCount = visibleLiveAlerts.length;
  const totalUnread = unreadCount + alertUnreadCount + liveUnreadCount;
  const hasDangerAlert =
    alerts.some((a) => a.status !== "resolved" && (a.severity === "danger" || a.severity === "critical")) ||
    visibleLiveAlerts.some((a) => a.severity === "danger" || a.severity === "critical");

  const value = useMemo<NotificationsContextValue>(() => ({
    notifications, unreadCount, loading, markRead, markAllRead,
    refresh: async () => { await Promise.all([fetchNotifications(), fetchAlerts()]); },
    alerts, alertUnreadCount, alertsLoading, markAlertRead, markAllAlertsRead,
    liveAlerts: visibleLiveAlerts, liveUnreadCount,
    latestActionByNotification, recentActions,
    dismissLiveAlert, dismissAllLiveAlerts,
    totalUnread, hasDangerAlert,
  }), [notifications, unreadCount, loading, alerts, alertUnreadCount, alertsLoading, visibleLiveAlerts, liveUnreadCount, latestActionByNotification, recentActions, totalUnread, hasDangerAlert, fetchAlerts]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}
