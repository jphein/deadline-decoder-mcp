// Ported unchanged from Deadline Decoder (tests/dates.test.mjs); only the import paths differ.
import test from "node:test";
import assert from "node:assert/strict";
import { d, iso, addCourtDays, addDaysRolling, isFederalWorkday, caCourtHolidays, findDates } from "../src/rules/dates.js";
import { RULES, detect } from "../src/rules/rules.js";
const rule = id => RULES.find(r => r.id === id);

test("CA 2026 court holidays match courts.ca.gov exactly", () => {
  const got = [...caCourtHolidays(2026).keys()].sort();
  assert.deepEqual(got, ["2026-01-01","2026-01-19","2026-02-12","2026-02-16","2026-03-31","2026-05-25","2026-06-19",
    "2026-07-03","2026-09-07","2026-09-25","2026-11-11","2026-11-26","2026-11-27","2026-12-25"]);
});
test("3-day notice served Monday expires Thursday", () => {
  assert.equal(iso(addCourtDays(d("2026-10-05"), 3).date), "2026-10-08");
});
test("3-day notice served Friday skips the weekend", () => {
  assert.equal(iso(addCourtDays(d("2026-10-09"), 3).date), "2026-10-14");
});
test("3-day notice over Thanksgiving skips Thu+Fri+weekend", () => {
  // served Wed 11/25: 11/26 Thanksgiving, 11/27 day after, 28-29 weekend -> Mon 30, Tue 1, Wed 2
  assert.equal(iso(addCourtDays(d("2026-11-25"), 3).date), "2026-12-02");
});
test("Unlawful detainer: 10 court days", () => {
  // served Thu 2026-10-01 -> court days Oct 2,5,6,7,8,9,12,13,14,15 -> Oct 15 (Columbus Day is not a CA court holiday)
  assert.equal(iso(addCourtDays(d("2026-10-01"), 10).date), "2026-10-15");
});
test("SSA reconsideration dated 2026-09-13 -> hearing request due Tue 2026-11-17", () => {
  assert.equal(iso(rule("ssa-recon").compute(d("2026-09-13")).deadline), "2026-11-17");
});
test("SSA deadline landing on a weekend rolls to Monday", () => {
  // received 2026-08-27 + 60 = 2026-10-26 (Mon) — pick a case that lands on Saturday:
  // notice 2026-08-24 -> received 08-29 -> +60 = 10-28? compute generically
  const r = addDaysRolling(d("2026-10-10"), 0, isFederalWorkday);   // Sat 10-10
  assert.equal(iso(r.date), "2026-10-13");                           // Sun, then Mon 10-12 Columbus Day -> Tue
});
test("Medi-Cal/CalFresh: 90 calendar days", () => {
  assert.equal(iso(rule("ca-noa").compute(d("2026-09-01")).deadline), "2026-11-30");
});
test("finds dates in pasted text", () => {
  const f = findDates("Date: September 13, 2026. Call us by 10/2/2026.");
  assert.deepEqual(f.map(x => x.iso), ["2026-09-13", "2026-10-02"]);
});
test("detects letter types", () => {
  assert.equal(detect("NOTICE OF RECONSIDERATION ... Social Security ... you may request a hearing before an administrative law judge")?.id, "ssa-recon");
  assert.equal(detect("THREE-DAY NOTICE TO PAY RENT OR QUIT. You are hereby notified")?.id, "ca-3day");
  assert.equal(detect("SUMMONS (CITACION JUDICIAL) UNLAWFUL DETAINER—EVICTION")?.id, "ca-ud");
  assert.equal(detect("NOTICE OF ACTION: Your CalFresh benefits will stop")?.id, "ca-noa");
});
