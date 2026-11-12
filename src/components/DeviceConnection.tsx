// src/components/DeviceConnection.tsx
//
// The two pieces of every online/offline indicator in the app:
//
//   * <ConnectionPill>   - the small green/red dot pill that sits next to the
//                          air-quality badge.
//   * <LastSeenLine>     - "Last seen 2 min ago" under the room name, plus
//                          "Offline since 2:11 PM" (Asia/Manila) when the
//                          device has gone quiet.
//
// Both read through the shared useDeviceConnectivity hook, so the dashboard's
// Monitored Rooms list, the Devices page and the offline SMS all work from the
// same threshold. They are components rather than plain values because a list
// renders one per room and hooks may not be called inside .map().

import { useDeviceConnectivity } from "../hooks/useDeviceConnectivity";

interface Props {
  /** The device's newest signal: latest reading created_at, or rooms.last_seen. */
  lastReadingAt: string | null;
}

const ONLINE = {
  dot: "#10b981",
  text: "#047857",
  bg: "#ECFDF5",
  border: "#A7F3D0",
} as const;

const OFFLINE = {
  dot: "#ef4444",
  text: "#b91c1c",
  bg: "#FEF2F2",
  border: "#FCA5A5",
} as const;

/**
 * Green "Online" / red "Offline" dot pill. Compact enough to sit beside the
 * severity badge and to survive a 360 px screen without wrapping.
 */
export function ConnectionPill({ lastReadingAt }: Props) {
  const { online, lastSeenLabel, offlineSinceLabel } = useDeviceConnectivity(lastReadingAt);
  const c = online ? ONLINE : OFFLINE;
  const hint = offlineSinceLabel ? `${lastSeenLabel} · ${offlineSinceLabel}` : lastSeenLabel;
  return (
    <span
      title={hint}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        borderRadius: 999,
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.text,
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1.3,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: c.dot,
          flexShrink: 0,
        }}
      />
      {online ? "Online" : "Offline"}
    </span>
  );
}

/**
 * "Last seen 2 min ago" - always shown under the room name - and, while the
 * device is offline, the exact wall-clock time it went quiet in Asia/Manila.
 *
 * The text re-renders on the shared 15 s tick, so it counts up on its own.
 */
export function LastSeenLine({ lastReadingAt, style }: Props & { style?: React.CSSProperties }) {
  const { lastSeenLabel, offlineSinceLabel } = useDeviceConnectivity(lastReadingAt);
  return (
    <span
      style={{
        display: "block",
        fontSize: 11,
        lineHeight: 1.4,
        color: "#64748b",
        ...style,
      }}
    >
      {lastSeenLabel}
      {offlineSinceLabel && (
        <>
          {" · "}
          <span style={{ color: "#dc2626", fontWeight: 700 }}>{offlineSinceLabel}</span>
        </>
      )}
    </span>
  );
}
