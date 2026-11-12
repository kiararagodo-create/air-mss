// src/components/AlertActionBar.tsx
//
// The four personnel actions (+ "Mark as repaired" for offline / sensor
// fault) on every alert surface: Notifications rows + live list, bell
// dropdown, dashboard Action Plan. Spinners while saving, inline toast on
// success/error, multiple actions allowed (each is logged server-side).
// Compact variant fits the bell dropdown / dashboard dark panel.

import { useState } from "react";
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

export default function AlertActionBar({ ref_, sensorType, levelLabel, compact, dark, onDone, toast }: Props) {
  const { profile, role } = useAuth();
  const perms = getPermissions((role ?? "") as any);
  const [busy, setBusy] = useState<AlertAction | null>(null);
  const [note, setNote] = useState("");
  const [noteFor, setNoteFor] = useState<AlertAction | null>(null);
  const [openPopup, setOpenPopup] = useState<AlertAction | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [otherNote, setOtherNote] = useState("");

  if (!perms.canTakeAlertAction) return null;

  const isOffline = sensorType === "device" || levelLabel === "Offline";
  const actions = isOffline
    ? [...BASE, { action: "repaired" as AlertAction, label: "Mark as repaired", needsNote: true }]
    : BASE;

  function say(kind: "ok" | "err", text: string) {
    if (toast) toast(kind, text);
    else { window.setTimeout(() => {}, 4000); }
  }

  async function run(action: AlertAction, noteText?: string) {
    setBusy(action);
    const res = await recordAlertAction(ref_, action, noteText);
    setBusy(null);
    if (!res.ok) { say("err", `Could not record action: ${res.error ?? "unknown error"}`); return; }
    say("ok", `${ACTION_LABEL[action]} recorded${profile?.name ? ` as ${profile.name}` : ""}.`);
    setOpenPopup(null);
    setSelectedPreset(null);
    setOtherNote("");
    setNote("");
    setNoteFor(null);
    onDone?.();
  }

  const btnCls = compact
    ? "text-[10px] font-semibold px-2 py-1 rounded-md border"
    : "text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border";
  const idle = dark
    ? "border-white/20 text-slate-200 hover:bg-white/10"
    : "border-slate-200 text-slate-600 hover:bg-slate-50";

  const onPresetChange = (value: string) => {
    setSelectedPreset(value);
    if (value !== "Other…") {
      setOpenPopup(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            disabled={busy !== null}
            onClick={() => setOpenPopup(a.action)}
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

      {/* Action Preset Popup */}
      {openPopup && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-slate-900/80" onClick={() => setOpenPopup(null)} />
          <div className="relative bg-white w-full sm:max-w-[520px] max-h-[80vh] overflow-y-auto rounded-xl shadow-xl">
            <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-start justify-between">
              <div>
                <h2 className="text-[15px] font-bold text-slate-900 m-0">
                  {openPopup === "repaired" ? "Mark as repaired" : ACTION_LABEL[openPopup as AlertAction]}
                </h2>
                <p className="text-[11px] text-slate-500 mt-1">
                  {ref_.notificationId
                    ? `Alert ID: ${ref_.notificationId}`
                    : ref_.live
                      ? `Sensor: ${ref_.live?.sensor_type ?? "unknown"} ${ref_.live?.level_label ?? ""}`
                      : "Alert"}
                </p>
              </div>
              <button onClick={() => setOpenPopup(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>

            <div className="px-6 py-4">
              <div className="mb-4">
                <label className="text-[11px] font-bold text-slate-600 mb-1">Preset</label>
                <select
                  onChange={(e) => onPresetChange(e.target.value)}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="" disabled>{selectedPreset ?? "Select a preset…"}</option>
                  {ACTION_PRESETS[openPopup as keyof ActionPresets].map((preset, i) => (
                    <option
                      key={i}
                      value={preset}
                      selected={selectedPreset === preset}
                    >
                      {preset}
                    </option>
                  ))}
                  {hasOtherOption(openPopup as keyof ActionPresets) && (
                    <option value="Other…" selected={selectedPreset === "Other…"}>
                      Other…
                    </option>
                  )}
                </select>
              </div>

              {selectedPreset === "Other…" && (
                <div className="mb-4">
                  <label className="text-[11px] font-bold text-slate-600 mb-1">Custom note (max 200 chars)</label>
                  <input
                    value={otherNote}
                    onChange={(e) => setOtherNote(e.target.value?.slice(0, 200) ?? "")}
                    placeholder="Type your note here…"
                    className={`flex-1 min-w-0 rounded-md border px-3 py-2 text-[13px] focus:outline-none ${
                      dark ? "bg-white/10 border-white/20 text-white placeholder:text-slate-400" : "border-slate-200 text-slate-700"
                    }`}
                    maxLength={200}
                  />
                </div>
              )}

              <div className="flex gap-2">
                <button
                  disabled={!selectedPreset || selectedPreset === "Other…" && !otherNote.trim() || busy !== null}
                  onClick={() => {
                    let noteText: string | null = null;
                    if (selectedPreset && selectedPreset !== "Other…") {
                      noteText = selectedPreset;
                    } else if (selectedPreset === "Other…" && otherNote.trim()) {
                      noteText = otherNote.trim();
                    }
                    if (noteText !== null) {
                      run(openPopup as AlertAction, noteText);
                    }
                  }}
                  className={`flex-1 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-bold disabled:opacity-50 ${busy !== null ? "opacity-50" : ""}`}
                >
                  Confirm
                </button>
                <button
                  onClick={() => {
                    setOpenPopup(null);
                    setSelectedPreset(null);
                    setOtherNote("");
                    setNote("");
                    setNoteFor(null);
                  }}
                  className="flex-1 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm font-semibold disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {noteFor && (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Optional note for “${ACTION_LABEL[noteFor]}”…`}
            className={`flex-1 min-w-0 rounded-md border px-2 py-1 text-[11px] focus:outline-none ${
              dark ? "bg-white/10 border-white/20 text-white placeholder:text-slate-400" : "border-slate-200 text-slate-700"}`}
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run(noteFor, note || undefined)}
            className="text-[11px] font-bold px-2.5 py-1 rounded-md bg-teal-600 text-white disabled:opacity-50"
          >
            {busy === noteFor ? <Loader2 size={11} className="animate-spin" /> : "Record"}
          </button>
        </div>
      )}
    </div>
  );
}