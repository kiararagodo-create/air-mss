import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type BadgeState = "sent" | "failed" | "skipped" | "none";

interface SmsStatus {
  state: BadgeState;
  reason: string | null;
}

const reasonText: Record<string, string> = {
  skipped_quality: "quality",
  skipped_open_incident: "open incident",
  skipped_rate_limited: "rate limited",
  skipped_no_recipients: "no recipients",
  skipped_low_credits: "low credits",
  skipped_no_number: "no number",
  skipped_dry_run: "dry run",
};

const cache = new Map<number, SmsStatus>();
const listeners = new Set<() => void>();
const pending = new Set<number>();
let timer: number | null = null;
let channel: any = null;

function mapStatus(status: string): SmsStatus {
  if (status === "submitted" || status === "in_progress") return { state: "sent", reason: null };
  if (status === "failed" || status === "invalid_number") return { state: "failed", reason: null };
  return { state: "skipped", reason: reasonText[status] ?? status.replace(/^skipped_/, "") };
}

function rankOf(status: SmsStatus): number {
  return status.state === "sent" ? 3 : status.state === "failed" ? 2 : status.state === "skipped" ? 1 : 0;
}

function mergeStatus(prev: SmsStatus | undefined, next: SmsStatus): SmsStatus {
  if (!prev) return next;
  return rankOf(next) > rankOf(prev) ? next : prev;
}

function notify() {
  listeners.forEach((listener) => listener());
}

function ensureRealtime() {
  if (channel) return;
  channel = supabase
    .channel("alert-sms-status-live")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "sms_logs" },
      (payload: { new?: { notification_id?: number | null; status?: string } }) => {
        const id = payload.new?.notification_id;
        const status = payload.new?.status;
        if (id == null || !status) return;
        cache.set(id, mergeStatus(cache.get(id), mapStatus(status)));
        notify();
      },
    )
    .subscribe();
}

async function request(ids: number[]) {
  try {
    const { data, error } = await supabase
      .from("sms_logs")
      .select("notification_id, status")
      .in("notification_id", ids)
      .order("sent_at", { ascending: false })
      .limit(500);
    if (error || !data) return;
    const byId = new Map<number, { sent: boolean; failed: boolean; skip: string | null }>();
    for (const row of data as { notification_id: number | null; status: string }[]) {
      if (row.notification_id == null) continue;
      let agg = byId.get(row.notification_id);
      if (!agg) {
        agg = { sent: false, failed: false, skip: null };
        byId.set(row.notification_id, agg);
      }
      if (row.status === "submitted" || row.status === "in_progress") agg.sent = true;
      else if (row.status === "failed" || row.status === "invalid_number") agg.failed = true;
      else if (row.status.startsWith("skipped_") && agg.skip === null) agg.skip = row.status;
    }
    for (const id of ids) {
      const agg = byId.get(id);
      if (!agg) {
        cache.set(id, { state: "none", reason: null });
      } else if (agg.sent) {
        cache.set(id, { state: "sent", reason: null });
      } else if (agg.failed) {
        cache.set(id, { state: "failed", reason: null });
      } else if (agg.skip) {
        cache.set(id, mapStatus(agg.skip));
      } else {
        cache.set(id, { state: "none", reason: null });
      }
    }
    notify();
  } catch {
    // ignore
  }
}

function schedule() {
  ensureRealtime();
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    if (pending.size === 0) return;
    const ids = [...pending];
    pending.clear();
    void request(ids);
  }, 0);
}

export default function AlertSmsStatus({ notificationId }: { notificationId: number }) {
  const [status, setStatus] = useState<SmsStatus | null>(() => cache.get(notificationId) ?? null);

  useEffect(() => {
    const cached = cache.get(notificationId);
    if (cached) {
      setStatus(cached);
      return;
    }
    pending.add(notificationId);
    schedule();
    const listener = () => {
      const next = cache.get(notificationId);
      if (next) setStatus(next);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [notificationId]);

  if (!status || status.state === "none") return null;

  const label =
    status.state === "sent"
      ? "SMS sent"
      : status.state === "failed"
      ? "SMS failed"
      : `SMS skipped: ${status.reason ?? "unknown"}`;

  const tone =
    status.state === "sent"
      ? "bg-teal-50 text-teal-700 border-teal-200"
      : status.state === "failed"
      ? "bg-red-50 text-red-700 border-red-200"
      : "bg-amber-50 text-amber-700 border-amber-200";

  return (
    <span className={`inline-block mt-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${tone}`}>
      {label}
    </span>
  );
}
