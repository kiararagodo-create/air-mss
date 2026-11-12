import { Circle } from "lucide-react";

export type Tone = "success" | "warning" | "high" | "danger" | "neutral";

interface ToneStyle {
  bg: string;
  text: string;
  border: string;
}

// Central tone -> color map. Every badge, dot, and status color in the
// dashboard pages pulls from here, so this is the single place to retint.
const TONE_STYLES: Record<Tone, ToneStyle> = {
  success: { bg: "#ECFDF5", text: "#0d9488", border: "#A7F3D0" },
  warning: { bg: "#FFFBEB", text: "#d97706", border: "#FDE68A" },
  high: { bg: "#FFF1E8", text: "#EA6C2E", border: "#FCD5B8" },
  danger: { bg: "#FEF2F2", text: "#dc2626", border: "#FCA5A5" },
  neutral: { bg: "#F1F5F9", text: "#64748b", border: "#E2E8F0" },
};

export function badgeStyles(tone: Tone): ToneStyle {
  return TONE_STYLES[tone] || TONE_STYLES.neutral;
}

interface BadgeProps {
  label: string;
  tone: Tone;
}

export function Badge({ label, tone }: BadgeProps) {
  const s = badgeStyles(tone);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 10.5,
        fontWeight: 700,
        color: s.text,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 6,
        padding: "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

interface ToneDotProps {
  tone: Tone;
}

export function ToneDot({ tone }: ToneDotProps) {
  const s = badgeStyles(tone);
  return <Circle size={8} fill={s.text} color={s.text} />;
}

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      style={{
        width: 40,
        height: 22,
        borderRadius: 999,
        border: "none",
        background: checked ? "#0d9488" : "#cbd5e1",
        position: "relative",
        cursor: "pointer",
        transition: "background 0.2s ease",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.2s ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

export function Input({ label, ...props }: { label: string; [key: string]: any }) {
  // eslint-disable-next-line react/prop-types
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem" }}>{label}</label>
      <input {...props} style={{ width: "100%", padding: "0.5rem", border: "1px solid #ccc", borderRadius: "4px" }} />
    </div>
  );
}

export function Table({ children, ...props }: { children: React.ReactNode; [key: string]: any }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }} {...props}>
      <tbody>{children}</tbody>
    </table>
  );
}

export function TableHeader({ children }: { children: React.ReactNode; [key: string]: any }) {
  return (
    <tr style={{ borderBottom: "1px solid #dee2e6" }}>
      {children}
    </tr>
  );
}

export function TableRow({ children, ...props }: { children: React.ReactNode; [key: string]: any }) {
  return (
    <tr {...props}>
      {children}
    </tr>
  );
}

export function TableCell({ children }: { children: React.ReactNode; [key: string]: any }) {
  return (
    <td style={{ padding: "0.5rem", border: "1px solid #dee2e6" }}>
      {children}
    </td>
  );
}

export function Select({
  label,
  value,
  onChange,
  children,
  ...props
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  [key: string]: any;
}) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem" }}>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} {...props}>
        {children}
      </select>
    </div>
  );
}

export function SelectContent({ children }: { children: React.ReactNode; [key: string]: any }) {
  return <div style={{ maxHeight: "200px", overflowY: "auto" }}>{children}</div>;
}

export function SelectItem({ children, ...props }: { children: React.ReactNode; [key: string]: any }) {
  return <div style={{ padding: "0.5rem", cursor: "pointer" }} {...props}>{children}</div>;
}

export function Pagination({ ...props }: { [key: string]: any }) {
  return (
    <nav aria-label="Page navigation">
      <ul style={{ display: "flex", listStyle: "none", padding: 0, margin: 0 }} {...props}>
        <li style={{ marginRight: "0.5rem" }}>
          <a href="#" style={{ textDecoration: "none", color: "currentColor" }}>
            Previous
          </a>
        </li>
        <li style={{ marginRight: "0.5rem" }}>
          <a href="#" style={{ textDecoration: "none", color: "currentColor" }}>
            Next
          </a>
        </li>
      </ul>
    </nav>
  );
}

