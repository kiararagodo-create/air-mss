// Shared SMS templates for the A.I.R. system.
// All SMS bodies are built here so wording and the 160-char limit stay consistent.

export type SensorReading = { name: string; value: string };

const SENSOR_NAMES: Record<string, string> = {
  co2: "CO2",
  lpg: "gas (LPG)",
  temp: "temperature",
  humidity: "humidity",
};

export function sensorName(key: string): string {
  return SENSOR_NAMES[key.toLowerCase()] ?? key;
}

export function manilaTime(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function trimRoom(room: string): string {
  const r = String(room ?? "").trim();
  return r.length > 24 ? r.slice(0, 24) : r;
}

function trimNote(note: string): string {
  const n = String(note ?? "").trim();
  return n.length > 40 ? n.slice(0, 40) : n;
}

function cap(msg: string): string {
  return msg.slice(0, 160);
}

export function buildDangerMessage(room: string, sensors: SensorReading[], time?: string): string {
  const t = time ?? manilaTime();
  const r = trimRoom(room || "device");
  const parts = sensors.map((s) => `${s.name} ${s.value}`).join(", ");
  return cap(`A.I.R. DANGER at ${r}: ${parts}. Go check now. ${t}`);
}

export function buildWarningMessage(room: string, sensors: SensorReading[], time?: string): string {
  const t = time ?? manilaTime();
  const r = trimRoom(room || "device");
  const parts = sensors.map((s) => `${s.name} is high (${s.value})`).join(", ");
  return cap(`A.I.R. WARNING at ${r}: ${parts}. Please check the room. ${t}`);
}

export function buildOfflineMessage(room: string, minutes: number, time?: string): string {
  const t = time ?? manilaTime();
  const r = trimRoom(room || "device");
  return cap(`A.I.R. OFFLINE at ${r}: sensor sent no data for ${minutes} min. Please check the device. ${t}`);
}

export function buildAcknowledgedMessage(userName: string, role: string, room: string, time?: string): string {
  const t = time ?? manilaTime();
  const r = trimRoom(room || "device");
  const name = String(userName ?? "").trim().slice(0, 24);
  const rl = String(role ?? "").trim().slice(0, 16);
  return cap(`A.I.R. UPDATE: ${name} (${rl}) is on the way to ${r}. ${t}`);
}

export function buildResolvedMessage(userName: string, role: string, room: string, note: string | null, time?: string): string {
  const t = time ?? manilaTime();
  const r = trimRoom(room || "device");
  const name = String(userName ?? "").trim().slice(0, 24);
  const rl = String(role ?? "").trim().slice(0, 16);
  const n = note ? trimNote(note) : "";
  const notePart = n ? ` ${n}.` : ".";
  return cap(`A.I.R. RESOLVED: ${name} (${rl}) fixed ${r}.${notePart} ${t}`);
}

export function buildAllClearMessage(room: string, time?: string): string {
  const t = time ?? manilaTime();
  const r = trimRoom(room || "device");
  return cap(`A.I.R. ALL CLEAR at ${r}: readings are back to normal. ${t}`);
}
