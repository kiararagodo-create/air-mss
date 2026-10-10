// Parses every migration with the real PostgreSQL grammar (libpg-query), so a
// syntax error in the reporting SQL is caught before it is pushed to a project.
// Run: node scripts/verify-sql.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "libpg-query";

const dir = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

let failed = 0;
let statements = 0;

for (const f of files) {
  const sql = readFileSync(join(dir, f), "utf8");
  try {
    const result = await pg.parse(sql);
    statements += result.stmts.length;
    const flag = result.stmts.length > 0 ? "ok " : "EMPTY";
    console.log(`  ${flag}  ${f}  (${result.stmts.length} statements)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${f}`);
    console.log(`       ${e.message}`);
    if (e.cursorPosition != null) {
      const pos = Number(e.cursorPosition);
      const ctx = sql.slice(Math.max(0, pos - 160), pos + 160);
      console.log(`       near: ...${ctx.replace(/\n/g, "\n            ")}...`);
    }
  }
}

console.log(`\n${files.length} files, ${statements} statements, ${failed} failed to parse`);
process.exit(failed ? 1 : 0);