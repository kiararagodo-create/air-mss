import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, CheckCircle2, Clock, Loader2, MessageCircle, RotateCcw, Search, SlidersHorizontal, X,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { useRooms } from "../context/RoomsContext";
import { useAuth } from "../context/AuthContext";
import { useNotifications } from "../context/NotificationContext";
import { Badge } from "../ui";
import {
  ACTION_LABEL, handledByLine, SEVERITY_TONE, SENSOR_LABEL, actionPlanFor, formatReading,
  manilaTime, maskPhone, relativeTime, unhandledMinutes,
  type AirNotification, type NotificationAction, type SmsLog,
} from "../lib/notifications";
import AlertActionBar from "../components/AlertActionBar";
import AlertSmsStatus from "../components/AlertSmsStatus";
import SendSmsDialog from "../components/SendSmsDialog";
import { getPermissions } from "../lib/permissions";
import { sendSmsManual, type AlertRef } from "../lib/alertActions";
import AutoSmsControlCard from "../components/notifications/AutoSmsControlCard";
import SmsDeliveryNotice from "../components/notifications/SmsDeliveryNotice";
import SummaryStrip, { type StatKey } from "../components/notifications/SummaryStrip";
import {
  EMPTY_SKIP_SUMMARY, loadAutoSmsSentCount, loadAutoSmsSettings, loadSmsSkipSummary,
  loadUpdaterName, saveAutoSmsSettings, subscribeAutoSmsSettings,
  type AutoSmsSettings, type SmsSkipSummary,
} from "../lib/smsAutoSettings";

const PAGE_SIZE = 20;
const UNHANDLED_MIN = 10;
const NOTICE_DISMISS_KEY = "air-notifications-sms-notice-dismissed";

interface Filters {
  severity: string; status: string; deviceId: string; sensor: string;
  from: string; to: string; search: string;
}

const EMPTY_FILTERS: Filters = { severity: "all", status: "all", deviceId: "all", sensor: "all", from: "", to: "", search: "" };

type SmsFailure = Pick<SmsLog, "id" | "notification_id" | "recipient_name" | "recipient_role" | "phone" | "status" | "provider_response" | "sent_at" | "send_mode" | "is_auto">;

function smsFailureText(row: SmsFailure): string {
  const who = row.recipient_name ? `${row.recipient_name}${row.recipient_role ? ` (${row.recipient_role})` : ""}` : "Unknown recipient";
  const phone = row.phone ? ` ${maskPhone(row.phone)}` : "";
  const alert = row.notification_id != null ? `alert #${row.notification_id}` : "no alert";
  const mode = row.is_auto || row.send_mode === "auto" ? "auto" : "manual";
  const reason = row.provider_response ? ` - ${row.provider_response}` : "";
  return `${who}${phone} · ${alert} · ${row.status} (${mode})${reason}`;
}

function readNoticeDismissed(): boolean {
  try { return sessionStorage.getItem(NOTICE_DISMISS_KEY) === "1"; } catch { return false; }
}

function writeNoticeDismissed(value: boolean): void {
  try {
    if (value) sessionStorage.setItem(NOTICE_DISMISS_KEY, "1");
    else sessionStorage.removeItem(NOTICE_DISMISS_KEY);
  } catch { /* sessionStorage unavailable (private mode) — ignore */ }
}

export default function NotificationsPage() {
  const { rooms, thresholds, setSelectedId } = useRooms();
  const { role } = useAuth();
  const { liveAlerts, latestActionByNotification } = useNotifications();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("id") ? Number(params.get("id")) : null;
  const perms = getPermissions((role ?? "") as any);
  const canEditSettings = role === "admin";

  const [rows, setRows] = useState<AirNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [topTab, setTopTab] = useState<"alerts" | "actionlog">("alerts");
  const [smsRef, setSmsRef] = useState<{ ref: AlertRef; severity: string; levelLabel: string; custom: boolean } | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [smsFailures, setSmsFailures] = useState<SmsFailure[]>([]);

  // Automatic SMS control state
  const [settings, setSettings] = useState<AutoSmsSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [updaterName, setUpdaterName] = useState<string | null>(null);

  // SMS delivery notice + counts
  const [skipSummary, setSkipSummary] = useState<SmsSkipSummary>(EMPTY_SKIP_SUMMARY);
  const [smsSent, setSmsSent] = useState(0);
  const [noticeExpanded, setNoticeExpanded] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState<boolean>(() => readNoticeDismissed());

  const toastRef = useRef<number | null>(null);
  const reloadTimer = useRef<number | null>(null);
  const countsTimer = useRef<number | null>(null);

  function showToast(kind: "ok" | "err", text: string) {
    setToast({ kind, text });
    if (toastRef.current != null) window.clearTimeout(toastRef.current);
    toastRef.current = window.setTimeout(() => setToast(null), 5000);
  }

  const loadSmsFailures = useCallback(async () => {
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { data } = await supabase
      .from("sms_logs")
      .select("id, notification_id, recipient_name, recipient_role, phone, status, provider_response, sent_at, send_mode, is_auto")
      .in("status", ["failed", "invalid_number"])
      .gte("sent_at", since)
      .order("sent_at", { ascending: false })
      .limit(20);
    setSmsFailures((data as SmsFailure[]) ?? []);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const q = supabase.from("air_notifications").select("*").order("created_at", { ascending: false }).limit(500);
    const { data, error } = await q;
    if (error) { setError({ message: error.message, code: (error as any).code }); setLoading(false); return; }
    setRows((data as AirNotification[]) ?? []);
    setLoading(false);
    void loadSmsFailures();
  }, [loadSmsFailures]);

  const loadSettings = useCallback(async () => {
    const s = await loadAutoSmsSettings();
    if (s) {
      setSettings(s);
      if (s.updated_by) setUpdaterName(await loadUpdaterName(s.updated_by));
      else setUpdaterName(null);
    }
    setSettingsLoading(false);
  }, []);

  const loadCounts = useCallback(async () => {
    const [summary, sent] = await Promise.all([loadSmsSkipSummary(), loadAutoSmsSentCount()]);
    setSkipSummary(summary);
    setSmsSent(sent);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => subscribeAutoSmsSettings(() => { void loadSettings(); }), [loadSettings]);
  useEffect(() => {
    void loadCounts();
    const t = window.setInterval(() => { void loadCounts(); }, 60_000);
    return () => window.clearInterval(t);
  }, [loadCounts]);

  // Realtime: debounce the reload so a burst of rows changes triggers one fetch.
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current != null) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => { void load(); }, 500);
  }, [load]);

  const scheduleCounts = useCallback(() => {
    if (countsTimer.current != null) window.clearTimeout(countsTimer.current);
    countsTimer.current = window.setTimeout(() => { void loadCounts(); }, 500);
  }, [loadCounts]);

  useEffect(() => {
    const ch = supabase.channel("notif-page-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "air_notifications" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "notification_actions" }, scheduleReload)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "sms_logs" }, () => { void loadSmsFailures(); scheduleCounts(); })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
      if (reloadTimer.current != null) window.clearTimeout(reloadTimer.current);
      if (countsTimer.current != null) window.clearTimeout(countsTimer.current);
    };
  }, [scheduleReload, scheduleCounts, loadSmsFailures]);

  // Clear the toast timer on unmount.
  useEffect(() => () => { if (toastRef.current != null) window.clearTimeout(toastRef.current); }, []);

  // Optimistic settings update with rollback; errors are shown inside the card.
  const updateSettings = useCallback((patch: Partial<AutoSmsSettings>) => {
    const prev = settings;
    setSettingsError(null);
    setSettingsSaving(true);
    setSettings(prev ? { ...prev, ...patch, updated_at: new Date().toISOString() } : prev);
    void (async () => {
      const res = await saveAutoSmsSettings(patch);
      setSettingsSaving(false);
      if (!res.ok) {
        setSettings(prev);
        setSettingsError(res.error ?? "Could not save. Please try again.");
        return;
      }
      void loadSettings();
    })();
  }, [settings, loadSettings]);

  const nonStatusFiltered = useMemo(() => {
    const s = filters.search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filters.severity !== "all" && r.severity !== filters.severity) return false;
      if (filters.deviceId !== "all" && r.device_id !== filters.deviceId) return false;
      if (filters.sensor !== "all" && r.sensor_type !== filters.sensor) return false;
      if (filters.from && r.created_at < new Date(filters.from).toISOString()) return false;
      if (filters.to && r.created_at > new Date(filters.to + "T23:59:59").toISOString()) return false;
      if (s) {
        const hay = `${r.room_name} ${r.device_id} ${r.sensor_type} ${r.level_label} ${r.message}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [rows, filters]);

  const statusCounts = useMemo(() => {
    const counts = { all: nonStatusFiltered.length, open: 0, acknowledged: 0, resolved: 0 };
    for (const r of nonStatusFiltered) {
      if (r.status === "open") counts.open += 1;
      else if (r.status === "acknowledged") counts.acknowledged += 1;
      else if (r.status === "resolved") counts.resolved += 1;
    }
    return counts;
  }, [nonStatusFiltered]);

  const filtered = useMemo(
    () => (filters.status === "all" ? nonStatusFiltered : nonStatusFiltered.filter((r) => r.status === filters.status)),
    [nonStatusFiltered, filters.status],
  );

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.severity !== "all") n += 1;
    if (filters.status !== "all") n += 1;
    if (filters.deviceId !== "all") n += 1;
    if (filters.sensor !== "all") n += 1;
    if (filters.from) n += 1;
    if (filters.to) n += 1;
    if (filters.search.trim()) n += 1;
    return n;
  }, [filters]);

  const stats = useMemo(() => ({
    open: rows.filter((r) => r.status === "open").length,
    unhandled: rows.filter((r) => unhandledMinutes(r, UNHANDLED_MIN)).length,
    sms_sent: smsSent,
    smsSkipped: skipSummary.total,
  }), [rows, smsSent, skipSummary.total]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filters]);

  const selected = selectedId ? rows.find((r) => r.id === selectedId) ?? null : null;
  // PGRST205 "Could not find the table 'public.air_notifications' in the
  // schema cache" = the migration was never run in the live DB. Setup step.
  const isMissingTable = !!error && (
    error.code === "PGRST205" ||
    /could not find the table.*air_notifications/i.test(error.message)
  );

  function selectStat(kind: StatKey) {
    if (kind === "open" || kind === "unhandled") {
      setFilters((f) => ({ ...f, status: "open" }));
    } else if (kind === "smsSkipped") {
      setNoticeDismissed(false);
      writeNoticeDismissed(false);
      setNoticeExpanded(true);
    } else {
      setTopTab("alerts");
    }
  }

  const activeStat: StatKey | null = filters.status === "open" ? "open" : null;

  const statusTabs: { value: string; label: string; count: number }[] = [
    { value: "all", label: "All", count: statusCounts.all },
    { value: "open", label: "Open", count: statusCounts.open },
    { value: "acknowledged", label: "Acknowledged", count: statusCounts.acknowledged },
    { value: "resolved", label: "Resolved", count: statusCounts.resolved },
  ];

  return (
    <div>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[22px] font-extrabold text-slate-900 m-0">Notifications</h1>
          <p className="text-slate-500 text-[13.5px] mt-1 mb-0">
            Sensor alerts, SMS delivery log, and personnel actions. Newest first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {perms.canSendSms && (
            <button onClick={() => setSmsRef({ ref: {}, severity: "", levelLabel: "", custom: true })}
              className="text-xs font-semibold text-white bg-teal-600 rounded-lg px-3 py-1.5 hover:bg-teal-700 inline-flex items-center gap-1.5">
              <MessageCircle size={13} /> Send custom SMS
            </button>
          )}
          <button onClick={load} className="text-xs font-semibold text-teal-700 border border-teal-200 rounded-lg px-3 py-1.5 hover:bg-teal-50">
            Refresh
          </button>
        </div>
      </div>

      {toast && (
        <div className={`mt-3 rounded-xl px-4 py-3 text-sm font-medium ${toast.kind === "ok" ? "bg-teal-50 border border-teal-200 text-teal-800" : "bg-red-50 border border-red-200 text-red-700"}`}>
          {toast.text}
        </div>
      )}

      <AutoSmsControlCard
        settings={settings}
        loading={settingsLoading}
        canEdit={canEditSettings}
        updaterName={updaterName}
        saving={settingsSaving}
        saveError={settingsError}
        onChange={updateSettings}
      />

      <SummaryStrip stats={stats} active={activeStat} onSelect={selectStat} />

      <SmsDeliveryNotice
        summary={skipSummary}
        expanded={noticeExpanded}
        onToggleExpanded={() => setNoticeExpanded((v) => !v)}
        dismissed={noticeDismissed}
        onDismiss={() => { setNoticeDismissed(true); writeNoticeDismissed(true); }}
        onOpenAlert={(id) => setParams({ id: String(id) })}
      />

      {smsFailures.length > 0 && (
        <div className="mt-4 rounded-xl px-4 py-3 text-sm bg-red-50 border border-red-200 text-red-800">
          <div className="font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            SMS send failure{smsFailures.length === 1 ? "" : "s"} (last 48h)
          </div>
          <div className="text-[12px] text-red-700 mt-0.5">Every attempt is logged to sms_logs and Action Log. Check iProg token/credits, number format, and recipient SMS settings.</div>
          <ul className="mt-2 mb-0 pl-4 space-y-1">
            {smsFailures.slice(0, 8).map((f: SmsFailure) => (
              <li key={f.id} className="text-[12px] leading-snug">
                <span className="font-semibold">{manilaTime(f.sent_at)}</span> — {smsFailureText(f)}
              </li>
            ))}
          </ul>
          {smsFailures.length > 8 && <div className="text-[11px] mt-1 text-red-700">+{smsFailures.length - 8} more. Open an alert detail to inspect its SMS log.</div>}
        </div>
      )}

      <div className="flex gap-2 mt-4">
        {(["alerts", "actionlog"] as const).map((t) => (
          <button key={t} onClick={() => setTopTab(t)}
            className={`text-[13px] font-semibold px-4 py-2 rounded-xl ${topTab === t ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>
            {t === "alerts" ? "Alerts" : "Action Log"}
          </button>
        ))}
      </div>

      {topTab === "actionlog" && <ActionLog rows={rows} />}

      {topTab === "alerts" && (<>
      {/* Filter toolbar */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className="md:hidden inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 hover:bg-slate-50"
          aria-expanded={filtersOpen}
        >
          <SlidersHorizontal size={13} /> Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-teal-700 border border-teal-200 rounded-lg px-3 py-1.5 hover:bg-teal-50"
          >
            <X size={13} /> Clear filters ({activeFilterCount})
          </button>
        )}
      </div>

      <div className={`${filtersOpen ? "grid" : "hidden"} md:grid bg-white border border-slate-200 rounded-xl p-4 mt-3 grid-cols-2 md:grid-cols-4 gap-2.5`}>
        <FilterSelect label="Severity" value={filters.severity} onChange={(v) => setFilters({ ...filters, severity: v })}
          options={[["all", "All"], ["warning", "Warning"], ["high", "High"], ["danger", "Danger"], ["critical", "Critical"], ["info", "Info"]]} />
        <FilterSelect label="Room / Device" value={filters.deviceId} onChange={(v) => setFilters({ ...filters, deviceId: v })}
          options={[["all", "All rooms"], ...rooms.map((r): [string, string] => [r.id, `${r.name} (${r.id})`])]} />
        <FilterSelect label="Sensor" value={filters.sensor} onChange={(v) => setFilters({ ...filters, sensor: v })}
          options={[["all", "All sensors"], ["co2", "CO2"], ["lpg", "LPG"], ["temp", "Temperature"], ["humidity", "Humidity"], ["device", "Device (offline)"]]} />
        <label className="text-[11px] font-bold text-slate-500">From
          <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-[13px]" />
        </label>
        <label className="text-[11px] font-bold text-slate-500">To
          <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-[13px]" />
        </label>
        <label className="text-[11px] font-bold text-slate-500 col-span-2 md:col-span-2 flex flex-col justify-end">Search
          <span className="relative mt-1 block">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
            <input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="Room, device, message…" className="w-full border border-slate-200 rounded-lg pl-8 pr-2 py-1.5 text-[13px]" />
          </span>
        </label>
      </div>

      {/* Segmented status tabs */}
      <div className="mt-3 flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
        {statusTabs.map((t) => {
          const isActive = filters.status === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setFilters((f) => ({ ...f, status: t.value }))}
              aria-pressed={isActive}
              className={`flex-1 min-w-[92px] whitespace-nowrap rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors motion-reduce:transition-none ${
                isActive ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t.label} <span className={isActive ? "text-teal-100" : "text-slate-400"}>({t.count})</span>
            </button>
          );
        })}
      </div>

      {isMissingTable ? (
        <div className="mt-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3 text-sm">
          <b>Alert history is not set up in the database yet</b> — the
          <code> public.air_notifications </code> table is missing, so saved
          alerts, SMS logs and the timeline cannot load. The bell and the live
          alerts below still work from the dashboard readings.
          <ol className="mt-2 mb-1 pl-5 list-decimal space-y-0.5">
            <li>Supabase Dashboard → <b>SQL Editor</b> → New query</li>
            <li>Paste the whole file <code>supabase/DEPLOY-AIR-NOTIFICATIONS.sql</code> and click <b>Run</b></li>
            <li>Wait for “Success”, then click <b>Refresh</b> above</li>
          </ol>
          <span className="text-amber-600 text-xs">Raw error: {error?.message}</span>
        </div>
      ) : error ? (
        <div className="mt-3 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          Failed to load notifications: {error.message}
        </div>
      ) : null}

      {liveAlerts.length > 0 && (
        <div className="bg-white border border-red-200 rounded-xl mt-4 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-red-100 text-[11px] font-bold tracking-wide text-red-600 uppercase flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse motion-reduce:animate-none" />
            Live alerts — act now ({liveAlerts.length})
          </div>
          {liveAlerts.map((a) => {
            const liveRef: AlertRef = { live: { device_id: a.device_id, room_name: a.room_name, floor: a.floor, sensor_type: a.sensor_type, level_label: a.level_label, severity: a.severity, reading_value: a.reading_value, reading_unit: a.reading_unit, message: a.message } };
            const handled = handledByLine(a as any);
            return (
            <div key={a.id} className="px-4 py-3 border-b border-slate-50 hover:bg-red-50/40">
              <div className="flex items-center gap-3">
                <Badge label={a.level_label} tone={SEVERITY_TONE[(a.severity as import("../lib/notifications").AirSeverity) || "warning"]} />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium text-slate-800 truncate">
                    {a.room_name}{a.floor ? ` · ${a.floor}` : ""}
                  </span>
                  <span className="block text-[11px] text-slate-400">
                    {SENSOR_LABEL[(a.sensor_type as import("../lib/notifications").SensorType)] ?? a.sensor_type}
                    {(() => {
                      const v = a.reading_value;
                      if (v == null || !Number.isFinite(v)) return " · no recent reading";
                      const allZeroFault = v === 0 && (a.level_label === "Freeze" || a.level_label === "Dry");
                      const outOfRange =
                        (a.sensor_type === "co2" && (v < 0 || v > 10000)) ||
                        (a.sensor_type === "lpg" && (v < 0 || v > 10000)) ||
                        (a.sensor_type === "temp" && (v < -40 || v > 80 || allZeroFault)) ||
                        (a.sensor_type === "humidity" && (v < 0 || v > 100 || allZeroFault));
                      if (outOfRange) return " · Sensor error";
                      if (a.sensor_type === "temp") return ` · ${v.toFixed(1)} ${a.reading_unit || "°C"}`;
                      if (a.sensor_type === "humidity") return ` · ${Math.round(v)} ${a.reading_unit || "%RH"}`;
                      return ` · ${Math.round(v)} ${a.reading_unit || "ppm"}`;
                    })()}
                    {" · "}{relativeTime(a.created_at)}
                  </span>
                  <span className={`block text-[11px] font-medium ${handled.unhandled ? "text-red-600 font-bold" : a.handled_by_name ? "text-teal-700" : "text-slate-400"}`}>
                    {a.stillPresent && a.handled_by_name ? `Resolved by ${a.handled_by_name} - condition still present` : handled.text}
                  </span>
                </span>
                <button type="button" onClick={() => { setSelectedId(a.device_id); navigate("/dashboard"); }}
                  className="text-[11px] font-semibold text-red-600 shrink-0">View →</button>
              </div>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <AlertActionBar ref_={liveRef} sensorType={a.sensor_type} levelLabel={a.level_label} toast={showToast} onDone={load} />
                {perms.canSendSms && (
                  <button type="button" onClick={() => setSmsRef({ ref: liveRef, severity: a.severity, levelLabel: a.level_label, custom: false })}
                    className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-teal-200 text-teal-700 hover:bg-teal-50 inline-flex items-center gap-1">
                    <MessageCircle size={12} /> SMS
                  </button>
                )}
              </div>
            </div>
          );})}
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl mt-4 overflow-hidden">
        {loading ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="px-4 py-2.5">Alert</th>
                  <th className="px-4 py-2.5">Level</th>
                  <th className="px-4 py-2.5">Reading</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Handled by</th>
                  <th className="px-4 py-2.5">Time</th>
                  <th className="px-4 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-slate-50">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 w-full max-w-[120px] animate-pulse motion-reduce:animate-none rounded bg-slate-100" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : pageRows.length === 0 ? (
          <div className="px-4 py-12 flex flex-col items-center justify-center gap-2 text-center">
            <CheckCircle2 className="w-7 h-7 text-slate-300" />
            <div className="text-slate-500 text-sm font-medium">
              {isMissingTable ? "No saved alerts yet — run the setup SQL above, then Refresh." : activeFilterCount > 0 ? "No alerts match these filters." : "No notifications yet."}
            </div>
            {activeFilterCount > 0 && !isMissingTable && (
              <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="text-[12px] font-semibold text-teal-700 hover:underline">
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="px-4 py-2.5">Alert</th>
                  <th className="px-4 py-2.5">Level</th>
                  <th className="px-4 py-2.5">Reading</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Handled by</th>
                  <th className="px-4 py-2.5">Time</th>
                  <th className="px-4 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const unhandled = unhandledMinutes(r, UNHANDLED_MIN);
                  const latest = latestActionByNotification[r.id];
                  const handled = handledByLine({ ...r, handled_action: latest?.action ?? null } as any);
                  return (
                    <tr key={r.id} onClick={() => setParams({ id: String(r.id) })}
                      className={`cursor-pointer hover:bg-slate-50 border-b border-slate-50 ${unhandled ? "bg-red-50/50" : ""}`}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-800">{r.room_name} <span className="text-slate-400 font-normal">{r.floor ? `· ${r.floor}` : ""}</span></div>
                        <div className="text-[11px] text-slate-400">{SENSOR_LABEL[r.sensor_type] ?? r.sensor_type} · {r.device_id}</div>
                      </td>
                      <td className="px-4 py-2.5"><Badge label={r.level_label} tone={SEVERITY_TONE[r.severity]} /></td>
                      <td className="px-4 py-2.5">{formatReading(r)}</td>
                      <td className="px-4 py-2.5">
                        <Badge label={r.status}
                          tone={r.status === "resolved" ? "success" : r.status === "acknowledged" ? "warning" : "danger"} />
                        {unhandled && <span className="ml-1.5 text-[10px] font-bold text-red-600">UNHANDLED &gt;{UNHANDLED_MIN}m</span>}
                        <AlertSmsStatus notificationId={r.id} />
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-[12px] ${handled.unhandled ? "text-red-600 font-semibold" : r.handled_by_name ? "text-slate-600" : "text-slate-400"}`}>{handled.text}</span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{relativeTime(r.created_at)}</td>
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-col gap-1.5 min-w-[170px]">
                          <AlertActionBar ref_={{ notificationId: r.id }} sensorType={r.sensor_type} levelLabel={r.level_label} toast={showToast} onDone={load} />
                          {perms.canSendSms && (
                            <button type="button" onClick={() => setSmsRef({ ref: { notificationId: r.id }, severity: r.severity, levelLabel: r.level_label, custom: false })}
                              className="text-[11px] font-semibold px-2 py-1 rounded-md border border-teal-200 text-teal-700 hover:bg-teal-50 inline-flex items-center gap-1 w-fit">
                              <MessageCircle size={11} /> Send SMS
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-[12px] text-slate-500">
          <span>{filtered.length} result(s) · page {page}/{totalPages}</span>
          <span className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-40 font-semibold">Previous</button>
            <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="disabled:opacity-40 font-semibold">Next</button>
          </span>
        </div>
      </div>

      {selected && (
        <NotificationDetail
          n={selected}
          thresholds={thresholds}
          onClose={() => setParams({})}
          role={role}
          onSms={(ref) => setSmsRef({ ref, severity: selected.severity, levelLabel: selected.level_label, custom: false })}
        />
      )}
      </>)}

      {smsRef && (
        <SendSmsDialog
          open
          onClose={() => setSmsRef(null)}
          ref_={smsRef.ref}
          severity={smsRef.severity}
          levelLabel={smsRef.levelLabel}
          custom={smsRef.custom}
          onSent={(info) => {
            const sent = info.ok ? info.results.filter((r) => r.status === "submitted").length : 0;
            const failed = info.results.filter((r) => r.status === "failed").length;
            showToast(failed > 0 || !info.ok ? "err" : "ok", `SMS: ${sent} sent, ${info.results.length - sent} failed/skipped.`);
            load();
          }}
        />
      )}
    </div>
  );
}

function ActionLog({ rows }: { rows: AirNotification[] }) {
  const [actions, setActions] = useState<(NotificationAction & { alert?: AirNotification })[]>([]);
  const [loading, setLoading] = useState(true);
  const [person, setPerson] = useState("all");
  const [action, setAction] = useState("all");
  // Keep the latest rows in a ref so load() is stable and the realtime
  // subscription is created once, not on every rows change.
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.from("notification_actions")
        .select("*").order("taken_at", { ascending: false }).limit(200);
      if (error) {
        console.error("Failed to load action log:", error.message);
        setActions([]);
        return;
      }
      const raw = ((data as NotificationAction[]) ?? []);
      const byId = new Map(rowsRef.current.map((r) => [r.id, r]));
      const missingIds = [...new Set(raw.map((a) => a.notification_id).filter((id) => !byId.has(id)))];
      if (missingIds.length > 0) {
        const { data: extra } = await supabase.from("air_notifications").select("*").in("id", missingIds);
        for (const n of ((extra as AirNotification[]) ?? [])) byId.set(n.id, n);
      }
      setActions(raw.map((a) => ({ ...a, alert: byId.get(a.notification_id) })));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const ch = supabase.channel("action-log-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "notification_actions" }, () => { void load(); })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [load]);

  const people = [...new Set(actions.map((a) => a.personnel_name))].sort();
  const filtered = actions.filter((a) =>
    (person === "all" || a.personnel_name === person) &&
    (action === "all" || a.action === action));

  return (
    <div className="bg-white border border-slate-200 rounded-xl mt-4 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2.5 flex-wrap">
        <h2 className="text-sm font-bold text-slate-800 m-0 mr-2">Action Log</h2>
        <FilterSelect label="Personnel" value={person} onChange={setPerson}
          options={[["all", "All personnel"], ...people.map((p): [string, string] => [p, p])]} />
        <FilterSelect label="Action" value={action} onChange={setAction}
          options={[["all", "All actions"], ["acknowledge", "Acknowledge"], ["on_my_way", "On my way"], ["resolved", "Resolved"], ["false_alarm", "False alarm"], ["repaired", "Repaired"], ["sms_sent", "SMS sent"]]} />
      </div>
      {loading ? (
        <div className="px-4 py-10 flex items-center justify-center gap-2 text-slate-400 text-sm"><Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-10 text-center text-slate-400 text-sm">No actions yet.</div>
      ) : (
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
              <th className="px-4 py-2.5">Action</th>
              <th className="px-4 py-2.5">Alert</th>
              <th className="px-4 py-2.5">By</th>
              <th className="px-4 py-2.5">Note</th>
              <th className="px-4 py-2.5">Time</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id} className="border-b border-slate-50">
                <td className="px-4 py-2.5 font-medium text-slate-800">{ACTION_LABEL[a.action] ?? a.action.replace("_", " ")}</td>
                <td className="px-4 py-2.5 text-slate-600">
                  {a.alert ? `${a.alert.room_name} · ${SENSOR_LABEL[a.alert.sensor_type] ?? a.alert.sensor_type} ${a.alert.level_label}` : `Alert #${a.notification_id}`}
                </td>
                <td className="px-4 py-2.5 text-slate-600">{a.personnel_name} <span className="text-slate-400">({a.personnel_role})</span></td>
                <td className="px-4 py-2.5 text-slate-500">{a.note ?? "—"}</td>
                <td className="px-4 py-2.5 text-slate-500">{relativeTime(a.taken_at)} · {manilaTime(a.taken_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="text-[11px] font-bold text-slate-500">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-[13px] bg-white">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function NotificationDetail({ n, thresholds, onClose, role, onSms }: {
  n: AirNotification; thresholds: any; onClose: () => void; role: string | null;
  onSms?: (ref: AlertRef) => void;
}) {
  const perms = getPermissions((role ?? "") as any);
  const [sms, setSms] = useState<SmsLog[]>([]);
  const [actions, setActions] = useState<NotificationAction[]>([]);
  const [tab, setTab] = useState<"timeline" | "sms">("timeline");
  const [resending, setResending] = useState<number | null>(null);
  const plan = actionPlanFor(n, thresholds);

  const loadDetail = useCallback(async () => {
    const [{ data: s }, { data: a }] = await Promise.all([
      supabase.from("sms_logs").select("*").eq("notification_id", n.id).order("sent_at", { ascending: true }),
      supabase.from("notification_actions").select("*").eq("notification_id", n.id).order("taken_at", { ascending: true }),
    ]);
    setSms((s as SmsLog[]) ?? []);
    setActions((a as NotificationAction[]) ?? []);
  }, [n.id]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  async function resend(s?: SmsLog) {
    setResending(s?.id ?? n.id);
    if (s?.personnel_id) {
      // Single-recipient resend via the manual-SMS function (logs a new row).
      await sendSmsManual({ ref: { notificationId: n.id }, recipientIds: [s.personnel_id], message: s.message, sendAnyway: true });
    } else {
      await supabase.functions.invoke("air-alerts", { body: { action: "resend", notification_id: n.id } });
    }
    setResending(null);
    loadDetail();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-[620px] max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-xl">
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge label={n.level_label} tone={SEVERITY_TONE[n.severity]} />
              <Badge label={n.status} tone={n.status === "resolved" ? "success" : n.status === "acknowledged" ? "warning" : "danger"} />
              {unhandledMinutes(n, UNHANDLED_MIN) && (
                <span className="text-[11px] font-bold text-red-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" /> Unhandled &gt;{UNHANDLED_MIN} min
                </span>
              )}
            </div>
            <h2 className="text-[16px] font-bold text-slate-900 mt-1.5 mb-0">
              {n.room_name} {n.floor ? `— ${n.floor}` : ""} · {SENSOR_LABEL[n.sensor_type]} · {formatReading(n)}
            </h2>
            <p className="text-[12px] text-slate-400 mt-0.5 mb-0">
              Device {n.device_id} · Detected {manilaTime(n.created_at)}
              {n.resolved_at ? ` · Resolved ${manilaTime(n.resolved_at)}` : ""}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <section className="bg-teal-50/60 border border-teal-100 rounded-xl p-3.5">
            <div className="text-[11px] font-bold text-teal-700 uppercase tracking-wide">Recommended action plan</div>
            <div className="font-semibold text-[13px] text-slate-800 mt-1">{plan.title}</div>
            <p className="text-[13px] text-slate-600 mt-0.5 mb-0">{plan.body}</p>
            <p className={`text-[12px] mt-2 mb-0 ${unhandledMinutes(n, UNHANDLED_MIN) ? "text-red-600 font-bold" : n.handled_by_name ? "text-teal-800" : "text-slate-500"}`}>
              {handledByLine(n as any).text}
            </p>
          </section>

          <section className="border border-slate-100 rounded-xl p-3.5">
            <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-2">Take action</div>
            <div className="flex items-center gap-3 flex-wrap">
              <AlertActionBar ref_={{ notificationId: n.id }} sensorType={n.sensor_type} levelLabel={n.level_label} onDone={loadDetail} />
              {perms.canSendSms && onSms && (
                <button type="button" onClick={() => onSms({ notificationId: n.id })}
                  className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-teal-200 text-teal-700 hover:bg-teal-50 inline-flex items-center gap-1">
                  <MessageCircle size={12} /> Send SMS alert
                </button>
              )}
            </div>
          </section>

          <div className="flex gap-2">
            {(["timeline", "sms"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`text-[12px] font-semibold px-3 py-1.5 rounded-lg ${tab === t ? "bg-teal-600 text-white" : "border border-slate-200 text-slate-600"}`}>
                {t === "timeline" ? "Timeline" : `SMS Log (${sms.length})`}
              </button>
            ))}
          </div>

          {tab === "timeline" ? (
            <ol className="space-y-3">
              <TimelineItem icon={<Clock className="w-4 h-4" />} title="Detected" time={manilaTime(n.created_at)}
                body={`${SENSOR_LABEL[n.sensor_type]} ${formatReading(n)} — ${n.level_label}`} />
              {[
                ...sms.map((s) => ({ t: s.sent_at, key: `sms-${s.id}`, icon: <MessageCircle className="w-4 h-4" />,
                  title: `SMS ${s.is_auto || s.send_mode === "auto" ? "(auto) " : ""}sent to ${s.recipient_name} (${s.recipient_role})`,
                  body: `${maskPhone(s.phone)} · ${s.status}${s.provider_response ? ` · ${s.provider_response}` : ""}` })),
                ...actions.map((a) => ({ t: a.taken_at, key: `act-${a.id}`, icon: <CheckCircle2 className="w-4 h-4" />,
                  title: `Action taken by ${a.personnel_name} (${a.personnel_role})`,
                  body: `${ACTION_LABEL[a.action] ?? a.action.replace("_", " ")}${a.note ? ` — ${a.note}` : ""}` })),
              ].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
                .map((e) => <TimelineItem key={e.key} icon={e.icon} title={e.title} time={manilaTime(e.t)} body={e.body} />)}
              {n.resolved_at && (
                <TimelineItem icon={<CheckCircle2 className="w-4 h-4" />} title="Resolved" time={manilaTime(n.resolved_at)}
                  body={n.resolution_note ?? "Reading returned to safe range"} />
              )}
            </ol>
          ) : (
            <div className="space-y-2">
              {sms.length === 0 && <p className="text-[13px] text-slate-400">No SMS sent for this alert.</p>}
              {sms.map((s) => (
                <div key={s.id} className="border border-slate-100 rounded-xl p-3 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-700">{s.recipient_name} · {s.recipient_role}</span>
                    <Badge label={s.status} tone={s.status === "failed" || s.status === "skipped_no_number" || s.status === "invalid_number" ? "danger" : "success"} />
                  </div>
                  <div className="text-slate-500 mt-0.5">{maskPhone(s.phone)} · {manilaTime(s.sent_at)} · {s.is_auto || s.send_mode === "auto" ? "auto" : "manual"}</div>
                  <p className="text-slate-600 mt-1.5 mb-0 whitespace-pre-wrap">{s.message}</p>
                  {s.provider_response && <p className="text-[11px] text-slate-400 mt-1 mb-0">Provider: {s.provider_response}</p>}
                  {s.status === "failed" && perms.canSendSms && (
                    <button onClick={() => resend(s)} disabled={resending === s.id}
                      className="mt-2 text-[11px] font-bold text-teal-700 flex items-center gap-1 disabled:opacity-50">
                      <RotateCcw className="w-3 h-3" /> {resending === s.id ? "Resending…" : "Resend"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineItem({ icon, title, time, body }: { icon: React.ReactNode; title: string; time: string; body: string }) {
  return (
    <li className="flex gap-3">
      <div className="w-8 h-8 rounded-full bg-teal-50 text-teal-700 flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-slate-800">{title} <span className="text-slate-400 font-normal text-[11px]">· {time}</span></div>
        <div className="text-[12px] text-slate-500">{body}</div>
      </div>
    </li>
  );
}
