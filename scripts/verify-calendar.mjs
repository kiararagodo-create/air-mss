// Verification harness for the reporting calendar logic.
// Run with: node --experimental-strip-types verify-calendar.mts
// (or transpile-free: this file is plain JS with JSDoc types)

const REPORT_OFFSET_MIN = 480; // UTC+8, Philippines has no DST

function parseDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function manilaDayString(instant) {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Date(d.getTime() + REPORT_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}
function manilaMonthStart(i = new Date()) {
  return `${manilaDayString(i).slice(0, 7)}-01`;
}
function addDays(day, n) {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(monthStart, n) {
  const d = parseDay(monthStart);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(d);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
  lastDay.setUTCDate(0);
  d.setUTCDate(Math.min(day, lastDay.getUTCDate()));
  return d.toISOString().slice(0, 10);
}
function daysInMonth(monthStart) {
  const d = parseDay(monthStart);
  const end = new Date(d);
  end.setUTCMonth(end.getUTCMonth() 	+ 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.getUTCDate();
}
function monthGrid(monthStart) {
  const first = parseDay(monthStart);
  const leading = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - leading);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const day = d.toISOString().slice(0, 10);
    return { day, outside: !day.startsWith(monthStart.slice(0, 7)) };
  });
}

// ---- Manila day-start instant, matching the SQL manila_day_start() ----------
function manilaDayStartIso(day) {
  return new Date(parseDay(day).getTime() - REPORT_OFFSET_MIN * 60_000).toISOString();
}
function manilaDayEndIso(day) {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + 1);
  return new Date(d.getTime() - REPORT_OFFSET_MIN * 60_000).toISOString();
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); }
}

console.log("\n== Manila day boundaries (UTC+8, no DST) ==");
// 2026-08-01 00:00 Manila == 2026-07-31 16:00 UTC
check("Aug 1 Manila start", manilaDayStartIso("2026-08-01"), "2026-07-31T16:00:00.000Z");
check("Aug 2 Manila start", manilaDayStartIso("2026-08-02"), "2026-08-01T16:00:00.000Z");
check("Aug 1 Manila end (exclusive)", manilaDayEndIso("2026-08-01"), "2026-08-01T16:00:00.000Z");
// Round-trip: converting the start instant back gives the same calendar day
check("round-trip Aug 1", manilaDayString(manilaDayStartIso("2026-08-01")), "2026-08-01");
check("round-trip Aug 31", manilaDayString(manilaDayStartIso("2026-08-31")), "2026-08-31");

console.log("\n== Month boundaries ==");
check("daysInMonth Feb 2028 (leap)", daysInMonth("2028-02-01"), 29);
check("daysInMonth Feb 2027", daysInMonth("2027-02-01"), 28);
check("daysInMonth Feb 2026", daysInMonth("2026-02-01"), 28);
check("daysInMonth Jan 2026", daysInMonth("2026-01-01"), 31);
check("daysInMonth Apr 2026", daysInMonth("2026-04-01"), 30);
check("daysInMonth Dec 2026", daysInMonth("2026-12-01"), 31);

console.log("\n== Month rollover across a year boundary ==");
check("Dec 2026 + 1mo", addMonths("2026-12-01", 1), "2027-01-01");
check("Jan 2027 - 1mo", addMonths("2027-01-01", -1), "2026-12-01");
check("Jan 2026 - 1mo", addMonths("2026-01-01", -1), "2025-12-01");

console.log("\n== Add-month clamping ==");
check("Jan 31 + 1mo clamps", addMonths("2026-01-31", 1), "2026-02-28");
check("Jan 31 2028 + 1mo clamps to 29", addMonths("2028-01-31", 1), "2028-02-29");
check("Mar 31 - 1mo clamps", addMonths("2026-03-31", -1), "2026-02-28");

console.log("\n== Calendar grid: Monday-start, 42 cells, correct padding ==");
const g = monthGrid("2026-08-01");
// 2026-08-01 is a Saturday. Monday-start week => 5 leading cells.
check("Aug 2026 leading pad", g.findIndex((c) => !c.outside), 5);
check("Aug 2026 grid length", g.length, 42);
check("Aug 2026 first cell", g[0].day, "2026-07-27");
check("Aug 2026 last cell", g[41].day, "2026-09-06");
check("Aug 2026 inside count", g.filter((c) => !c.outside).length, 31);
check("every grid cell starts on Monday", new Date(g[0].day + "T00:00:00Z").getUTCDay(), 1);

console.log("\n== Retention rule: every reading at least one full calendar month old ==");
// The SQL guard deletes month M when today_manila >= (M + 2 months), because
// the youngest reading in M falls on M's last day at 23:59:59 Manila.
// Deleting M on the 1st of M+1 would leave that reading only hours old.
function canDelete(monthStart, todayManilaDay) {
  return todayManilaDay >= addMonths(monthStart, 2);
}
check("cannot delete Jul 2026 on Aug 1", canDelete("2026-07-01", "2026-08-01"), false);
check("cannot delete Jul 2026 on Aug 31", canDelete("2026-07-01", "2026-08-31"), false);
check("CAN delete Jul 2026 on Sep 1", canDelete("2026-07-01", "2026-09-01"), true);
check("cannot delete Jan 2026 on Feb 1", canDelete("2026-01-01", "2026-02-01"), false);
check("cannot delete Jan 2026 on Feb 28", canDelete("2026-01-01", "2026-02-28"), false);
check("CAN delete Jan 2026 on Mar 1", canDelete("2026-01-01", "2026-03-01"), true);
check("cannot delete Dec 2025 on Jan 1", canDelete("2025-12-01", "2026-01-01"), false);
check("CAN delete Dec 2025 on Feb 1", canDelete("2025-12-01", "2026-02-01"), true);

// The SQL guard deletes month M when today_manila >= (M + 2 months). Model that
// exactly, then assert the property it is meant to guarantee: the youngest
// reading in the month (M's last day at 23:59:59 Manila) is always at least a
// full calendar month old at the moment deletion becomes possible.
function youngestReadingHeld(monthStart, todayManilaDay) {
  return !canDelete(monthStart, todayManilaDay);
}
function monthEndOf(monthStart) { return addDays(addMonths(monthStart, 1), -1); }

check("Jul 31 reading no longer held on Sep 1", youngestReadingHeld("2026-07-01", "2026-09-01"), false);
check("Jan 31 reading still held on Feb 28", youngestReadingHeld("2026-01-01", "2026-02-28"), true);
check("Dec 31 reading still held on Jan 31", youngestReadingHeld("2025-12-01", "2026-01-31"), true);
check("Dec 31 reading released on Feb 1", youngestReadingHeld("2025-12-01", "2026-02-01"), false);

// The guarantee: at the earliest deletion date for month M, the last day of M
// is already more than one calendar month in the past.
let guaranteeOk = true;
for (let y = 2025; y <= 2027; y++) {
  for (let m = 1; m <= 12; m++) {
    const ms = `${y}-${String(m).padStart(2, "0")}-01`;
    const eligible = addMonths(ms, 2);          // earliest deletion date
    const youngest = `${monthEndOf(ms)}T23:59:59`;
    // Calendar-month distance from the reading to the deletion date.
    const daysBetween = Math.round(
      (parseDay(eligible) - parseDay(youngest.slice(0, 10))) / 86_400_000
    );
    if (daysBetween < 28) guaranteeOk = false;
  }
}
check("for every month, last-day reading is >=28 days old at deletion", guaranteeOk, true);

// At any instant the database holds the current partial month plus the
// complete previous one: between one and two months of raw readings.
const d = "2026-09-01";
check("on Sep 1 2026, Aug 2026 still retained",
  !canDelete("2026-08-01", d), true);
check("on Sep 1 2026, Jul 2026 eligible",
  canDelete("2026-07-01", d), true);

console.log("\n== Month end = last calendar day, and half-open window ==");
function monthEnd(monthStart) {
  return addDays(addMonths(monthStart, 1), -1);
}
check("Jul 2026 end", monthEnd("2026-07-01"), "2026-07-31");
check("Feb 2028 end (leap)", monthEnd("2028-02-01"), "2028-02-29");
check("Dec 2026 end", monthEnd("2026-12-01"), "2026-12-31");
// Half-open [start, end) must cover exactly the month
check("window start", manilaDayStartIso("2026-07-01"), "2026-06-30T16:00:00.000Z");
check("window end", manilaDayStartIso("2026-08-01"), "2026-07-31T16:00:00.000Z");
// The instant just before window end is still in July
check("last instant of Jul is in Jul",
  manilaDayString(new Date(new Date(manilaDayStartIso("2026-08-01")).getTime() - 1)), "2026-07-31");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);