// SPDX-License-Identifier: AGPL-3.0-or-later
// The rule table as a whole, the counting engine for rules written as data, and each newer rule's arithmetic.
// Expected dates were worked out independently (a calendar, not this code).
import test from "node:test";
import assert from "node:assert/strict";
import { d, iso, dcHolidays, isDcBusinessDay } from "../src/rules/dates.js";
import { RULES, SPOKEN_ORDER, AMBIGUOUS, KEYTERMS, ANCHORS, ROLL, count } from "../src/rules/rules.js";
import { computeDeadline, detectLetter, makeReminder, listLetterTypes, UNKNOWN_LETTER, DecoderError } from "../src/decoder.js";

const rule = (id) => RULES.find(r => r.id === id);
const due = (id, date) => iso(rule(id).compute(d(date)).deadline);

// ---- the table ----------------------------------------------------------------------------------------------
test("every rule carries the whole schema", () => {
  const ids = RULES.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const r of RULES) {
    const where = `rule ${r.id}`;
    for (const k of ["id", "family", "title", "plain"]) assert.equal(typeof r[k], "string", `${where}: ${k}`);
    assert.ok(["SOLID", "HEDGE"].includes(r.confidence), `${where}: confidence`);
    assert.ok(r.anchor === null || Object.hasOwn(ANCHORS, r.anchor), `${where}: anchor`);
    assert.ok(r.anchor === null || typeof r.dateLabel === "string", `${where}: a dated rule says which date to ask for`);
    assert.ok(r.spoken instanceof RegExp && r.answers instanceof RegExp, `${where}: spoken and answers patterns`);
    assert.ok(Array.isArray(r.detect) && r.detect.length >= 2, `${where}: printed cues`);
    assert.ok(r.keyterms?.length > 0, `${where}: key terms`);
    assert.ok(SPOKEN_ORDER.includes(r.id), `${where}: in SPOKEN_ORDER`);
    if (r.confidence === "HEDGE" && r.anchor === null) assert.equal(typeof r.hedge, "string", `${where}: an undated HEDGE rule says what counts`);
    if (r.count) assert.ok(Object.hasOwn(ROLL, r.count.roll ?? "none"), `${where}: roll rule`);
  }
  assert.deepEqual([...SPOKEN_ORDER].sort(), [...ids].sort(), "SPOKEN_ORDER names every rule once");
  for (const g of AMBIGUOUS) for (const c of g.candidates) assert.ok(rule(c), `ambiguous candidate ${c}`);
});

test("key terms: deduplicated, and inside AssemblyAI's limits (100 terms, 50 characters each)", () => {
  assert.equal(new Set(KEYTERMS).size, KEYTERMS.length);
  assert.ok(KEYTERMS.length <= 100, `${KEYTERMS.length} terms`);
  assert.ok(KEYTERMS.every(k => k.length <= 50));
  for (const t of ["Social Security", "summons", "jury summons"]) assert.ok(KEYTERMS.includes(t), t);
});

test("list_letter_types says, for each type, its family, confidence and whether it needs a date", () => {
  const byId = Object.fromEntries(listLetterTypes().map(t => [t.id, t]));
  assert.deepEqual({ ...byId["jury-summons"], title: undefined, description: undefined },
    { id: "jury-summons", title: undefined, description: undefined, date_to_ask_for: null, family: "court", confidence: "HEDGE", needs_date: false });
  assert.equal(byId["ca-civil-summons"].needs_date, true);
});

// ---- the counting engine ------------------------------------------------------------------------------------
test("count: calendar days, no roll, even onto a Saturday", () => {
  assert.equal(iso(count(d("2026-10-01"), { days: 30 }).date), "2026-10-31");
});

test("count: a court roll moves a Saturday to Monday, and a court holiday to the next court day", () => {
  assert.equal(iso(count(d("2026-10-01"), { days: 30, roll: "court" }).date), "2026-11-02");
  const vets = count(d("2026-10-12"), { days: 30, roll: "court" });       // day 30 is Veterans Day, a Wednesday
  assert.equal(iso(vets.date), "2026-11-12");
  assert.deepEqual(vets.rolled.map(r => r.why), ["Veterans Day"]);
});

test("count: a mailing presumption shifts the start", () => {
  const c = count(d("2026-09-13"), { days: 60, mail: 5, roll: "federal" });
  assert.equal(iso(c.start), "2026-09-18");
  assert.equal(iso(c.date), "2026-11-17");                                // the SSA rule's own answer
});

test("count: a D.C. roll skips D.C. Emancipation Day (and its observed Monday)", () => {
  assert.equal(iso(count(d("2027-01-16"), { days: 90, roll: "dc" }).date), "2027-04-19");   // Fri Apr 16, 2027, then the weekend
  assert.equal(iso(count(d("2028-01-18"), { days: 90, roll: "dc" }).date), "2028-04-18");   // observed Mon Apr 17, 2028
  assert.equal(iso(count(d("2027-01-16"), { days: 90, roll: "federal" }).date), "2027-04-16");   // not a federal holiday
});

test("D.C. holidays: Emancipation Day observed on the nearest weekday, Inauguration Day every fourth year", () => {
  assert.equal(dcHolidays(2027).get("2027-04-16"), "D.C. Emancipation Day");
  assert.equal(dcHolidays(2028).get("2028-04-17"), "D.C. Emancipation Day");
  assert.equal(dcHolidays(2033).get("2033-01-20"), "Inauguration Day");
  assert.equal(dcHolidays(2027).get("2027-01-20"), undefined);
  assert.equal(isDcBusinessDay(d("2033-01-20")), false);
  assert.equal(isDcBusinessDay(d("2033-01-21")), true);
});

test("count: court days, and unknown rules are refused", () => {
  assert.equal(iso(count(d("2026-11-25"), { days: 3, unit: "court" }).date), "2026-12-02");   // the 3-day notice over Thanksgiving
  assert.throws(() => count(d("2026-10-01"), { days: 3, roll: "moon" }));
  assert.throws(() => count(d("2026-10-01"), { days: 3, unit: "fortnights" }));
});

// ---- court: a civil summons -------------------------------------------------------------------------------------
test("civil summons: 30 days after service, then the next court day (CCP §§ 412.20, 12, 12a)", () => {
  assert.equal(due("ca-civil-summons", "2026-10-01"), "2026-11-02");      // Sat Oct 31
  assert.equal(due("ca-civil-summons", "2026-10-12"), "2026-11-12");      // Veterans Day
  assert.equal(due("ca-civil-summons", "2026-11-25"), "2026-12-28");      // Christmas, then the weekend
  assert.equal(due("ca-civil-summons", "2026-10-02"), "2026-11-02");      // Sun Nov 1
  assert.equal(due("ca-civil-summons", "2026-10-05"), "2026-11-04");      // a plain Wednesday
});

test("civil summons: the answer shows its working, for the ear", () => {
  const r = computeDeadline("ca-civil-summons", "2026-10-12", "2026-10-13");
  assert.equal(r.confidence, "SOLID");
  assert.match(r.speech, /^Your deadline is Thursday, November 12, 2026, 30 days from today\./);
  assert.match(r.speech, /Here's how I counted\. Served Monday, October 12, 2026\. The day you are served does not count\. 30 days from the day you were served: Wednesday, November 11, 2026\. That's Veterans Day, so the deadline moves to the next court day: Thursday, November 12, 2026\. First step:/);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(r.speech));
  assert.ok(r.sources.some(s => s.includes("412.20")));
});

// ---- court: a jury summons (HEDGE, nothing to count) ------------------------------------------------------------
test("jury summons: no date to count, so the answer points to the date on the summons", () => {
  const r = computeDeadline("jury-summons", undefined, "2026-10-01");
  assert.equal(r.confidence, "HEDGE");
  assert.equal(r.deadline, null); assert.equal(r.days_left, null); assert.equal(r.passed, false);
  assert.match(r.speech, /^A jury summons prints its own date to respond or to report, and that's the date that counts\. Respond to the court by the date on the summons\. First step:/);
  assert.doesNotMatch(r.speech, /Here's how I counted/);
  assert.match(r.speech, /not legal advice\.$/);
  assert.ok(r.sources.some(x => x.includes("rule 2.1004")) && r.sources.some(x => x.includes("rule 2.1008")));   // postponement, hardship
  assert.ok(!r.sources.some(x => x.includes("2.1010")));                  // that one is about setting aside sanctions
  assert.throws(() => makeReminder("jury-summons", undefined, "2026-10-01"), DecoderError);
  assert.throws(() => computeDeadline("ca-civil-summons", undefined, "2026-10-01"), DecoderError);   // a dated rule still needs its date
});

// ---- detection -------------------------------------------------------------------------------------------------
test("detect: a jury summons, a civil summons, and eviction papers are told apart", () => {
  const t = "2026-10-01";
  assert.equal(detectLetter("I got a jury summons in the mail", t).letter_type, "jury-summons");
  assert.equal(detectLetter("I got a letter saying I have jury duty", t).needs_date, false);
  assert.equal(detectLetter("a debt collector is suing me, I got court papers yesterday", t).letter_type, "ca-civil-summons");
  assert.equal(detectLetter("I was handed eviction papers on the 22nd of September", t).letter_type, "ca-ud");
  assert.equal(detectLetter("my landlord gave me a summons", t).letter_type, "ca-ud");
  const printed = detectLetter("SUMMONS (CITACION JUDICIAL) NOTICE TO DEFENDANT: You have 30 CALENDAR DAYS after this summons and legal papers are served on you to file a written response. Plaintiff: Midland Funding", t);
  assert.equal(printed.letter_type, "ca-civil-summons");
  assert.equal(detectLetter("SUMMONS (CITACION JUDICIAL) UNLAWFUL DETAINER—EVICTION", t).letter_type, "ca-ud");
});

test("detect: a bare 'summons' is a question, and the answer is matched among the candidates", () => {
  const t = "2026-10-01";
  const q = detectLetter("I got a summons", t);
  assert.equal(q.recognized, false);
  assert.deepEqual(q.candidates, ["ca-ud", "ca-civil-summons", "jury-summons"]);
  assert.equal(q.speech, "Is it about an eviction, a lawsuit about money, or jury duty?");
  assert.deepEqual(detectLetter("I got court papers", t).candidates, q.candidates);
  const among = q.candidates;
  assert.equal(detectLetter("it's about my rent, from my landlord", t, among).letter_type, "ca-ud");
  assert.equal(detectLetter("money, a credit card", t, among).letter_type, "ca-civil-summons");
  assert.equal(detectLetter("jury", t, among).letter_type, "jury-summons");
  assert.equal(detectLetter("I don't know", t, among).recognized, false);
  assert.throws(() => detectLetter("jury", t, ["nope"]), DecoderError);
});

test("detect: the don't-know answer names every family of letters", () => {
  assert.equal(UNKNOWN_LETTER, "I couldn't tell which kind of letter that is. Is it from Social Security, a landlord, a court, or the county about Medi-Cal, CalFresh or CalWORKs?");
  assert.equal(detectLetter("I got a letter and I'm scared", "2026-10-01").speech, UNKNOWN_LETTER);
});
