import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Wind,
  Mail,
  Lock,
  ArrowRight,
  ShieldCheck,
  Loader2,
  Eye,
  EyeOff,
  KeyRound,
  ArrowLeft,
  CheckCircle2,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";

export default function LoginPage() {
  const [mode, setMode] = useState<"signin" | "forgot">("signin");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [resetEmail, setResetEmail] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setLoading(true);
    const { error } = await login(email, password);
    setLoading(false);

    if (error) {
      setError(error);
      return;
    }

    navigate("/dashboard", { replace: true });
  }

  async function handleResetSubmit(e: FormEvent) {
    e.preventDefault();
    setResetError(null);

    if (!resetEmail) {
      setResetError("Please enter your email address.");
      return;
    }

    setResetLoading(true);
    const { error } = await resetPass(resetEmail);
    setResetLoading(false);

    if (error ) {
      setResetError(error);
      return;
    }

    setResetSent(true);
  }

  function switchToForgot() {
    setResetEmail(email);
    setResetError(null);
    setResetSent(false);
    setMode("forgot");
  }

  function switchToSignIn() {
    setError(null);
    setMode("signin");
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
          {mode === "signin" ? (
            <>
              <div className="flex items-center gap-2 mb-5 text-slate-800">
                <ShieldCheck className="w-4 h-4 text-teal-600" />
                <h2 className="text-sm font-medium">Sign In to Dashboard</h2>
              </div>

              {error && (
                <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium tracking-wide text-slate-500 mb-1.5">
                    EMAIL ADDRESS
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="user email"
                      autoComplete="email"
                      className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-medium tracking-wide text-slate-500">
                      PASSWORD
                    </label>
                    <button
                      type="button"
                      onClick={switchToForgot}
                      className="text-xs font-medium text-teal-600 hover:text-teal-700"
                    >
                   
                    </button>
                  </div>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      className="w-full pl-9 pr-10 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      tabIndex={-1}
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-400 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Signing In...
                    </>
                  ) : (
                    <>
                      Sign In
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-5 text-slate-800">
                <KeyRound className="w-4 h-4 text-teal-600" />
                <h2 className="text-sm font-medium">Reset Your Password</h2>
              </div>

              {resetSent ? (
                <div className="text-center py-4">
                  <div className="w-12 h-12 rounded-full bg-teal-50 flex items-center justify-center mx-auto mb-4">
                    <CheckCircle2 className="w-6 h-6 text-teal-600" />
                  </div>
                  <p className="text-sm text-slate-700 font-medium mb-1">Check your email</p>
                  <p className="text-sm text-slate-500 mb-6">
                    We sent a password reset link to <span className="font-medium text-slate-700">{resetEmail}</span>.
                    Follow the link to choose a new password.
                  </p>
                  <button
                    type="button"
                    onClick={switchToSignIn}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-600 hover:text-teal-700"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back to sign in
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-slate-500 mb-4">
                    Enter the email associated with your account and we'll send you a link to reset your password.
                  </p>

                  {resetError && (
                    <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                      {resetError}
                    </div>
                  )}

                  <form onSubmit={handleResetSubmit} className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium tracking-wide text-slate-500 mb-1.5">
                        EMAIL ADDRESS
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="email"
                          value={resetEmail}
                          onChange={(e) => setResetEmail(e.target.value)}
                          placeholder="kiararagodo@gmail.com"
                          autoComplete="email"
                          className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={resetLoading}
                      className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 disabled:bg-teal-400 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors"
                    >
                      {resetLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Sending...
                        </>
                      ) : (
                        "Send Reset Link"
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={switchToSignIn}
                      className="w-full flex items-center justify-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 py-1"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back to sign in
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function resetPass(_resetEmail: string): { error: any; } | PromiseLike<{ error: any; }> {
  throw new Error("Function not implemented.");
}