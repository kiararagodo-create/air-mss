// src/components/AlertActionBar.tsx
//
// The four personnel actions (+ "Mark as repaired" for offline / sensor
// fault) on every alert surface: Notifications rows + live list, bell
// dropdown, dashboard Action Plan. Spinners while saving, toast on
// success/error (our own one when the call site has no toast), multiple
// actions allowed (each is logged server-side). Compact variant fits the
// bell dropdown / dashboard dark panel.
//
// The preset dialog is portalled to <body>. Call sites render this bar
// inside the bell dropdown - which lives in the sidebar, and the sidebar
// carries a `transform` (translate-x-*) - and inside the notification
// detail modal. A transformed ancestor becomes the containing block for
// `position: fixed`, so an in-place dialog was laid out against the
// sidebar instead of the viewport: squeezed at the left, clipped by the
// dropdown's overflow, under the page's own stacking order. A portal
// removes every ancestor concern, and z-[70] sits above the sidebar (50),
// the bell dropdown (50) and the toasts (50).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Loader2, Send, Wrench, X, XCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { getPermissions } from "../lib/permissions";
import { recordAlertAction, type AlertRef } from "../lib/alertActions";
import { ACTION_LABEL, type AlertAction } from "../lib/notifications";
import { ACTION_PRESETS, type ActionPresets, hasOtherOption } from "../data/actionPresets";

interface Props {
  ref_: AlertRef;
  sensorType?: string;
  levelLabel?: string;
  compact?: boolean;
  dark?: boolean;
  onDone?: () => void;
  toast?: (kind: "ok" | "err", text: string) => void;
}

const BASE: { action: AlertAction; label: string; needsNote?: boolean }[] = [
  { action: "acknowledge", label: "Acknowledge" },
  { action: "on_my_way", label: "On my way" },
  { action: "resolved", label: "Resolved", needsNote: true },
  { action: "false_alarm", label: "False alarm", needsNote: true },
];

/** Above the sidebar / bell dropdown / toasts (z-50) and the other z-[60] modals. */
const DIALOG_Z = "z-[70]";

export default function AlertActionBar({ ref_, sensorType, levelLabel, compact, dark, onDone, toast }: Props) {
  const { profile, role } = useAuth();
  const perms = getPermissions((role ?? "") as any);
  const [busy, setBusy] = useState<AlertAction | null>(null);
  const [openPopup, setOpenPopup] = useState<AlertAction | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [otherNote, setOtherNote] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [fallbackToast, setFallbackToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Escape closes the dialog and body scroll is locked while it is open.
  // Registered before the permission early-return so hook order never changes.
  useEffect(() => {
    if (!openPopup) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
    // closeDialog only touches setters, so the first capture is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPopup]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  if (!perms.canTakeAlertAction) return null;

  const isOffline = sensorType === "device" || levelLabel === "Offline";
  const actions = isOffline
    ? [...BASE, { action: "repaired" as AlertAction, label: "Mark as repaired", needsNote: true }]
    : BASE;

  const presetList: readonly string[] = openPopup
    ? (ACTION_PRESETS[openPopup as keyof ActionPresets] as readonly string[])
    : [];
  // Every preset list already ends with "Other…"; only add the extra option
  // when the list does not carry one (a duplicate option shares one value and
  // makes the closed select ambiguous).
  const needsOtherOption = openPopup
    ? hasOtherOption(openPopup as keyof ActionPresets) && !presetList.includes("Other…")
    : false;

  /** Toast for the call sites that pass one; otherwise our own, so a success
   *  from the bell dropdown / dashboard Action Plan is never silent. */
  function say(kind: "ok" | "err", text: string, inline = false) {
    if (toast) {
      toast(kind, text);
      return;
    }
    // An error raised from inside the dialog is shown by the dialog itself.
    if (inline) return;
    setFallbackToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setFallbackToast(null), 4500);
  }

  async function run(action: AlertAction, noteText?: string) {
    const fromDialog = openPopup !== null;
    setBusy(action);
    setDialogError(null);
    try {
      const res = await recordAlertAction(ref_, action, noteText);
      if (!res.ok) {
        const msg = `Could not record action: ${res.error ?? "unknown error"}`;
        if (fromDialog) setDialogError(msg);
        say("err", msg, fromDialog);
        return;
      }
      say("ok", `${ACTION_LABEL[action]} recorded${profile?.name ? ` as ${profile.name}` : ""}.`);
      closeDialog();
      onDone?.();
    } catch (e) {
      const msg = `Could not record action: ${e instanceof Error ? e.message : "network error"}`;
      if (fromDialog) setDialogError(msg);
      say("err", msg, fromDialog);
    } finally {
      // Always releases the buttons, even when the request throws.
      setBusy(null);
    }
  }

  function openAction(action: AlertAction) {
    const presets = ACTION_PRESETS[action as keyof ActionPresets] as readonly string[];
    // The select shows its first entry by default, so seed the state with it:
    // the default preset counts as selected and Confirm is usable the moment
    // the dialog opens (it used to start empty and stay disabled).
    setSelectedPreset(String(presets[0] ?? ""));
    setOtherNote("");
    setDialogError(null);
    setOpenPopup(action);
  }

  function closeDialog() {
    setOpenPopup(null);
    setSelectedPreset("");
    setOtherNote("");
    setDialogError(null);
  }

  function confirmAction() {
    if (!openPopup || busy !== null) return;
    if (!selectedPreset) return;
    if (selectedPreset === "Other…") {
      const text = otherNote.trim();
      if (!text) return;
      void run(openPopup, text);
      return;
    }
    void run(openPopup, selectedPreset);
  }

  const needsNote = selectedPreset === "Other…";
  const canConfirm = busy === null && !!selectedPreset && (!needsNote || !!otherNote.trim());

  const btnCls = compact
    ? "text-[10px] font-semibold px-2 py-1 rounded-md border"
    : "text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border";
  const idle = dark
    ? "border-white/20 text-slate-200 hover:bg-white/10"
    : "border-slate-200 text-slate-600 hover:bg-slate-50";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            disabled={busy !== null}
            onClick={() => openAction(a.action)}
            className={`${btnCls} ${idle} disabled:opacity-50 inline-flex items-center gap-1`}
          >
            {busy === a.action ? <Loader2 size={compact ? 10 : 12} className="animate-spin" />
              : a.action === "repaired" ? <Wrench size={compact ? 10 : 12} />
              : a.action === "resolved" ? <CheckCircle2 size={compact ? 10 : 12} />
              : a.action === "false_alarm" ? <XCircle size={compact ? 10 : 12} />
              : <Send size={compact ? 10 : 12} />}
            {a.label}
          </button>
        ))}
      </div>

      {/* Success/error toast for call sites that do not pass one. */}
      {fallbackToast && createPortal(
        <div
          role="status"
          aria-live="polite"
          className={`fixed right-4 top-4 ${DIALOG_Z} max-w-[min(92vw,360px)] rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${
            fallbackToast.kind === "ok"
              ? "border-teal-200 bg-teal-50 text-teal-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {fallbackToast.text}
        </div>,
        document.body
      )}

      {/* Action preset dialog - portalled to <body> so no sidebar, dropdown,
          overflow or ancestor transform can move, clip or stack it. */}
      {openPopup && createPortal(
        <div
          className={`fixed inset-0 ${DIALOG_Z} flex items-center justify-center p-3 sm:p-4`}
        >
          {/* Backdrop click (and Escape, and the X) close the dialog. A drag
              that starts inside the card ends on the common ancestor, so
              selecting text never closes it. */}
          <div
            className="absolute inset-0 bg-slate-900/70"
            aria-hidden="true"
            onClick={closeDialog}
          />
          <div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="alert-action-dialog-title"
            tabIndex={-1}
            className="relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl bg-white shadow-2xl outline-none"
            style={{ width: "min(92vw, 440px)" }}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2 id="alert-action-dialog-title" className="m-0 text-[16px] font-bold leading-snug text-slate-900">
                  {openPopup === "repaired" ? "Mark as repaired" : ACTION_LABEL[openPopup as AlertAction]}
                </h2>
                <p className="mb-0 mt-1 text-[12px] leading-snug text-slate-500">
                  {ref_.notificationId
                    ? `Alert ID: ${ref_.notificationId}`
                    : ref_.live
                      ? `Sensor: ${ref_.live?.sensor_type ?? "unknown"} ${ref_.live?.level_label ?? ""}`
                      : "Alert"}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                aria-label="Close dialog"
                className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={18} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {dialogError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] font-medium leading-snug text-red-700"
                >
                  {dialogError}
                </div>
              )}

              <label htmlFor="alert-action-preset" className="mb-1 block text-[12px] font-bold text-slate-600">
                Preset
              </label>
              <select
                id="alert-action-preset"
                value={selectedPreset}
                onChange={(e) => {
                  setSelectedPreset(e.target.value);
                  setDialogError(null);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-[14px] leading-snug text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500"
              >
                <option value="" disabled>Select a preset…</option>
                {presetList.map((preset) => (
                  <option key={preset} value={preset} title={preset}>{preset}</option>
                ))}
                {needsOtherOption && (
                  <option value="Other…" title="Other…">Other…</option>
                )}
              </select>
              {/* The closed select can truncate; show the whole choice here so
                  nothing is ever cut off (wraps, and is also the option title). */}
              {selectedPreset && !needsNote && (
                <p className="mb-0 mt-2 text-[12px] leading-snug text-slate-500" title={selectedPreset}>
                  {selectedPreset}
                </p>
              )}

              {needsNote && (
                <div className="mt-3">
                  <label htmlFor="alert-action-note" className="mb-1 block text-[12px] font-bold text-slate-600">
                    Custom note (max 200 chars)
                  </label>
                  <input
                    id="alert-action-note"
                    value={otherNote}
                    onChange={(e) => {
                      setOtherNote(e.target.value.slice(0, 200));
                      setDialogError(null);
                    }}
                    placeholder="Type your note here…"
                    maxLength={200}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-[14px] text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                  <div className="mt-1 text-right text-[11px] text-slate-400">{otherNote.length}/200</div>
                </div>
              )}
            </div>

            <div className="flex gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                disabled={!canConfirm}
                onClick={confirmAction}
                aria-busy={busy === openPopup}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === openPopup && <Loader2 size={15} className="animate-spin" />}
                {busy === openPopup ? "Recording…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={closeDialog}
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
