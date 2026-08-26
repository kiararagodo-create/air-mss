import { useState } from "react";
import { KeyRound, X, Eye, EyeOff } from "lucide-react";
import { useAuth } from "../context/AuthContext";

interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ChangePasswordModal({ open, onClose }: ChangePasswordModalProps) {
  const { updatePassword } = useAuth();

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  if (!open) return null;

  function reset() {
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setSuccess(false);
    setShowPasswords(false);
  }

  function handleClose() {
    // Don't let a stray close wipe out a success message mid-flight;
    // updatePassword() signs the user out right after success anyway.
    if (!submitting) {
      reset();
      onClose();
    }
  }

  async function handleSubmit() {
    setError(null);

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await updatePassword(newPassword);
    setSubmitting(false);

    if (updateError) {
      setError(updateError);
      return;
    }

    // updatePassword() signs the user out on success, so the app will
    // redirect to /login shortly after this renders.
    setSuccess(true);
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center px-4 z-[60] overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6 relative my-auto">
        <button
          onClick={handleClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-5 h-5 text-teal-600" />
          <h2 className="text-lg font-semibold text-slate-800">Change Password</h2>
        </div>

        {success ? (
          <div className="mt-4">
            <div className="text-sm text-teal-700 bg-teal-50 border border-teal-100 rounded-lg px-3 py-2">
              Password updated. You'll be signed out shortly — log back in with your new password.
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-500 mb-5">
              Choose a new password for your account.
            </p>

            {error && (
              <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1 tracking-wide">
                  NEW PASSWORD
                </label>
                <div className="flex items-center border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus-within:ring-2 focus-within:ring-teal-500">
                  <input
                    type={showPasswords ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    className="bg-transparent outline-none w-full text-sm text-slate-700"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPasswords((s) => !s)}
                    aria-label={showPasswords ? "Hide passwords" : "Show passwords"}
                    className="text-slate-400 hover:text-slate-600 shrink-0"
                  >
                    {showPasswords ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1 tracking-wide">
                  CONFIRM NEW PASSWORD
                </label>
                <div className="flex items-center border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus-within:ring-2 focus-within:ring-teal-500">
                  <input
                    type={showPasswords ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    className="bg-transparent outline-none w-full text-sm text-slate-700"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !newPassword || !confirmPassword}
                className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg transition-colors"
              >
                {submitting ? "Updating..." : "Update Password"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
