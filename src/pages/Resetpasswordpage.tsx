import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Wind,
  Lock,
  KeyRound,
  AlertTriangle,
  Loader2,
  Eye,
  EyeOff,
  ArrowLeft,
  CheckCircle2,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { supabase } from "../lib/supabase";

// Supabase strips the recovery fragment from the URL only after it has
// exchanged the token for a session (GoTrueClient "_initialize" ->
// history.replaceState), so the hash is still intact during first render.
// Snapshotting it here gives us a synchronous answer to "did this page open
// from a recovery link?" that doesn't depend on catching the event.
function hadRecoveryLinkInUrl(): boolean {
  if (typeof window === "undefined") return false;
  const { hash, search } = window.location;
  return /type=recovery/.test(hash) || /type=recovery/.test(search);
}

// How long to wait for the recovery session before declaring the link
// unusable. The exchange is a single network round trip, so anything past a
// few seconds is a dead or tampered link, not a slow network.
const RECOVERY_TIMEOUT_MS = 8000;

type Phase = "checking" | "ready" | "invalid";

export default function ResetPasswordPage() {
  const { updatePassword } = useAuth();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>("checking");
  const [fromRecoveryLink] = useState(hadRecoveryLinkInUrl);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let settled = false;
    let timer: number | undefined;

    const ready = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      setPhase("ready");
    };

    const invalidate = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      setPhase("invalid");
    };

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") ready();
    });

    // Not opened from a recovery link at all - no amount of waiting helps.
    if (!fromRecoveryLink) {
      invalidate();
    } else {
      // Safety net: if the notification were ever missed, fall back to asking
      // whether a recovery session actually exists.
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) ready();
      });

      timer = window.setTimeout(invalidate, RECOVERY_TIMEOUT_MS);
    }

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, [fromRecoveryLink]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    // updatePassword() calls updateUser() and then signs out, so the session
    // that authorises this change is spent by the time it resolves.
    const { error: updateError } = await updatePassword(password);
    setSubmitting(false);

    if (updateError) {
      setError(updateError);
      return;
    }

    setDone(true);
    navigate("/login", {
      replace: true,
      state: { message: "Password updated. Please sign in." },
    });
  }

  function requestNewLink() {
    // Hand off to the login page's forgot-password form, prefilled.
    navigate("/login", { replace: true, state: { openForgot: true } });
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-b from-teal-50/60 to-white px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-teal-600 flex items-center justify-center mb-4">
            <Wind className="w-7 h-7 text-white" strokeWidth={2.25} />
          </div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">A.I.R.</h1>
          <p className="text-sm text-slate-500 mt-1">Real-time CO2, LPG, Temp & Humidity Monitoring</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          {phase === "checking" && (
            <div className="flex flex-col items-center py-6 text-center">
              <Loader2 className="w-6 h-6 text-teal-600 animate-spin mb-4" />
              <h2 className="text-sm font-medium text-slate-800">Checking your reset link...</h2>
              <p className="text-sm text-slate-500 mt-1">This only takes a moment.</p>
            </div>
          )}

          {phase === "invalid" && (
            <>
              <div className="flex items-center gap-2 mb-5 text-slate-800">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <h2 className="text-sm font-medium">This reset link is no longer valid</h2>
              </div>

              <p className="text-sm text-slate-500 mb-5">
                Reset links expire after a short time and can only be used once. If
                you already used this one, request a new link to finish setting
                your password.
              </p>

              <button
                type="button"
                onClick={requestNewLink}
                className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
              >
                Request a new link
              </button>

              <button
                type="button"
                onClick={() => navigate("/login", { replace: true })}
                className="w-full flex items-center justify-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 py-2 mt-1"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to sign in
              </button>
            </>
          )}

          {phase === "ready" && (
            <>
              <div className="flex items-center gap-2 mb-5 text-slate-800">
                <KeyRound className="w-4 h-4 text-teal-600" />
                <h2 className="text-sm font-medium">Choose a New Password</h2>
              </div>

              {done ? (
                <div className="text-center py-4">
                  <div className="w-12 h-12 rounded-full bg-teal-50 flex items-center justify-center mx-auto mb-4">
                    <CheckCircle2 className="w-6 h-6 text-teal-600" />
                  </div>
                  <p className="text-sm text-slate-700 font-medium">
                    Password updated. Please sign in.
                  </p>
                </div>
              ) : (
                <>
                  {error && (
                    <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                      {error}
                    </div>
                  )}

                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium tracking-wide text-slate-500 mb-1.5">
                        NEW PASSWORD
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type={showPasswords ? "text" : "password"}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Minimum 8 characters"
                          autoComplete="new-password"
                          className="w-full pl-9 pr-10 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPasswords((prev) => !prev)}
                          aria-label={showPasswords ? "Hide passwords" : "Show passwords"}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showPasswords ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium tracking-wide text-slate-500 mb-1.5">
                        CONFIRM NEW PASSWORD
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type={showPasswords ? "text" : "password"}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="Re-enter new password"
                          autoComplete="new-password"
                          className="w-full pl-9 pr-10 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting || !password || !confirmPassword}
                      className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-400 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Updating...
                        </>
                      ) : (
                        "Update Password"
                      )}
                    </button>
                  </form>
                </>
              )}

              {!done && (
                <button
                  type="button"
                  onClick={() => navigate("/login", { replace: true })}
                  className="w-full flex items-center justify-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 py-2 mt-2"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to sign in
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}