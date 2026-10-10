// Verifies src/lib/zip.ts produces archives that Windows can actually extract.
// Run: node --experimental-strip-types scripts/verify-zip.ts
import { ZipBuilder, crc32, formatBytes } from "../src/lib/zip.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

console.log("\n== CRC32 against known vectors ==");
// Standard CRC-32 (IEEE 802.3) check values.
assert('crc32("") === 0', crc32(new TextEncoder().encode("")) === 0,
  `got ${crc32(new TextEncoder().encode(""))}`);
assert('crc32("123456789") === 0xCBF43926',
  crc32(new TextEncoder().encode("123456789")) === 0xcbf43926,
  `got 0x${crc32(new TextEncoder().encode("123456789")).toString(16)}`);
assert('crc32("The quick brown fox jumps over the lazy dog") === 0x414FA339',
  crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")) === 0x414fa339,
  `got 0x${crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")).toString(16)}`);

console.log("\n== Archive structure ==");
const z = new ZipBuilder();
const enc = new TextEncoder();

// Mimic a real year's worth: several months, multiple PDF parts each.
const files: { name: string; body: Uint8Array }[] = [];
for (const month of ["01", "02", "03", "04", "05", "06"]) {
  for (let part = 1; part <= 4; part++) {
    const body = enc.encode(`%PDF-1.7\nmonth ${month} part ${part}\n` + "x".repeat(5000 * part));
    const name = `${month}/${month}-part-${part}.pdf`;
    files.push({ name, body });
    z.add(name, body, new Date(2026, 7, 1, 12, 0, 0));
  }
}
assert("count is tracked", z.count === files.length);
assert("size is tracked", z.size === files.reduce((s, f) => s + f.body.length, 0));

const bytes = z.finish();
assert("starts with local file header PK\\x03\\x04",
  bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04);
assert("ends with EOCD PK\\x05\\x06",
  bytes[bytes.length - 22] === 0x50 && bytes[bytes.length - 21] === 0x4b &&
  bytes[bytes.length - 20] === 0x05 && bytes[bytes.length - 19] === 0x06);

// EOCD total-entry count must equal what we added.
const eocdEntries = bytes[bytes.length - 22 + 10] | (bytes[bytes.length - 22 + 11] << 8);
assert("EOCD entry count matches", eocdEntries === files.length, `got ${eocdEntries}`);

console.log("\n== Write out for an independent extractor to verify ==");
const outDir = join(process.cwd(), "tmp-zip-verify");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "reports-2026.zip"), bytes);
console.log(`  wrote tmp-zip-verify/reports-2026.zip (${formatBytes(bytes.length)})`);

console.log("\n== formatBytes ==");
assert("bytes", formatBytes(512) === "512 B");
assert("KB", formatBytes(2048) === "2.0 KB");
assert("MB", formatBytes(5 * 1024 * 1024) === "5.0 MB");
assert("GB", formatBytes(3 * 1024 * 1024 * 1024) === "3.00 GB");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) Deno.exit(1);