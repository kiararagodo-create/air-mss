import {
  buildDangerMessage,
  buildWarningMessage,
  buildOfflineMessage,
  buildAcknowledgedMessage,
  buildResolvedMessage,
  buildAllClearMessage,
} from "./sms_templates.ts";

const cases: { name: string; msg: string }[] = [
  { name: "Danger", msg: buildDangerMessage("Very Long Conference Room Name 12345", [{ name: "gas (LPG)", value: "9999 ppm" }, { name: "CO2", value: "9999 ppm" }, { name: "temperature", value: "99.9 C" }, { name: "humidity", value: "100 %" }], "11:59 PM") },
  { name: "Warning", msg: buildWarningMessage("Very Long Conference Room Name 12345", [{ name: "CO2", value: "9999 ppm" }, { name: "humidity", value: "99 %" }], "11:59 PM") },
  { name: "Offline", msg: buildOfflineMessage("Very Long Conference Room Name 12345", 999, "11:59 PM") },
  { name: "Acknowledged", msg: buildAcknowledgedMessage("Very Long Person Name Here", "Maintenance Personnel", "Very Long Conference Room Name 12345", "11:59 PM") },
  { name: "Resolved", msg: buildResolvedMessage("Very Long Person Name Here", "Maintenance Personnel", "Very Long Conference Room Name 12345", "Trimmed note that is definitely longer than forty characters in total", "11:59 PM") },
  { name: "AllClear", msg: buildAllClearMessage("Very Long Conference Room Name 12345", "11:59 PM") },
];

for (const c of cases) {
  console.log(`${c.name}: ${c.msg.length} chars -> ${c.msg}`);
  if (c.msg.length > 160) throw new Error(`${c.name} exceeds 160 chars (${c.msg.length})`);
}
console.log("All SMS templates are within 160 characters.");
