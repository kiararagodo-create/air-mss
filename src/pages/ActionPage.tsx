import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Clock, Loader2, MapPin } from "lucide-react";

import { SEVERITY_TONE, SENSOR_LABEL, manilaTime, relativeTime, type AirSeverity, type SensorType } from "../lib/notifications";
import { Badge } from "../ui";

type Action = "acknowledge" | "on_my_way" | "resolved" | "false_alarm" | "repaired";

interface TokenData {
  notification: {
    id: number; device_id: string; room_name: string; floor: string;
    sensor_type: string; level_label: string; severity: string;
    reading_value: number | null; reading_unit: string; message: string;
    status: string; created_at: string; resolved_at: string | null;
  };
  personnel_name: string; personnel_role: string; expires_at: string; expired: boolean;
  actions: { id: number; personnel_name: string; personnel_role: string; action: string; note: string | null; taken_at: string }[];
}

const ACTION_META: { key: Action; label: string; sub: string }[] = [
  { key: "acknowledge", label: "Acknowledge / I'm on it", sub: "I've seen this and will take it from here" },
  { key: "on_my_way", label: "On my way", sub: "Heading to the location now" },
  { key: "resolved", label: "Resolved / Issue fixed", sub: "The condition is now safe" },
  { key: "false_alarm", label: "False alarm", sub: "This was not a real hazard" },
  { key: "repaired", label: "Mark as repaired", sub: "The device / sensor is working again" },
];

/**
 * Public action page behind the SMS link /action/<token>. Works without login:
 * the token identifies the personnel. Everything goes through the action-by-token
 * Edge Function (verify_jwt = false, service role server-side), never a
 * direct table read.
 */
export default function ActionPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<TokenData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Action | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) { setError("Missing link token."); setLoading(false); return; }
    setLoading(true);
    try {
      const base = import.meta.env.VITE_SUPABASE_URL as string;
      const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
      const res = await fetch(`${base}/functions/v1/action-by-token?token=${encodeURIComponent(token)}`, {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      });
      const data = await res.json();
      if (!res.ok || data?.error) { setError(data?.error ?? "This link is invalid."); setLoading(false); return; }
      setData(data);
    } catch {
      setError("Could not reach the alert service.");
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function act(action: Action) {
    if (!token) return;
    setBusy(action);
    try {
      const base = import.meta.env.VITE_SUPABASE_URL as string;
      const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
      const res = await fetch(`${base}/functions/v1/action-by-token`, {
        method: "POST",
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
        body: JSON.stringify({ token, action, note: note.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) { setError(data?.error ?? "Could not record your action."); setBusy(null); return; }
    } catch {
      setError("Could not reach the alert service.");
      setBusy(null);
      return;
    }
    setBusy(null);
    setDone(action);
    await load();
  }

  if (loading) {
    return (
      <CenterState>
        <Loader2 className="w-6 h-6 animate-spin text-teal-600" />
        <p className="text-slate-500 text-sm mt-2">Loading alert…</p>
      </CenterState>
    );
  }
  if (error || !data) {
    return (
      <CenterState>
        <AlertTriangle className="w-8 h-8 text-amber-500" />
        <h1 className="text-lg font-bold text-slate-900 mt-3">Link unavailable</h1>
        <p className="text-slate-500 text-sm mt-1">{error ?? "Invalid link."}</p>
      </CenterState>
    );
  }
  if (data.expired) {
    return (
      <CenterState>
        <Clock className="w-8 h-8 text-slate-400" />
        <h1 className="text-lg font-bold text-slate-900 mt-3">Link expired</h1>
        <p className="text-slate-500 text-sm mt-1">This action link has expired. Check the dashboard for the latest status.</p>
      </CenterState>
    );
  }

  const n = data.notification;
  const sensor = SENSOR_LABEL[(n.sensor_type as SensorType)] ?? n.sensor_type;
  const reading = n.reading_value != null
    ? `${n.sensor_type === "temp" ? n.reading_value.toFixed(1) : Math.round(n.reading_value)} ${n.reading_unit}`
    : "—";

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6">
      <div className="max-w-[520px] mx-auto">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 bg-red-600 text-white">
            <div className="text-[11px] font-bold tracking-widest opacity-80">A.I.R. — AIR MONITORING ALERT</div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <Badge label={n.level_label} tone={SEVERITY_TONE[(n.severity as AirSeverity) ?? "warning"]} />
              <span className="text-[13px] font-semibold">{sensor}: {reading}</span>
            </div>
            <h1 className="text-xl font-extrabold mt-1 mb-0 flex items-center gap-1.5">
              <MapPin className="w-5 h-5" /> {n.room_name}{n.floor ? ` — ${n.floor}` : ""}
            </h1>
            <p className="text-[12px] opacity-90 mt-0.5 mb-0">
              Device {n.device_id} · {manilaTime(n.created_at)} ({relativeTime(n.created_at)})
            </p>
          </div>

          <div className="px-5 py-4 space-y-4">
            <p className="text-[13px] text-slate-600 m-0">{n.message}</p>

            <div className="bg-teal-50/60 border border-teal-100 rounded-xl px-3.5 py-3 text-[12px] text-slate-600">
              You are responding as <b>{data.personnel_name}</b> ({data.personnel_role}). No login needed — this link identifies you.
            </div>

            {done && (
              <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 flex gap-2 text-teal-800 text-[13px]">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Recorded: <b>{ACTION_META.find((a) => a.key === done)?.label ?? done}</b>. Thank you — the dashboard has been updated.</span>
              </div>
            )}

            {data.actions.length > 0 && (
              <div>
                <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-1.5">Already acted on</div>
                {data.actions.map((a) => (
                  <div key={a.id} className="text-[12px] text-slate-600 border-b border-slate-50 py-1.5">
                    <b>{a.personnel_name}</b> ({a.personnel_role}) — {a.action.replace("_", " ")}
                    {a.note ? ` · “${a.note}”` : ""} · {relativeTime(a.taken_at)}
                  </div>
                ))}
                <p className="text-[11px] text-slate-400 mt-1">You can still add your own action or note below.</p>
              </div>
            )}

            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              placeholder="Optional note (e.g. doors open, equipment checked)…"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-[13px]" />

            <div className="grid gap-2">
              {ACTION_META.map((a) => (
                <button
                  key={a.key}
                  onClick={() => act(a.key)}
                  disabled={busy !== null}
                  className="w-full rounded-xl px-4 py-3 text-left border border-slate-200 disabled:opacity-50"
                  style={{
                    background: a.key === "acknowledge" || a.key === "on_my_way" ? "#fef2f2" : "#ecfdf5",
                    borderColor: a.key === "acknowledge" || a.key === "on_my_way" ? "#fecaca" : "#a7f3d0",
                  }}
                >
                  <span className="block text-[14px] font-bold" style={{ color: a.key === "acknowledge" || a.key === "on_my_way" ? "#b91c1c" : "#0f766e" }}>
                    {busy === a.key ? "Recording…" : a.label}
                  </span>
                  <span className="block text-[11px] text-slate-500 mt-0.5">{a.sub}</span>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 text-center m-0">Your action is recorded with your name and time.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CenterState({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl border border-slate-200 px-6 py-8 text-center max-w-[420px] w-full">
        {children}
      </div>
    </div>
  );
}
