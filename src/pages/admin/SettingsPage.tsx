import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AlertTriangle, Save, Shield, SlidersHorizontal, User } from "lucide-react";
import { Badge } from "../../ui";
import type { Thresholds } from "../../data/Data";
import {
  CO2_STANDARD,
  HUMIDITY_STANDARD,
  LPG_STANDARD,
  TEMP_STANDARD,
  buildOverviewRows,
  type ThresholdField,
  type ValidationErrors,
} from "../../lib/thresholdConfig";
import { useThresholdConfig } from "../../hooks/useThresholdConfig";

type Settings = {};

type AppUser = {
  role: string;
  name: string;
  email: string;
  roleLabel: string;
  department?: string;
  accessScope?: string;
};

interface SettingsPageProps {
  setSettings: (settings: Settings) => void;
  thresholds: Thresholds;
  setThresholds: (thresholds: Thresholds) => Promise<{ error: string | null }>;
  user: AppUser;
}

export default function SettingsPage({ setSettings, thresholds, setThresholds, user }: SettingsPageProps) {
  const isAdmin = user.role === "admin";
  const { validate, savedIsValid } = useThresholdConfig();

  const [localThresholds, setLocalThresholds] = useState<Thresholds>(thresholds);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Adopt a configuration saved elsewhere while this form is idle, so an update
  // from another session is picked up without a reload. Dirty forms are left
  // alone - overwriting unsaved edits because a background event fired would be
  // worse than showing a value that is one revision behind.
  useEffect(() => {
    if (!dirty) setLocalThresholds(thresholds);
  }, [thresholds, dirty]);

  // The overview previews what is being edited, so it shows the candidate
  // configuration while there are unsaved changes and the saved one otherwise.
  const overviewRows = useMemo(
    () => buildOverviewRows(dirty ? localThresholds : thresholds),
    [dirty, localThresholds, thresholds]
  );

  const { valid, errors } = useMemo(() => validate(localThresholds), [validate, localThresholds]);
  const errorCount = Object.keys(errors).length;

  function update<K extends keyof Thresholds>(group: K, field: string, value: number) {
    setLocalThresholds((prev) => ({
      ...prev,
      [group]: { ...prev[group], [field]: value },
    }));
    setDirty(true);
    setSaveState("idle");
    setSaveError(null);
  }

  async function save() {
    // The form is already validated, but the database enforces the same rule
    // through CHECK constraints and a non-admin write is rejected by RLS. Do
    // not fire a request that cannot succeed.
    if (!valid || !isAdmin) return;

    setSaveState("saving");
    setSettings({} as Settings);
    const result = await setThresholds(localThresholds);

    if (result?.error) {
      setSaveState("error");
      setSaveError(result.error);
      return;
    }

    setDirty(false);
    setSaveState("saved");
    setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
  }

  const field: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    fontSize: 13.5,
  };
  const smallLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: "#64748b" };

  return (
    <div>
      <style>{`
        .air-settings-grid {
          display: grid;
          grid-template-columns: 1fr 320px;
          gap: 16px;
          align-items: start;
        }
        .air-threshold-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        @media (max-width: 860px) {
          .air-settings-grid {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 420px) {
          .air-threshold-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", margin: 0 }}>
        Platform Safety & System Configuration
      </h1>
      <p style={{ color: "#64748b", fontSize: 13.5, margin: "4px 0 20px" }}>
        Manage alert notifications, safety limits, and user profile parameters
      </p>

      <div className="air-settings-grid">
        <div
          style={{
            background: "#fff",
            border: "1px solid #eef1f4",
            borderRadius: 12,
            padding: 18,
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontWeight: 700,
              fontSize: 14,
              color: "#0f172a",
              marginBottom: 14,
            }}
          >
            <SlidersHorizontal size={16} /> System Preferences & Safety Controls
          </div>

          {!isAdmin && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 10,
                padding: 10,
                marginBottom: 12,
                fontSize: 12.5,
                color: "#92400e",
              }}
            >
              <AlertTriangle size={14} /> You are signed in as {user.role || "a non-admin"}. You can view the
              active configuration, but only an administrator can change it.
            </div>
          )}

          <ThresholdGroup
            title="CO2 Safety Thresholds (ppm)"
            standard={CO2_STANDARD.label}
            values={localThresholds.co2}
            fields={[
              { key: "warning", label: "WARNING" },
              { key: "high", label: "HIGH" },
              { key: "danger", label: "DANGER" },
            ]}
            errorKeys={["co2.warning", "co2.high", "co2.danger"]}
            errors={errors}
            disabled={!isAdmin}
            fieldStyle={field}
            labelStyle={smallLabel}
            onChange={(key, value) => update("co2", key, value)}
            note="The device implements warning, alarm and critical tiers only. The intermediate tier above is dashboard-only."
          />

          <ThresholdGroup
            title="LPG Safety Thresholds (ppm)"
            standard={LPG_STANDARD.label}
            values={localThresholds.lpg}
            fields={[
              { key: "warning", label: "WARNING" },
              { key: "high", label: "HIGH (10% LEL, buzzer alarm)" },
              { key: "danger", label: "DANGER (20% LEL)" },
            ]}
            errorKeys={["lpg.warning", "lpg.high", "lpg.danger"]}
            errors={errors}
            disabled={!isAdmin}
            fieldStyle={field}
            labelStyle={smallLabel}
            onChange={(key, value) => update("lpg", key, value)}
            note={`Tiers are set as a fraction of the ${LPG_STANDARD.lelLabel} Lower Explosive Limit, not as a health exposure limit, because the hazard here is combustion.`}
          />

          <ThresholdGroup
            title="DHT22 Temperature Thresholds (°C)"
            standard={TEMP_STANDARD.label}
            values={localThresholds.temp}
            fields={[
              { key: "freezeBelow", label: "FREEZE BELOW" },
              { key: "coolBelow", label: "COOL BELOW" },
              { key: "heatAbove", label: "HEAT ABOVE" },
            ]}
            errorKeys={["temp.freezeBelow", "temp.coolBelow", "temp.heatAbove"]}
            errors={errors}
            disabled={!isAdmin}
            fieldStyle={field}
            labelStyle={smallLabel}
            onChange={(key, value) => update("temp", key, value)}
            note="Two-sided band: freeze below the first limit, cool below the second, heat above the third."
          />

          <ThresholdGroup
            title="DHT22 Humidity Thresholds (% RH)"
            standard={HUMIDITY_STANDARD.label}
            values={localThresholds.humidity}
            fields={[
              { key: "dryBelow", label: "DRY BELOW" },
              { key: "lowBelow", label: "LOW BELOW" },
              { key: "moldAbove", label: "MOLD ABOVE" },
            ]}
            errorKeys={["humidity.dryBelow", "humidity.lowBelow", "humidity.moldAbove"]}
            errors={errors}
            disabled={!isAdmin}
            fieldStyle={field}
            labelStyle={smallLabel}
            onChange={(key, value) => update("humidity", key, value)}
            note="Two-sided band within the DHT22's own 0-100 % RH measurement range."
          />

          {errorCount > 0 && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                background: "#fef2f2",
                border: "1px solid #fca5a5",
                borderRadius: 10,
                padding: 10,
                marginBottom: 12,
                fontSize: 12.5,
                color: "#991b1b",
              }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                {errorCount} field{errorCount === 1 ? "" : "s"} need attention. Each group must ascend: the first
                value below the second, the second below the third.
              </span>
            </div>
          )}

          {saveError && (
            <div
              role="alert"
              style={{
                background: "#fef2f2",
                border: "1px solid #fca5a5",
                borderRadius: 10,
                padding: 10,
                marginBottom: 12,
                fontSize: 12.5,
                color: "#991b1b",
              }}
            >
              Not saved: {saveError}
            </div>
          )}

          {isAdmin && (
            <button
              onClick={save}
              disabled={!valid || saveState === "saving"}
              title={
                !valid
                  ? "Fix the highlighted fields before saving"
                  : undefined
              }
              style={{
                background: valid && saveState !== "saving" ? "#0d9488" : "#94a3b8",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "11px 18px",
                fontSize: 13.5,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: valid && saveState !== "saving" ? "pointer" : "not-allowed",
              }}
            >
              <Save size={15} />
              {saveState === "saving"
                ? "Saving…"
                : saveState === "saved"
                ? "Configuration saved"
                : saveState === "error"
                ? "Save failed"
                : "Save Configuration"}
            </button>
          )}

          {!savedIsValid && (
            <p style={{ fontSize: 11.5, color: "#b91c1c", marginTop: 10, marginBottom: 0 }}>
              Warning: the currently saved configuration does not satisfy the ascending-order rule. Correct it and
              save to bring it back into line.
            </p>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              background: "#fff",
              border: "1px solid #eef1f4",
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 700,
                fontSize: 13,
                color: "#0f172a",
                marginBottom: 12,
              }}
            >
              <User size={15} /> Logged-in Personnel Details
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: "#0d9488",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                }}
              >
                {user.name.charAt(0)}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{user.name}</div>
                <div style={{ fontSize: 11.5, color: "#94a3b8" }}>{user.email}</div>
                <Badge label={user.roleLabel} tone="success" />
              </div>
            </div>
            <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: 10, fontSize: 12.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: "#94a3b8" }}>Department:</span>
                <span style={{ fontWeight: 600, textAlign: "right" }}>{user.department}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#94a3b8" }}>Access Scope:</span>
                <span style={{ fontWeight: 600 }}>{user.accessScope}</span>
              </div>
            </div>
          </div>

          {/* Generated from the saved values, so it cannot drift from them. */}
          <div
            style={{
              background: "#fff",
              border: "1px solid #eef1f4",
              borderRadius: 12,
              padding: 16,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 10 }}>
              ACTIVE CONFIGURATION OVERVIEW
            </div>
            {overviewRows.map((row) => (
              <div
                key={row.label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  fontSize: 12.5,
                  padding: "5px 0",
                }}
              >
                <span style={{ color: "#64748b" }}>{row.label}</span>
                <span style={{ fontWeight: 700, color: "#0d9488", textAlign: "right" }}>{row.value}</span>
              </div>
            ))}
            {dirty && (
              <div style={{ fontSize: 11, color: "#d97706", marginTop: 8 }}>
                Showing unsaved edits. Save to apply them platform-wide.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One threshold group: title, the standard it comes from, three ascending
 * inputs and their inline errors.
 *
 * Rendered from a description rather than written out four times, so a change
 * to the validation behaviour or the error presentation cannot be applied to
 * three groups and missed on the fourth.
 */
function ThresholdGroup({
  title,
  standard,
  values,
  fields,
  errorKeys,
  errors,
  disabled,
  fieldStyle,
  labelStyle,
  onChange,
  note,
}: {
  title: string;
  standard: string;
  values: object;
  fields: { key: string; label: string }[];
  /** Fully-qualified field names, so errors land on the right group. */
  errorKeys: ThresholdField[];
  errors: ValidationErrors;
  disabled: boolean;
  fieldStyle: CSSProperties;
  labelStyle: CSSProperties;
  onChange: (key: string, value: number) => void;
  note?: ReactNode;
}) {
  return (
    <div style={{ background: "#f8fafc", borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <Shield size={15} color="#0d9488" />
        <span style={{ fontWeight: 700, fontSize: 13.5, color: "#0f172a" }}>{title}</span>
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#0d9488", marginBottom: 10, paddingLeft: 23 }}>
        Standard: {standard}
      </div>
      <div className="air-threshold-grid">
        {fields.map((f, i) => {
          const errorKey = errorKeys[i];
          const error = errors[errorKey];
          return (
            <div key={f.key}>
              <label style={labelStyle}>{f.label}</label>
              <input
                type="number"
                disabled={disabled}
                aria-invalid={!!error}
                aria-describedby={error ? `${errorKey}-error` : undefined}
                style={{
                  ...fieldStyle,
                  marginTop: 4,
                  borderColor: error ? "#dc2626" : "#e2e8f0",
                  background: disabled ? "#f8fafc" : "#fff",
                }}
                value={(values as Record<string, number>)[f.key]}
                onChange={(e) => onChange(f.key, Number(e.target.value))}
              />
              {error && (
                <div
                  id={`${errorKey}-error`}
                  role="alert"
                  style={{ fontSize: 11, color: "#dc2626", marginTop: 4, lineHeight: 1.4 }}
                >
                  {error}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {note && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8, lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}