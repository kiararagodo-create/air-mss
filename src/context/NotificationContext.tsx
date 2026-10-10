import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

export interface Notification {
  id: number;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}

interface NotificationsContextValue {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextValue | undefined>(
  undefined
);

export function NotificationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchNotifications() {
    if (!user) {
      setNotifications([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Failed to fetch notifications:", error.message);
    } else {
      setNotifications((data as Notification[]) ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Realtime: new notifications (e.g. an admin just approved someone) appear
  // instantly without a page refresh.
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
            // Keep the list bounded.
            return next.slice(0, 50);
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

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

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationsContext.Provider
      value={{
        notifications,
        unreadCount,
        loading,
        markRead,
        markAllRead,
        refresh: fetchNotifications,
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