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
  assert.equal(UNKNOWN_LETTER, "I couldn't tell which kind of letter that is. Is it about Social Security, your rent or your home, a court case or jury duty, a parking ticket, unemployment benefits, taxes or the IRS, or Medi-Cal, CalFresh or CalWORKs?");
  assert.equal(detectLetter("I got a letter and I'm scared", "2026-10-01").speech, UNKNOWN_LETTER);
});

// ---- traffic: parking tickets (Vehicle Code § 40215) ----------------------------------------------------------
test("parking: 21 calendar days from the ticket, 14 from a late notice, 21 from a review result; never rolled", () => {
  assert.equal(due("ca-parking-ticket", "2026-10-01"), "2026-10-22");
  assert.equal(due("ca-parking-ticket", "2026-10-10"), "2026-10-31");      // a Saturday, left as it is: early is safe
  assert.equal(due("ca-parking-delinquent", "2026-10-01"), "2026-10-15");
  assert.equal(due("ca-parking-delinquent", "2026-11-14"), "2026-11-28");  // a Saturday, left as it is
  assert.equal(due("ca-parking-review", "2026-10-01"), "2026-10-22");
});

test("parking: the answer says how it counted, cites 40215, and offers the payment plan", () => {
  const r = computeDeadline("ca-parking-ticket", "2026-10-01", "2026-10-02");
  assert.match(r.speech, /^Your deadline is Thursday, October 22, 2026, 20 days from today\. Ask the agency for a free review, or pay\. Here's how I counted\. Issued Thursday, October 1, 2026\. 21 days from that date: Thursday, October 22, 2026\. First step:/);
  assert.ok(r.sources.some(s => s.includes("40215(a)")) && r.next_steps.some(s => /payment plan\. People who qualify must be offered one/.test(s)));
  assert.ok(computeDeadline("ca-parking-review", "2026-10-01", "2026-10-02").sources.some(s => s.includes("40215(b)")));
});

test("parking: a ticket, a late notice and a review result are told apart", () => {
  const t = "2026-10-02";
  assert.equal(detectLetter("I got a parking ticket on September 28th", t).letter_type, "ca-parking-ticket");
  assert.equal(detectLetter("I got a late notice for a parking ticket, it's overdue", t).letter_type, "ca-parking-delinquent");
  assert.equal(detectLetter("they denied my review of the parking ticket", t).letter_type, "ca-parking-review");
  assert.equal(detectLetter("NOTICE OF PARKING VIOLATION. Citation No. 12345. Penalty due by 10/22/2026. To contest, request an initial review.", t).letter_type, "ca-parking-ticket");
  assert.equal(detectLetter("NOTICE OF DELINQUENT PARKING VIOLATION. Parking citation unpaid; late penalties added.", t).letter_type, "ca-parking-delinquent");
  assert.equal(detectLetter("Results of your initial review: the parking citation stands. You may request an administrative hearing within 21 days.", t).letter_type, "ca-parking-review");
});

// ---- benefits ----------------------------------------------------------------------------------------------------
test("SSA overpayment: 60 days after the presumed receipt, rolled like the other SSA rules, plus the 30-day date", () => {
  assert.equal(due("ssa-overpayment", "2026-09-13"), "2026-11-17");
  assert.equal(due("ssa-overpayment", "2026-11-14"), "2027-01-19");       // day 60 is Martin Luther King Jr. Day, 2027
  const r = computeDeadline("ssa-overpayment", "2026-09-13", "2026-09-20");
  assert.deepEqual(r.also.map(a => [a.date, a.passed]), [["2026-10-13", false]]);
  assert.match(r.speech, /For Social Security benefits \(not SSI\), ask by Tuesday, October 13, 2026, 30 days after the date on the notice, and they won't start taking money back while they decide\. Here's how I counted\. Notice dated Sunday, September 13, 2026\. Social Security assumes you got it 5 days later: Friday, September 18, 2026\./);
  assert.ok(r.next_steps.some(s => /SSI .* within 10 days/.test(s)) && r.sources.some(s => s.includes("416.1336(b)")));
});

test("EDD: 30 calendar days from the mailing date, never rolled", () => {
  assert.equal(due("ca-edd-determination", "2026-09-15"), "2026-10-15");
  assert.equal(due("ca-edd-determination", "2026-10-01"), "2026-10-31");  // a Saturday, left as it is
  assert.match(computeDeadline("ca-edd-determination", "2026-09-15", "2026-09-20").speech, /Mailed Tuesday, September 15, 2026\. 30 days from that date: Thursday, October 15, 2026\. EDD counts the 30 days from the mailing date on the notice\. First step/);
  // a day that doesn't roll says so, instead of passing itself off as final
  assert.match(computeDeadline("ca-edd-determination", "2026-10-01", "2026-10-02").speech, /Saturday, October 31, 2026\. That's a Saturday\. Don't count on extra time: act before then\./);
  assert.match(computeDeadline("ca-edd-determination", "2026-10-02", "2026-10-03").speech, /Sunday, November 1, 2026\. That's a Sunday\. Don't count on extra time/);
  assert.match(computeDeadline("ca-edd-determination", "2026-10-12", "2026-10-13").speech, /Wednesday, November 11, 2026\. That's Veterans Day\. Don't count on extra time/);
  assert.doesNotMatch(computeDeadline("ca-edd-determination", "2026-09-15", "2026-09-16").speech, /extra time/);   // a Thursday says nothing
  const src = computeDeadline("ca-edd-determination", "2026-09-15", "2026-09-20").sources;
  assert.ok(src.some(s => s.includes("§ 1328")) && src.some(s => s.includes("§ 1377")));   // determinations, and overpayments
});

test("Medi-Cal health plan: 60 days to appeal a denial to the plan, then 120 days after its appeal decision", () => {
  assert.equal(due("ca-medi-cal-plan", "2026-09-01"), "2026-12-30");
  assert.ok(computeDeadline("ca-medi-cal-plan", "2026-09-01", "2026-09-02").sources.some(s => s.includes("438.408(f)(2)")));
  assert.equal(due("ca-medi-cal-plan-denial", "2026-09-01"), "2026-10-31");  // a Saturday, left as it is
  const t = "2026-10-01";
  assert.equal(detectLetter("my Medi-Cal health plan denied my surgery", t).letter_type, "ca-medi-cal-plan-denial");
  assert.equal(detectLetter("my Medi-Cal plan won't cover my medicine", t).letter_type, "ca-medi-cal-plan-denial");
  assert.equal(detectLetter("Your Medi-Cal managed care health plan: NOTICE OF ADVERSE BENEFIT DETERMINATION. You may appeal within 60 days.", t).letter_type, "ca-medi-cal-plan-denial");
  assert.ok(computeDeadline("ca-noa", "2026-09-01", "2026-09-02").next_steps.some(s => /health plan rather than the county, you usually appeal to the plan first, within 60 days/.test(s)));
});

test("Notice of Action: the hearing date, and how to keep benefits the same while you wait (no date promised)", () => {
  const r = computeDeadline("ca-noa", "2026-09-01", "2026-09-02");
  assert.equal(r.deadline, "2026-11-30");
  // the cutoff is the effective date on the notice, which can come sooner than 10 days, so no computed day is offered
  assert.deepEqual(r.also.map(a => [a.date, a.confidence]), [[null, "HEDGE"]]);
  assert.match(r.speech, /Ask for a state hearing\. You may be able to keep your benefits while you wait for the hearing, if you ask before the change takes effect\. That date is printed on the notice, usually at least 10 days after it, so ask right away\. Here's how I counted/);
  assert.doesNotMatch(r.speech, /is safe/);
  assert.equal(r.letter_title, "Medi-Cal, CalFresh or CalWORKs: a Notice of Action");
});

test("benefits: an SSA overpayment, an EDD notice and a Medi-Cal plan decision are recognized", () => {
  const t = "2026-10-01";
  assert.equal(detectLetter("Social Security says they overpaid me and I have to pay it back", t).letter_type, "ssa-overpayment");
  assert.equal(detectLetter("I got a letter from EDD saying I'm not eligible for unemployment", t).letter_type, "ca-edd-determination");
  assert.equal(detectLetter("EDD says I was overpaid on unemployment", t).letter_type, "ca-edd-determination");
  assert.equal(detectLetter("my Medi-Cal health plan denied my appeal", t).letter_type, "ca-medi-cal-plan");
  assert.equal(detectLetter("the county says my Medi-Cal is ending", t).letter_type, "ca-noa");
  assert.equal(detectLetter("SOCIAL SECURITY ADMINISTRATION. Notice of Overpayment. We paid you $1,200 too much. You may ask for reconsideration or a waiver.", t).letter_type, "ssa-overpayment");
  assert.equal(detectLetter("Employment Development Department. Notice of Determination. You are disqualified. To appeal, use form DE 1000M.", t).letter_type, "ca-edd-determination");
  assert.equal(detectLetter("NOTICE OF APPEAL RESOLUTION. Your Medi-Cal managed care health plan upheld its decision. You may ask for a State Hearing.", t).letter_type, "ca-medi-cal-plan");
  assert.equal(detectLetter("I got a letter from Social Security dated September 13th, they denied my disability again", t).letter_type, "ssa-recon");
});

// ---- taxes: the IRS ------------------------------------------------------------------------------------------------
test("IRS Notice of Deficiency: 90 days after mailing, past a weekend or D.C. holiday (26 U.S.C. § 6213(a))", () => {
  assert.equal(due("irs-deficiency", "2026-09-15"), "2026-12-14");
  assert.equal(due("irs-deficiency", "2026-08-13"), "2026-11-12");         // day 90 is Veterans Day
  assert.equal(due("irs-deficiency", "2027-01-16"), "2027-04-19");         // day 90 is D.C. Emancipation Day, then the weekend
  const r = computeDeadline("irs-deficiency", "2026-08-13", "2026-08-20");
  assert.match(r.speech, /90 days from that date: Wednesday, November 11, 2026\. That's Veterans Day, so the deadline moves to the next business day: Thursday, November 12, 2026\./);
  assert.ok(r.next_steps.some(s => /150 days/.test(s)) && r.sources.some(s => s.includes("6213(a)")));
});

test("IRS final notice of intent to levy: 30 days from the day after the notice date, rolled (§§ 6330, 7503)", () => {
  assert.equal(due("irs-levy", "2026-09-15"), "2026-10-15");
  assert.equal(due("irs-levy", "2026-10-12"), "2026-11-12");               // day 30 is Veterans Day
  const r = computeDeadline("irs-levy", "2026-09-15", "2026-09-16");
  assert.ok(r.next_steps.some(s => /equivalent hearing within a year/.test(s)));
  assert.ok(r.sources.some(s => s.includes("301.6330-1(c)(2)")));
  assert.match(r.speech, /Every day counts, but a last day on a weekend or a D\.C\. holiday moves to the next business day\. A state holiday where the IRS office is could add a day more, so this date is the safe side\./);
});

test("IRS CP2000: HEDGE, usually 30 days from the notice date, and the answer points to the response date", () => {
  const r = computeDeadline("irs-cp2000", "2026-09-15", "2026-09-16");
  assert.equal(r.confidence, "HEDGE");
  assert.equal(r.deadline, "2026-10-15");
  assert.match(r.speech, /^For this kind of notice the deadline is usually Thursday, October 15, 2026, 29 days from today\. Check the notice itself: if it gives a different date, go by the notice\. Reply to the IRS by the response date on the notice\./);
  assert.match(r.speech, /Usually the deadline is 30 days from that date/);
});

test("IRS: the three letters are recognized, and a bare 'IRS letter' asks which", () => {
  const t = "2026-10-01";
  assert.equal(detectLetter("the IRS sent me a notice of deficiency", t).letter_type, "irs-deficiency");
  assert.equal(detectLetter("I got an IRS 90-day letter", t).letter_type, "irs-deficiency");
  assert.equal(detectLetter("the IRS says they're going to levy my bank account", t).letter_type, "irs-levy");
  assert.equal(detectLetter("I got a CP2000 from the IRS", t).letter_type, "irs-cp2000");
  assert.equal(detectLetter("the IRS says I didn't report some income", t).letter_type, "irs-cp2000");
  assert.equal(detectLetter("FINAL NOTICE. Notice of Intent to Levy and Notice of Your Right to a Hearing. Internal Revenue Service. Use Form 12153.", t).letter_type, "irs-levy");
  const q = detectLetter("I got a letter from the IRS", t);
  assert.deepEqual(q.candidates, ["irs-cp2000", "irs-deficiency", "irs-levy"]);
  assert.equal(detectLetter("it says final notice before a levy", t, q.candidates).letter_type, "irs-levy");
  assert.equal(detectLetter("proposed changes to my return", t, q.candidates).letter_type, "irs-cp2000");
});

// ---- housing: notices that end a tenancy or raise the rent --------------------------------------------------------
test("30- and 60-day notices: the earliest the tenancy can end, said as that (Civil Code § 1946.1)", () => {
  assert.equal(due("ca-60day-notice", "2026-09-01"), "2026-10-31");
  assert.equal(due("ca-30day-notice", "2026-09-15"), "2026-10-15");
  const r = computeDeadline("ca-60day-notice", "2026-09-01", "2026-09-02");
  assert.equal(r.confidence, "HEDGE");
  assert.match(r.speech, /^A 60-day notice can't end your tenancy before Saturday, October 31, 2026, 59 days from today\. Get free legal help/);
  assert.match(r.speech, /If it came by mail, the earliest end date may be later\./);
  assert.doesNotMatch(r.speech, /act before then/);                          // an end date isn't a day to act by
  assert.ok(r.next_steps.some(s => /isn't an eviction order/.test(s)));
  assert.ok(computeDeadline("ca-30day-notice", "2026-09-15", "2026-09-16").next_steps.some(s => /60 days' notice, not 30/.test(s)));
});

test("rent increase: 30 days for 10 percent or less, 90 for more, and 5 more if mailed (Civil Code § 827)", () => {
  assert.equal(due("ca-rent-increase", "2026-09-15"), "2026-10-15");
  const r = computeDeadline("ca-rent-increase", "2026-09-15", "2026-09-16");
  assert.match(r.speech, /^If the increase is 10 percent or less, the new rent can't start before Thursday, October 15, 2026, 29 days from today\. Keep paying your current rent until the new rent can start\. If it's more than 10 percent, it can't start before Monday, December 14, 2026, 90 days after you got the notice\./);
  assert.match(r.speech, /If the notice came by mail, add 5 days to each date\./);
  assert.ok(r.sources.some(s => s.includes("827(b)")) && r.sources.some(s => s.includes("1947.12")));
});

test("housing notices are recognized, and a notice to vacate asks 30 or 60", () => {
  const t = "2026-10-01";
  assert.equal(detectLetter("my landlord gave me a 60-day notice", t).letter_type, "ca-60day-notice");
  assert.equal(detectLetter("I got a thirty day notice from my landlord", t).letter_type, "ca-30day-notice");
  assert.equal(detectLetter("my landlord says my rent is going up", t).letter_type, "ca-rent-increase");
  assert.equal(detectLetter("my landlord taped a three day notice on my door yesterday", t).letter_type, "ca-3day");   // still the 3-day notice
  assert.equal(detectLetter("60-DAY NOTICE OF TERMINATION OF TENANCY. To the tenant: the landlord terminates your tenancy of the premises.", t).letter_type, "ca-60day-notice");
  assert.equal(detectLetter("NOTICE OF CHANGE OF TERMS OF TENANCY: your rent will increase to $1,850, effective December 1.", t).letter_type, "ca-rent-increase");
  const q = detectLetter("I got a notice to vacate", t);
  assert.deepEqual(q.candidates, ["ca-30day-notice", "ca-60day-notice"]);
  assert.equal(detectLetter("sixty", t, q.candidates).letter_type, "ca-60day-notice");
});

// ---- housing: a housing authority ending a voucher or a public housing lease --------------------------------------
test("voucher termination: HEDGE with nothing to count; the notice prints the deadline to ask for a hearing (24 CFR 982.555)", () => {
  const r = computeDeadline("hud-voucher-termination", undefined, "2026-09-16");
  assert.equal(r.deadline, null);
  assert.match(r.speech, /^When a housing authority ends your voucher because of something your family did or didn't do, or because you were away too long, the notice has to say why and give the deadline to ask for an informal hearing\. Ask the housing authority for an informal hearing by the date on the notice\./);
  const t = "2026-09-16";
  assert.equal(detectLetter("the housing authority is terminating my Section 8 voucher", t).letter_type, "hud-voucher-termination");
  assert.equal(detectLetter("I'm losing my voucher", t).letter_type, "hud-voucher-termination");
  assert.equal(detectLetter("HOUSING AUTHORITY. Notice of termination of assistance. Housing Choice Voucher program. You may request an informal hearing by October 1, 2026.", t).letter_type, "hud-voucher-termination");
  assert.notEqual(detectLetter("my landlord is leaving Section 8", t).letter_type, "hud-voucher-termination");
});

test("public housing lease termination: at least 30 days for unpaid rent (24 CFR 966.4(l)(3)), HEDGE", () => {
  assert.equal(due("hud-public-housing", "2026-09-15"), "2026-10-15");
  const r = computeDeadline("hud-public-housing", "2026-09-15", "2026-09-16");
  assert.match(r.speech, /^For unpaid rent, your public housing lease can't end before Thursday, October 15, 2026, 29 days from today\. Ask about a grievance hearing/);
  assert.ok(r.next_steps.some(s => /isn't an eviction order/.test(s)));
  const t = "2026-09-16";
  assert.equal(detectLetter("public housing gave me a notice to end my lease", t).letter_type, "hud-public-housing");
  assert.equal(detectLetter("HOUSING AUTHORITY. Public housing lease termination notice. Failure to pay rent. You may request a grievance hearing.", t).letter_type, "hud-public-housing");
});
