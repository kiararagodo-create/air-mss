// src/components/SendSmsDialog.tsx
//
// Manual SMS dialog (B): recipient checklist (active personnel with a
// contact number, severity-based preselect, no-number rows disabled),
// editable message with character/segment counter, provider credits preview,
// confirm step, 30-minute cooldown warning with admin "Send anyway", and
// per-recipient results. Sending happens ONLY via the send-sms Edge
// Function; provider API keys never reach the browser. No SMS is sent on
// page load or from anywhere else in the browser.

import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageSquareText, Search, Send, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { getPermissions } from "../lib/permissions";
import {
  fetchPersonnel, fetchSmsCredits, maskPhone, prefillAlertMessage, preselectRoleIds,
  readableProviderError, sendSmsManual, smsSegments, testSmsConnection, type AlertRef, type PersonnelRow, type SmsSendResult,
} from "../lib/alertActions";

interface Props {
  open: boolean;
  onClose: () => void;
  ref_: AlertRef;
  severity?: string;
  levelLabel?: string;
  custom?: boolean;
  onSent?: ((info: { ok: boolean; results: SmsSendResult[] }) => void) | void;
}

type Step = "compose" | "confirm" | "done";

export default function SendSmsDialog({ open, onClose, ref_, severity, levelLabel, custom, onSent }: Props) {
  const { profile, role } = useAuth();
  const perms = getPermissions((role ?? "") as any);
  const [step, setStep] = useState<Step>("compose");
  const [personnel, setPersonnel] = useState<PersonnelRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [creditInfo, setCreditInfo] = useState<{ credits: number | null; providerLabel: string; authError: string | null }>({ credits: null, providerLabel: "SMS", authError: null });
  const credits = creditInfo.credits;
  const providerLabel = creditInfo.providerLabel;
  const authError = creditInfo.authError;
  const [cooldown, setCooldown] = useState<{ last: string | null } | null>(null);
  const [sendAnyway, setSendAnyway] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<SmsSendResult[]>([]);
  const [connChecking, setConnChecking] = useState(false);
  const [connResult, setConnResult] = useState<{ tokenValid: boolean; creditsLeft: number | null; error: string | null } | null>(null);

  const canSend = perms.canSendSms;

  useEffect(() => {
    if (!open) return;
    setStep("compose"); setError(null); setCooldown(null); setSendAnyway(false);
    setResults([]); setSearch("");
    setMessage(custom ? "" : prefillAlertMessage(ref_));
    setLoading(true);
    fetchPersonnel()
      .then((rows) => {
        setPersonnel(rows);
        setSelected(custom ? new Set() : preselectRoleIds(rows, severity ?? "", levelLabel ?? ""));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load personnel."))
      .finally(() => setLoading(false));
    fetchSmsCredits().then(setCreditInfo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const seg = useMemo(() => smsSegments(message), [message]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return personnel;
    return personnel.filter((p) => `${p.name} ${p.role}`.toLowerCase().includes(q));
  }, [personnel, search]);

  const chosen = personnel.filter((p) => selected.has(p.id));
  const chosenCount = chosen.length;
  const creditsLow = credits !== null && credits < chosenCount;
  const creditsOut = credits !== null && credits === 0;

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function doSend(anyway: boolean) {
    setSending(true); setError(null);
    const res = await sendSmsManual({
      ref: ref_, recipientIds: [...selected], message: message.trim(), sendAnyway: anyway,
    });
    setSending(false);
    if (res.cooldown) { setCooldown({ last: res.last_sent_at ?? null }); setStep("compose"); return; }
    if (!res.ok && res.results.length === 0) { setError(readableProviderError(res.error, res.providerLabel ?? providerLabel)); return; }
    if (res.credits !== null || res.providerLabel) {
      setCreditInfo((prev) => ({ ...prev, credits: res.credits ?? null, providerLabel: res.providerLabel ?? prev.providerLabel }));
    }
    setResults(res.results);
    setStep("done");
    onSent?.({ ok: res.ok, results: res.results });
  }

  if (!open || !canSend) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-[620px] max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-xl">
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-4 flex items-start justify-between z-10">
          <div>
            <h2 className="text-[16px] font-bold text-slate-900 m-0 flex items-center gap-2">
              <MessageSquareText size={17} className="text-teal-700" />
              {custom ? "Send custom SMS" : "Send SMS alert"}
            </h2>
            <p className="text-[12px] text-slate-400 mt-0.5 mb-0">
              Sent by {profile?.name ?? "you"} ({profile?.role ?? role}) via <b>iProg SMS</b>. The message is sent by the server, never from this browser.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">{error}</div>}

          {step === "done" ? (
            <div>
              <h3 className="text-sm font-bold text-slate-800 mb-2">Results</h3>
              {results.length === 0 && <p className="text-sm text-slate-400">No recipients were sent.</p>}
              <ul className="space-y-1.5">
                {results.map((r) => (
                  <li key={r.personnel_id} className="flex items-center justify-between gap-3 border border-slate-100 rounded-xl px-3 py-2 text-[12px]">
                    <span className="font-medium text-slate-700">{r.name} <span className="text-slate-400">({r.role})</span></span>
                    <span className={r.status === "submitted" ? "text-teal-700 font-semibold" : "text-red-600 font-semibold"}>
                      {r.status === "submitted" ? "Sent" : r.status === "skipped_no_number" ? "Skipped — no number" : `Failed: ${readableProviderError(r.error, providerLabel)}`}
                    </span>
                  </li>
                ))}
              </ul>
              <button onClick={onClose} className="mt-4 w-full py-2.5 rounded-xl bg-teal-600 text-white text-sm font-bold">Close</button>
            </div>
          ) : (
            <>
              {/* Recipients */}
              <div>
                <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                  <h3 className="text-[13px] font-bold text-slate-800">Recipients ({chosenCount} selected)</h3>
                  <div className="relative w-48">
                    <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search personnel…"
                      className="w-full pl-8 pr-2 py-1.5 border border-slate-200 rounded-lg text-[12px]" />
                  </div>
                </div>
                {loading ? (
                  <p className="text-sm text-slate-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading personnel…</p>
                ) : visible.length === 0 ? (
                  <p className="text-sm text-slate-400">No active personnel found.</p>
                ) : (
                  <ul className="divide-y divide-slate-50 border border-slate-100 rounded-xl max-h-52 overflow-y-auto">
                    {visible.map((p) => {
                      const noNumber = !p.contact_number || !p.contact_number.trim();
                      return (
                        <li key={p.id}>
                          <label className={`flex items-center gap-3 px-3 py-2 text-[13px] ${noNumber ? "opacity-50" : "cursor-pointer hover:bg-slate-50"}`}>
                            <input type="checkbox" checked={selected.has(p.id)} disabled={noNumber} onChange={() => toggle(p.id)} />
                            <span className="flex-1">
                              <span className="block font-medium text-slate-800">{p.name}</span>
                              <span className="block text-[11px] text-slate-400 capitalize">{p.role}</span>
                            </span>
                            <span className="text-[11px] text-slate-500">{noNumber ? "No contact number" : maskPhone(p.contact_number)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Message */}
              <div>
                <label className="text-[13px] font-bold text-slate-800 block mb-1.5">
                  Message {custom && <span className="font-normal text-slate-400">(custom mode — free text)</span>}
                </label>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
                  placeholder={custom ? "e.g. Please check Room 106" : "Alert message…"}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-[13px]" />
                <p className="text-[11px] text-slate-400 mt-1">
{seg.chars} characters · {seg.segments} SMS segment{seg.segments === 1 ? "" : "s"} ({seg.encoding})
                </p>
              </div>

              {/* Credits preview */}
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-3.5 py-3 text-[12px] text-slate-600">
                This will send <b>{chosenCount} SMS</b> (about {chosenCount * seg.segments} credits) via <b>iProg SMS</b>.
                {" "}{credits === null
                  ? `iProg credits: unknown`
                  : `iProg credits: ${credits}.`}
                {creditsLow && !creditsOut && (
                  <span className="block text-amber-600 font-semibold mt-0.5">
                    Administrator warning: iProg credits ({credits}) are below the number of messages ({chosenCount}).
                  </span>
                )}
                {creditsOut && <span className="block text-red-600 font-bold mt-0.5">Sending is blocked: iProg credits are 0. Top up your iProg account, then try again.</span>}
              </div>

              {role === "admin" && (
                <div className="bg-slate-50 border border-slate-100 rounded-xl px-3.5 py-3 text-[12px] text-slate-600 flex items-center justify-between gap-3 flex-wrap">
                  <span>
                    Connection check:
                    {connResult === null
                      ? " not run"
                      : connResult.error
                      ? ` Failed — ${connResult.error}`
                      : connResult.tokenValid
                      ? ` OK — ${connResult.creditsLeft ?? "?"} credits left`
                      : " Failed"}
                  </span>
                  <button
                    type="button"
                    disabled={connChecking}
                    onClick={async () => {
                      setConnChecking(true);
                      const r = await testSmsConnection();
                      setConnResult(r);
                      setConnChecking(false);
                      if (r.creditsLeft !== null) setCreditInfo((prev) => ({ ...prev, credits: r.creditsLeft }));
                    }}
                    className="text-[12px] font-semibold text-teal-700 border border-teal-200 rounded-lg px-3 py-1.5 hover:bg-teal-50 disabled:opacity-50"
                  >
                    {connChecking ? "Checking…" : "Check SMS connection"}
                  </button>
                </div>
              )}

              {authError && (
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[12px] text-red-700">
                  <b>{providerLabel} authentication failed ({authError}).</b> The provider rejected the configured API
                  key/secret — this is a credentials problem, not a recipient or message problem.
                  Fix: iProg dashboard → API token, verify the <b>full, unmasked</b> API token, then redeploy:
                  <code>supabase secrets set IPROG_SMS_API_TOKEN=…</code>. Sending is blocked until then.
                </div>
              )}

              {cooldown && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[12px] text-amber-800">
                  <b>Cooldown:</b> an SMS for this alert was sent in the last 30 minutes
                  {cooldown.last ? ` (${new Date(cooldown.last).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })})` : ""}.
                  {role === "admin" ? (
                    <label className="flex items-center gap-2 mt-2 font-medium">
                      <input type="checkbox" checked={sendAnyway} onChange={(e) => setSendAnyway(e.target.checked)} />
                      Send anyway (Administrator override)
                    </label>
                  ) : (
                    <span className="block mt-1 font-medium">Only an Administrator can send anyway. Wait or ask an admin.</span>
                  )}
                </div>
              )}

              {step === "compose" ? (
                <button
                  disabled={sending || chosenCount === 0 || !message.trim() || creditsOut || !!authError}
                  onClick={() => setStep("confirm")}
                  className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-bold disabled:opacity-50 inline-flex items-center justify-center gap-2"
                >
                  <Send size={14} /> Review send
                </button>
              ) : (
                <div className="bg-teal-50/60 border border-teal-100 rounded-xl px-4 py-3">
                  <p className="text-[13px] font-bold text-slate-800 m-0">Send to {chosenCount} personnel?</p>
                  <p className="text-[12px] text-slate-500 mt-0.5">Each selected recipient gets one SMS with a personal /action link (24h) when this is tied to an alert.</p>
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => setStep("compose")} className="flex-1 py-2 rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600">Back</button>
                    <button disabled={sending} onClick={() => doSend(sendAnyway)}
                      className="flex-1 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-[13px] font-bold disabled:opacity-50 inline-flex items-center justify-center gap-2">
                      {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                      {sending ? "Sending…" : `Send ${chosenCount} SMS`}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
