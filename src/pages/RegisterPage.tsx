import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  Wind,
  Mail,
  Lock,
  User,
  Loader2,
  Eye,
  EyeOff,
  CheckCircle2,
  ArrowLeft,
  Briefcase,
  Phone,
} from "lucide-react";
import { supabase } from "../lib/supabase";

// Public self-registration. Creates the account with account_status = 'pending';
// an admin must approve it before the person can sign in (enforced in
// AuthContext.login()).
export default function RegisterPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [role, setRole] = useState<"security" | "maintenance">("security");
  const [department, setDepartment] = useState("");
  const [contactNumber, setContactNumber] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!fullName.trim() || !email.trim() || !password) {
      setError("Full name, email and password are all required.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("The two passwords do not match.");
      return;
    }

    setLoading(true);
    const { data, error: fnError } = await supabase.functions.invoke("self-register", {
      body: {
        name: fullName.trim(),
        email: email.trim(),
        password,
        role,
        department: department.trim() || null,
        contact_number: contactNumber.trim() || null,
      },
    });

    setLoading(false);

    if (fnError) {
      setError(fnError.message);
      return;
    }

    const result = data as { success?: boolean; error?: string } | null;
    if (!result?.success) {
      setError(result?.error ?? "Registration failed. Please try again.");
      return;
    }

    setSubmitted(true);
  }

  if (submitted) {
    return (
      <Shell>
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <CheckCircle2 size={48} color="#0d9488" style={{ marginBottom: 14 }} />
          <h2 style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", margin: "0 0 8px" }}>
            Registration received
          </h2>
          <p style={{ fontSize: 13.5, color: "#64748b", lineHeight: 1.7, margin: "0 auto 18px", maxWidth: 420 }}>
            Your account has been created and is awaiting administrator approval. You will be able to sign
            in once an admin approves it. Approved administrators are notified automatically.
          </p>
          <Link
            to="/login"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "#0d9488",
              color: "#fff",
              borderRadius: 8,
              padding: "11px 20px",
              fontSize: 13.5,
              fontWeight: 700,
              textDecoration: "none",
            }}
          >
            <ArrowLeft size={15} /> Back to sign in
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h2 style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", margin: "0 0 4px" }}>
        Create an account
      </h2>
      <p style={{ fontSize: 12.5, color: "#94a3b8", margin: "0 0 18px", lineHeight: 1.6 }}>
        New accounts require administrator approval before they can sign in.
      </p>

      {error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12.5,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field icon={<User size={14} />}>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Full name"
            autoComplete="name"
            style={inputStyle}
          />
        </Field>

        <Field icon={<Mail size={14} />}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            autoComplete="email"
            style={inputStyle}
          />
        </Field>

        <Field icon={<Briefcase size={14} />}>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "security" | "maintenance")}
            style={inputStyle}
          >
            <option value="security">Security Personnel</option>
            <option value="maintenance">Maintenance Personnel</option>
          </select>
        </Field>

        <Field icon={<Briefcase size={14} />}>
          <input
            type="text"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="Department / office (optional)"
            style={inputStyle}
          />
        </Field>

        <Field icon={<Phone size={14} />}>
          <input
            type="tel"
            value={contactNumber}
            onChange={(e) => setContactNumber(e.target.value)}
            placeholder="Contact number (optional)"
            style={inputStyle}
          />
        </Field>

        <Field icon={<Lock size={14} />}>
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (minimum 8 characters)"
            autoComplete="new-password"
            style={inputStyle}
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#94a3b8",
              padding: 4,
              display: "flex",
            }}
          >
            {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </Field>

        <Field icon={<Lock size={14} />}>
          <input
            type={showPassword ? "text" : "password"}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            autoComplete="new-password"
            style={inputStyle}
          />
        </Field>

        <button
          type="submit"
          disabled={loading}
          style={{
            background: "#0d9488",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "12px 16px",
            fontSize: 14,
            fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginTop: 4,
          }}
        >
          {loading ? <Loader2 size={16} className="spin" /> : null}
          {loading ? "Submitting..." : "Request an account"}
        </button>
      </form>

      <p style={{ fontSize: 12.5, color: "#94a3b8", textAlign: "center", margin: "16px 0 0" }}>
        Already have an account?{" "}
        <Link to="/login" style={{ color: "#0d9488", fontWeight: 700 }}>
          Sign in
        </Link>
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(160deg, #f0fdfa 0%, #f8fafc 55%, #ecfeff 100%)",
        padding: "24px 16px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          background: "#fff",
          border: "1px solid #eef1f4",
          borderRadius: 14,
          padding: 26,
          boxShadow: "0 10px 40px rgba(13,148,136,0.07)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 18 }}>
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              background: "#0d9488",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Wind size={18} />
          </span>
          <span style={{ fontWeight: 800, fontSize: 15, color: "#0f172a" }}>
            A.I.R. Sensor Monitoring
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ position: "relative" }}>
      <span
        style={{
          position: "absolute",
          left: 11,
          top: "50%",
          transform: "translateY(-50%)",
          color: "#94a3b8",
          display: "flex",
          pointerEvents: "none",
        }}
      >
        {icon}
      </span>
      <div style={{ paddingLeft: 34 }}>{children}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 13.5,
  color: "#0f172a",
  outline: "none",
};