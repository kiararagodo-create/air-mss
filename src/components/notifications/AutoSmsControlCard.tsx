import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Lock, Pause, Play, SlidersHorizontal } from "lucide-react";
import { manilaTime } from "../../lib/notifications";
import {
  INDEFINITE_PAUSE_ISO,
  SENSOR_FLAGS,
  isAutoSmsPaused,
  type AutoSmsSettings,
  type SensorFlagKey,
} from "../../lib/smsAutoSettings";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  settings: AutoSmsSettings | null;
  loading: boolean;
  canEdit: boolean;
  updaterName: string | null;
  saving: boolean;
  saveError: string | null;
  onChange: (patch: Partial<AutoSmsSettings>) => void;
}

const HELPER_TEXT =
  "Detection stays on. Alerts are still recorded and shown here and on the dashboard. " +
  "Only automatic text messages are affected. Manual SMS always works.";

const DANGER_CONFIRM = "Danger-level alerts will NOT be texted to anyone.";

interface ConfirmState {
  title: string;
  message: string;
  patch: Partial<AutoSmsSettings>;
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 ${
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"
      } ${checked ? "bg-teal-600" : "bg-slate-300"}`}
    >
      <span
        className={`inline-block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
          checked ? "translate-x-[20px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

function indefinitePause(settings: AutoSmsSettings | null): boolean {
  const v = settings?.auto_sms_paused_until;
  if (!v) return false;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.getFullYear() > 9000;
}

export default function AutoSmsControlCard({
  settings,
  loading,
  canEdit,
  updaterName,
  saving,
  saveError,
  onChange,
}: Props) {
  const [sensorsOpen, setSensorsOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const pauseRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pauseOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pauseRef.current && !pauseRef.current.contains(e.target as Node)) setPauseOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pauseOpen]);

  const enabled = settings?.auto_sms_enabled ?? true;
  const paused = isAutoSmsPaused(settings);
  const indefinite = indefinitePause(settings);
  const dangerLock = settings?.always_send_danger ?? true;
  const busy = saving;

  const pill = !enabled
    ? { text: "Automatic SMS: OFF", cls: "bg-slate-100 text-slate-600 border-slate-200" }
    : paused
      ? {
          text: indefinite ? "PAUSED · Resume" : `PAUSED until ${manilaTime(settings!.auto_sms_paused_until!)} · Resume`,
          cls: "bg-amber-50 text-amber-700 border-amber-200",
        }
      : { text: "Automatic SMS: ON", cls: "bg-teal-50 text-teal-700 border-teal-200" };

  function pauseFor(minutes: number | null) {
    setPauseOpen(false);
    const until = minutes == null ? INDEFINITE_PAUSE_ISO : new Date(Date.now() + minutes * 60_000).toISOString();
    onChange({ auto_sms_paused_until: until });
  }

  function toggleMaster(next: boolean) {
    if (!next) {
      setConfirm({
        title: "Turn off automatic SMS?",
        message: `${DANGER_CONFIRM} Alerts are still recorded and shown on the dashboard.`,
        patch: { auto_sms_enabled: false },
      });
      return;
    }
    onChange({ auto_sms_enabled: true });
  }

  function toggleSensor(meta: { key: SensorFlagKey; label: string }, next: boolean) {
    if (!next && (meta.key === "auto_sms_co2" || meta.key === "auto_sms_lpg")) {
      setConfirm({
        title: `Turn off ${meta.label} automatic SMS?`,
        message: `${DANGER_CONFIRM} Alerts are still recorded and shown on the dashboard.`,
        patch: { [meta.key]: false },
      });
      return;
    }
    onChange({ [meta.key]: next });
  }

  function toggleDanger(next: boolean) {
    if (!next) {
      setConfirm({
        title: "Turn off the DANGER lock?",
        message: `${DANGER_CONFIRM} Only the master switch and per-sensor settings would decide.`,
        patch: { always_send_danger: false },
      });
      return;
    }
    onChange({ always_send_danger: true });
  }

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={15} className="text-teal-600" />
            <h2 className="m-0 text-[14px] font-bold text-slate-800">Automatic SMS</h2>
          </div>
          <p className="mt-1 mb-0 text-[12.5px] leading-snug text-slate-500 max-w-[70ch]">{HELPER_TEXT}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${pill.cls}`}>{pill.text}</span>
          <Switch checked={enabled} disabled={!canEdit || busy || loading} label="Automatic SMS" onChange={toggleMaster} />
        </div>
      </div>

      {paused && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={() => onChange({ auto_sms_paused_until: null })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 px-2.5 py-1.5 text-[12px] font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-40"
          >
            <Play size={12} /> Resume now
          </button>
        </div>
      )}

      {!enabled && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] font-medium text-amber-800">
          Automatic SMS is off. No alert text messages will be sent by the system.
        </div>
      )}

      {saveError && (
        <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] font-medium text-red-700">
          Could not save: {saveError}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {canEdit ? (
          <div className="relative" ref={pauseRef}>
            <button
              type="button"
              disabled={!enabled || busy}
              onClick={() => setPauseOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={pauseOpen}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              <Pause size={12} /> Pause automatic SMS <ChevronDown size={12} />
            </button>
            {pauseOpen && (
              <div role="menu" className="absolute left-0 z-20 mt-1 w-[210px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                {[
                  ["30 min", 30],
                  ["1 hour", 60],
                  ["3 hours", 180],
                  ["8 hours", 480],
                ].map(([label, mins]) => (
                  <button
                    key={label as string}
                    type="button"
                    role="menuitem"
                    onClick={() => pauseFor(mins as number)}
                    className="block w-full px-3 py-2 text-left text-[13px] text-slate-700 hover:bg-slate-50"
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => pauseFor(null)}
                  className="block w-full border-t border-slate-100 px-3 py-2 text-left text-[13px] text-slate-700 hover:bg-slate-50"
                >
                  Until I turn it on
                </button>
              </div>
            )}
          </div>
        ) : (
          <span className="text-[11.5px] text-slate-400">Read-only — only admins can change these settings.</span>
        )}
        {busy && <Loader2 size={14} className="animate-spin text-slate-400 motion-reduce:animate-none" />}
      </div>

      {/* Customize by sensor */}
      <div className="mt-3 border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={() => setSensorsOpen((v) => !v)}
          aria-expanded={sensorsOpen}
          className="flex w-full items-center justify-between gap-2 text-[12.5px] font-bold text-slate-600"
        >
          <span>Customize by sensor</span>
          <ChevronDown size={15} className={`transition-transform motion-reduce:transition-none ${sensorsOpen ? "rotate-180" : ""}`} />
        </button>
        {sensorsOpen && (
          <div className={`mt-2 grid gap-2 sm:grid-cols-2 ${enabled ? "" : "opacity-50"}`}>
            {SENSOR_FLAGS.map((meta) => (
              <div key={meta.key} className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold text-slate-700">{meta.label}</div>
                  <div className="text-[11px] text-slate-400">{meta.description}</div>
                </div>
                <Switch
                  checked={settings?.[meta.key] ?? true}
                  disabled={!canEdit || !enabled || busy}
                  label={`${meta.label} automatic SMS`}
                  onChange={(next) => toggleSensor(meta, next)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* DANGER lock */}
      <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-700">
            <Lock size={13} className="text-red-500" /> Always send DANGER alerts
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-slate-400">
            Danger and critical alerts are texted even when the master switch is off or paused.
          </div>
        </div>
        <Switch
          checked={dangerLock}
          disabled={!canEdit || busy}
          label="Always send DANGER alerts"
          onChange={toggleDanger}
        />
      </div>

      <div className="mt-3 text-[11px] text-slate-400">
        {loading
          ? "Loading settings…"
          : settings?.updated_at
            ? `Last changed by ${updaterName ?? "an admin"} at ${manilaTime(settings.updated_at)}.`
            : "No changes recorded yet."}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        busy={busy}
        onConfirm={() => {
          if (confirm) onChange(confirm.patch);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
