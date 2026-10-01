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
  assert.equal(UNKNOWN_LETTER, "I couldn't tell which kind of letter that is. Is it about Social Security, your rent or your home, a court case or jury duty, a traffic or parking ticket, or the DMV, a shutoff notice, a debt collector or a repossessed car, unemployment benefits, taxes or the IRS, or Medi-Cal, CalFresh or CalWORKs?");
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
  assert.match(r.speech, /Ask for a state hearing\. You may be able to keep your benefits while you wait for the hearing, if you ask before the change takes effect\. That date is printed on the notice, usually at least 10 days after it, so ask right away\. If you lose, you may have to pay back CalFresh benefits you got while waiting\. Here's how I counted/);
  assert.ok(r.next_steps.some(s => /Medi-Cal renewal decision, you may have 120 days/.test(s)) && r.sources.some(s => s.includes("431.231(a)")));
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

// ---- Social Security: the Appeals Council, and keeping benefits while you appeal ---------------------------------
test("SSA Appeals Council: 60 days after the presumed receipt of the hearing decision (20 CFR 404.968)", () => {
  assert.equal(due("ssa-appeals-council", "2026-09-13"), "2026-11-17");
  const t = "2026-10-01";
  assert.equal(detectLetter("the judge denied my disability at the hearing", t).letter_type, "ssa-appeals-council");
  assert.equal(detectLetter("I want the Appeals Council to look at my Social Security case", t).letter_type, "ssa-appeals-council");
  assert.equal(detectLetter("SOCIAL SECURITY ADMINISTRATION. Notice of Decision - Unfavorable. The administrative law judge found you not disabled. If you disagree, you may ask the Appeals Council to review it.", t).letter_type, "ssa-appeals-council");
  assert.equal(detectLetter("SOCIAL SECURITY ADMINISTRATION Notice of Reconsideration. Date: September 13, 2026. If you disagree, you may request a hearing before an administrative law judge.", t).letter_type, "ssa-recon");
});

test("SSA benefits ending: 10 days after the presumed receipt to keep them coming, and the 60-day appeal date", () => {
  assert.equal(due("ssa-benefits-ending", "2026-09-13"), "2026-09-28");
  const r = computeDeadline("ssa-benefits-ending", "2026-09-13", "2026-09-14");
  assert.match(r.speech, /^Your deadline is Monday, September 28, 2026, 14 days from today\. Appeal, and ask to keep your benefits while you do\. To appeal at all, you have until Tuesday, November 17, 2026, 60 days after you get the notice\. After the earlier date, your payments usually stop while you wait, unless you have a good reason for being late\./);
  assert.ok(r.next_steps.some(s => /appealing in time is usually enough/.test(s)) && r.next_steps.some(s => /the appeal alone isn't enough/.test(s)));
  assert.ok(r.sources.some(s => s.includes("416.996(c)")));
  assert.ok(r.sources.some(s => s.includes("416.1336(b)")) && r.sources.some(s => s.includes("404.1597a(f)(1)")));
  const t = "2026-10-01";
  assert.equal(detectLetter("they're stopping my SSI", t).letter_type, "ssa-benefits-ending");
  assert.equal(detectLetter("Social Security says I'm no longer disabled and my benefits will end", t).letter_type, "ssa-benefits-ending");
  assert.equal(detectLetter("Social Security says they overpaid me and they're cutting my check", t).letter_type, "ssa-overpayment");
});

// ---- EDD disability and Paid Family Leave; the California Franchise Tax Board -------------------------------------
test("EDD SDI/PFL: 30 days from the date on the notice (UIC § 2707.2), and not mistaken for unemployment or SSA", () => {
  assert.equal(due("ca-edd-sdi", "2026-09-15"), "2026-10-15");
  const t = "2026-09-30";
  assert.equal(detectLetter("EDD denied my disability insurance claim", t).letter_type, "ca-edd-sdi");
  assert.equal(detectLetter("my paid family leave was denied", t).letter_type, "ca-edd-sdi");
  assert.equal(detectLetter("EDD said my SDI was denied again", t).letter_type, "ca-edd-sdi");
  assert.equal(detectLetter("EMPLOYMENT DEVELOPMENT DEPARTMENT. Notice of Determination (DE 2517). Disability Insurance. You are not eligible for benefits. You may appeal.", t).letter_type, "ca-edd-sdi");
  assert.equal(detectLetter("EDD denied my unemployment", t).letter_type, "ca-edd-determination");
  assert.equal(detectLetter("Social Security denied my disability again", t).letter_type, "ssa-recon");
  const r = computeDeadline("ca-edd-sdi", "2026-09-15", "2026-09-16");
  assert.ok(r.next_steps.some(s => /voluntary plan\), appeal by sending a letter to your local EDD field office/.test(s)) && r.sources.some(s => s.includes("2707.2")));
  assert.equal(due("ca-edd-sdi", "2026-09-17"), "2026-10-17");   // a Saturday: no roll, early is safe
  assert.equal(detectLetter("my disability claim with EDD was denied", t).letter_type, "ca-edd-sdi");
  assert.equal(detectLetter("EMPLOYMENT DEVELOPMENT DEPARTMENT. Notice of Determination (DE 2514). Paid Family Leave. You are not eligible.", t).letter_type, "ca-edd-sdi");
  // A UI notice that mentions SDI is still a UI notice; so is a UI denial that mentions disability.
  assert.equal(detectLetter("EMPLOYMENT DEVELOPMENT DEPARTMENT. Notice of Determination. Unemployment Insurance. You are not eligible. To appeal use form DE 1000M. If you are disabled you may file for State Disability Insurance.", t).letter_type, "ca-edd-determination");
  assert.notEqual(detectLetter("EDD denied my unemployment because I was on state disability before", t).letter_type, "ca-edd-sdi");
});

test("FTB Notice of Proposed Assessment: 60 days after mailing to protest (R&TC § 19041), no roll", () => {
  assert.equal(due("ca-ftb-npa", "2026-09-15"), "2026-11-14");   // a Saturday: early is safe, and the notice prints its own last day
  const t = "2026-09-30";
  assert.equal(detectLetter("I got a notice of proposed assessment from the Franchise Tax Board", t).letter_type, "ca-ftb-npa");
  assert.equal(detectLetter("the FTB says I owe more state tax", t).letter_type, "ca-ftb-npa");
  assert.equal(detectLetter("FRANCHISE TAX BOARD. Notice of Proposed Assessment. If you disagree, file a written protest within 60 days.", t).letter_type, "ca-ftb-npa");
  assert.equal(detectLetter("I got a letter from the IRS", t).letter_type, null);
  // A collection notice, a bill or a refund isn't a proposed assessment: the 60-day protest is long gone.
  for (const x of ["FTB sent a final notice before levy, I owe", "the franchise tax board sent me a bill", "FTB is garnishing my wages", "the FTB sent me my refund",
    "FRANCHISE TAX BOARD. Final Notice Before Levy and Lien. Balance due.",
    "FRANCHISE TAX BOARD. Final notice before levy. Your time to protest the Notice of Proposed Assessment ended 60 days after it was mailed."]) assert.notEqual(detectLetter(x, t).letter_type, "ca-ftb-npa", x);
  assert.deepEqual(detectLetter("the IRS says I owe more tax on my state tax refund", t).candidates, ["irs-cp2000", "irs-deficiency", "irs-levy"]);
  const r = computeDeadline("ca-ftb-npa", "2026-09-15", "2026-09-16");
  assert.match(r.speech, /File a written protest with the Franchise Tax Board/);
  assert.ok(r.next_steps.some(s => /becomes final/.test(s)));
});

// ---- housing: the sheriff's Notice to Vacate, and a subsidy contract ending ------------------------------------------
test("sheriff's Notice to Vacate: 5 days from service, no mailing extension, a weekend last day rolls (CCP §§ 715.020, 12a)", () => {
  assert.equal(due("ca-sheriff-vacate", "2026-09-15"), "2026-09-21");   // day 5 is Sunday the 20th: CCP § 12a moves it to Monday
  const t = "2026-09-16";
  const r = computeDeadline("ca-sheriff-vacate", "2026-09-15", t);
  assert.match(r.speech, /^You have until Monday, September 21, 2026 to move out, 5 days from today\. After that, the sheriff can lock you out\. Call free legal aid today about asking the court for more time\./);
  assert.ok(r.next_steps.some(s => /Mailing doesn't add days/.test(s)) && r.sources.some(s => s.includes("684.120")));
  assert.equal(detectLetter("the sheriff posted a notice to vacate on my door", t).letter_type, "ca-sheriff-vacate");
  // A landlord's lockout threat isn't a sheriff's notice: a lockout needs a judgment and the sheriff (Civil Code § 789.3).
  for (const x of ["they're going to lock me out", "my landlord says he is going to lock me out", "my landlord threatened to lock me out if I do not pay"])
    assert.notEqual(detectLetter(x, t).letter_type, "ca-sheriff-vacate", x);
  assert.equal(detectLetter("the sheriff is coming to lock me out on Monday", t).letter_type, "ca-sheriff-vacate");
  assert.equal(due("ca-sheriff-vacate", "2026-11-06"), "2026-11-12");   // day 5 is Veterans Day, Wed Nov 11: the next court day
  assert.equal(detectLetter("SHERIFF'S DEPARTMENT. NOTICE TO VACATE. Writ of Possession of Real Property. You must vacate within five days.", t).letter_type, "ca-sheriff-vacate");
  assert.deepEqual(detectLetter("my landlord gave me a notice to vacate", t).candidates, ["ca-30day-notice", "ca-60day-notice"]);
});

test("a subsidy contract ending: 90 days after you get the notice at your share of the rent (Civil Code § 1954.535)", () => {
  assert.equal(due("ca-subsidy-end", "2026-09-15"), "2026-12-14");
  const r = computeDeadline("ca-subsidy-end", "2026-09-15", "2026-09-16");
  assert.match(r.speech, /^Your landlord can't make you pay more than your share of the rent through Monday, December 14, 2026, 89 days from today\./);
  assert.match(r.how_we_counted[0], /^Received /);
  assert.ok(r.sources.some(s => s.includes("65863.10")));
  const t = "2026-09-16";
  assert.equal(detectLetter("my landlord is leaving Section 8", t).letter_type, "ca-subsidy-end");
  assert.equal(detectLetter("the owner won't renew the voucher contract", t).letter_type, "ca-subsidy-end");
  assert.equal(detectLetter("NOTICE OF NONRENEWAL. The owner will not renew the Housing Assistance Payments contract (Section 8). This notice gives you 90 days.", t).letter_type, "ca-subsidy-end");
  // The housing authority ending a family's voucher is a different letter; so is a rent increase for a tenant on Section 8.
  for (const x of ["the housing authority is terminating my voucher", "my voucher is being terminated", "HOUSING AUTHORITY. Notice of termination of assistance. Section 8 Housing Choice Voucher."])
    assert.notEqual(detectLetter(x, t).letter_type, "ca-subsidy-end", x);
  assert.notEqual(detectLetter("my landlord raised the rent and I am on Section 8", t).letter_type, "ca-subsidy-end");
  // The landlord ending the tenancy of a tenant who has a voucher is a notice to move, not the contract ending.
  assert.notEqual(detectLetter("my landlord is ending my lease and I have section 8", t).letter_type, "ca-subsidy-end");
});

// ---- utilities: electricity, gas and water shutoffs --------------------------------------------------------------
test("energy shutoff: no shutoff before 15 days after the notice is mailed (PUC § 779.1), HEDGE", () => {
  assert.equal(due("ca-utility-shutoff", "2026-09-15"), "2026-09-30");
  const r = computeDeadline("ca-utility-shutoff", "2026-09-15", "2026-09-16");
  assert.match(r.speech, /^A private utility can't shut off your service before Wednesday, September 30, 2026, 14 days from today\. Call the utility before that date/);
  assert.ok(r.next_steps.some(s => /24 hours ahead, or leave a notice at least 48 hours ahead/.test(s)));
  const t = "2026-09-16";
  assert.equal(detectLetter("PG&E sent a notice they're shutting off my power", t).letter_type, "ca-utility-shutoff");
  assert.equal(detectLetter("my gas is going to be turned off", t).letter_type, "ca-utility-shutoff");
  assert.equal(detectLetter("PACIFIC GAS AND ELECTRIC. 15-Day Notice. Your electric service may be disconnected for a past due balance. Call us to make a payment arrangement.", t).letter_type, "ca-utility-shutoff");
});

test("water shutoff: no shutoff before a bill is 60 days late (H&SC § 116908), HEDGE, and never read as power", () => {
  assert.equal(due("ca-water-shutoff", "2026-08-01"), "2026-09-30");
  const r = computeDeadline("ca-water-shutoff", "2026-08-01", "2026-09-16");
  assert.match(r.speech, /^Most water systems can't shut off your water before Wednesday, September 30, 2026, 14 days from today\./);
  assert.match(r.how_we_counted[0], /^The bill was due Saturday, August 1, 2026\./);
  assert.ok(r.next_steps.some(s => /7 business days/.test(s)) && r.sources.some(s => s.includes("116904")));
  const t = "2026-09-16";
  assert.equal(detectLetter("they're turning off my water", t).letter_type, "ca-water-shutoff");
  assert.equal(detectLetter("CITY WATER DEPARTMENT. Notice of discontinuation of water service. Your account is past due.", t).letter_type, "ca-water-shutoff");
  assert.equal(detectLetter("the utility says it will shut off my water", t).letter_type, "ca-water-shutoff");
});

test("shutoffs: gas vs water, no roll, HEDGE, the due-date answer, and the letters they must never claim", () => {
  const t = "2026-09-30";
  // A gas shutoff that mentions hot water is a gas shutoff (15 days), not a water shutoff (60).
  assert.equal(detectLetter("SoCalGas is shutting off my gas and I won't have hot water", t).letter_type, "ca-utility-shutoff");
  assert.equal(detectLetter("they're turning off the gas and my water heater won't work", t).letter_type, "ca-utility-shutoff");
  // No roll: a Sunday stays a Sunday (early is safe). Both are HEDGE.
  assert.equal(due("ca-utility-shutoff", "2026-09-19"), "2026-10-04");
  assert.equal(due("ca-water-shutoff", "2026-08-05"), "2026-10-04");
  assert.equal(rule("ca-utility-shutoff").confidence, "HEDGE");
  assert.equal(rule("ca-water-shutoff").confidence, "HEDGE");
  // The answer to "when was the bill due?" looks back.
  assert.equal(detectLetter("water shutoff, it was due August 1st", t).suggested_notice_date, "2026-08-01");
  assert.equal(detectLetter("my water is getting shut off, the due date was the 1st of August", t).suggested_notice_date, "2026-08-01");
  // Never: a past-due bill with no shutoff, a landlord (Civil Code § 789.3), a safety outage, a city or district
  // utility, propane.
  const never = { "ca-utility-shutoff": ["my PG&E bill is past due", "PG&E. Your balance is past due. Please pay by October 15.", "my landlord is going to shut off my power",
      "PG&E public safety power shutoff notice for Thursday", "PG&E says they're turning off power for fire weather", "SMUD is going to shut off my power",
      "LADWP sent a disconnection notice for my electric", "my propane gas is getting cut off"],
    "ca-water-shutoff": ["my water bill is past due", "CITY WATER DEPARTMENT. Your water bill is past due. Please pay the balance.", "my landlord shut off the water to force me out",
      "there's a water outage on my street and they shut it off"] };
  for (const [id, xs] of Object.entries(never)) for (const x of xs) assert.notEqual(detectLetter(x, t).letter_type, id, x);
  const w = computeDeadline("ca-water-shutoff", "2026-08-01", "2026-09-16");
  assert.ok(w.next_steps.some(s => /while the appeal is pending, the water system can't shut off your water/.test(s)));
  assert.ok(w.next_steps.some(s => /under twice the poverty level/.test(s)) && w.sources.some(s => s.includes("for 60 days or more")));
});

// ---- traffic: a traffic ticket, and a DMV suspension after a DUI arrest --------------------------------------------
test("traffic ticket: HEDGE with nothing to count; the ticket or courtesy notice prints the date", () => {
  const r = computeDeadline("ca-traffic-ticket", undefined, "2026-09-16");
  assert.equal(r.deadline, null);
  assert.match(r.speech, /^A traffic ticket prints its own date to appear by, and that's the date that counts, unless the court has given you a later one in writing\. Act by the appearance date on your ticket\./);
  assert.ok(r.next_steps.some(s => /extends that date by 25 calendar days and sends the TR-205 form: file it and deposit the bail by the new date/.test(s)));
  assert.ok(r.sources.some(s => s.includes("4.210(b)")));
  const t = "2026-09-16";
  assert.equal(detectLetter("I got a speeding ticket", t).letter_type, "ca-traffic-ticket");
  assert.equal(detectLetter("the traffic court sent me a courtesy notice", t).letter_type, "ca-traffic-ticket");
  assert.equal(detectLetter("I got a parking ticket", t).letter_type, "ca-parking-ticket");
  assert.equal(detectLetter("SUPERIOR COURT OF CALIFORNIA. Traffic courtesy notice. Citation No. 0000. Vehicle Code 22350. Appearance date: October 20, 2026. Bail: $0.", t).letter_type, "ca-traffic-ticket");
  assert.equal(detectLetter("I got a speeding ticket", t).needs_date, false);
  for (const x of ["I got a notice to appear in court for my eviction", "the court says I failed to appear on my traffic ticket and added a civil assessment",
    "I got a citation for my dog barking"]) assert.notEqual(detectLetter(x, t).letter_type, "ca-traffic-ticket", x);
  assert.equal(detectLetter("I got a red light camera ticket", t).letter_type, "ca-traffic-ticket");
});

test("DMV admin per se: 10 days from getting the notice to ask for a hearing (Vehicle Code § 13558), no roll", () => {
  assert.equal(due("ca-dmv-aps", "2026-09-15"), "2026-09-25");
  const r = computeDeadline("ca-dmv-aps", "2026-09-15", "2026-09-16");
  assert.match(r.speech, /^Your deadline is Friday, September 25, 2026, 9 days from today\. Ask the DMV for a hearing\./);
  assert.match(r.how_we_counted[0], /^Received /);
  assert.ok(r.next_steps.some(s => /hold the hearing and decide before the suspension starts, or put the suspension on hold/.test(s)) && r.sources.some(s => s.includes("(e)")));
  const t = "2026-09-16";
  assert.equal(detectLetter("the officer gave me a pink notice, the DMV is suspending my license", t).letter_type, "ca-dmv-aps");
  assert.equal(detectLetter("I got a DUI and the DMV is taking my license", t).letter_type, "ca-dmv-aps");
  assert.equal(detectLetter("DEPARTMENT OF MOTOR VEHICLES. Administrative Per Se Suspension/Revocation Order. Driving under the influence. You may request a hearing.", t).letter_type, "ca-dmv-aps");
  // Other suspensions have other rules and other deadlines.
  for (const x of ["the DMV suspended my license for unpaid tickets", "DMV suspended my license because I have no insurance",
    "the DMV says I have too many points, I'm a negligent operator", "DEPARTMENT OF MOTOR VEHICLES. Order of suspension. Failure to appear. You may request a hearing."])
    assert.notEqual(detectLetter(x, t).letter_type, "ca-dmv-aps", x);
});

test("a hearing offer alone isn't a Social Security reconsideration", () => {
  assert.equal(detectLetter("The county sent a letter. You may request a hearing about this decision.", "2026-09-16").letter_type, null);
  assert.equal(detectLetter("SOCIAL SECURITY ADMINISTRATION Notice of Reconsideration. If you disagree, you may request a hearing before an administrative law judge.", "2026-09-16").letter_type, "ssa-recon");
});

// ---- consumer: a debt collector's validation notice, and a car repossession notice -------------------------------
test("debt validation: HEDGE with nothing to count; the notice prints the date to dispute by", () => {
  const r = computeDeadline("debt-validation", undefined, "2026-09-16");
  assert.equal(r.deadline, null);
  assert.match(r.speech, /^A debt collector's validation notice prints a date to dispute the debt by\. Dispute in writing by that date if you can\. If the notice reached you late, you may have until 30 days after you got it\. If you don't think you owe it/);
  assert.ok(r.sources.some(s => s.includes("1006.34(b)(5)")) && r.sources.some(s => s.includes("1692g")));
  const t = "2026-09-16";
  assert.equal(detectLetter("a debt collector sent me a letter and I don't owe this", t).letter_type, "debt-validation");
  assert.equal(detectLetter("I got a letter from a collection agency", t).letter_type, "debt-validation");
  assert.equal(detectLetter("This is a communication from a debt collector. Validation notice. You can dispute all or part of the debt by October 30, 2026.", t).letter_type, "debt-validation");
  // A lawsuit over a debt is court papers, not a validation notice.
  assert.equal(detectLetter("a debt collector sued me and I got a summons", t).letter_type, "ca-civil-summons");
  // A government agency collecting its own debt isn't a debt collector's validation notice.
  for (const x of ["the IRS sent me a collection notice", "the FTB collections unit sent me a letter", "EDD sent an overpayment collection notice",
    "Social Security sent a collection letter about my overpayment", "the child support agency collections letter came", "the city changed my trash collection day"])
    assert.notEqual(detectLetter(x, t).letter_type, "debt-validation", x);
});

test("repossession notice: redeem or reinstate for 15 days from mailing, 10 more on written request (Civil Code § 2983.2)", () => {
  assert.equal(due("ca-repo-notice", "2026-09-15"), "2026-09-30");
  const r = computeDeadline("ca-repo-notice", "2026-09-15", "2026-09-16");
  assert.match(r.speech, /^You can get the car back by paying off the contract, or sometimes by catching up on it, at least until Wednesday, September 30, 2026, 14 days from today\. Call the lender.*If you ask in writing before then, they have to add 10 more days, to Saturday, October 10, 2026 for a 15-day notice\./);
  assert.ok(/20 days instead of 15, and 30 with the extension/.test(r.how_we_counted.join(" ")));
  const t = "2026-09-16";
  assert.equal(detectLetter("my car was repossessed and they sent a notice of intent to sell", t).letter_type, "ca-repo-notice");
  assert.equal(detectLetter("they repo'd my truck", t).letter_type, "ca-repo-notice");
  // § 2983.2 is for cars: not a license, benefits, a pawn, a home, a storage unit or furniture.
  for (const x of ["I want to reinstate my driver's license", "how do I get my Medi-Cal reinstated", "I need to redeem my ring at the pawn shop",
    "NOTICE OF TRUSTEE'S SALE. The trustee intends to sell your home at public auction.", "my rent-to-own furniture got repossessed",
    "the storage unit sent a notice of intent to sell my things"]) assert.notEqual(detectLetter(x, t).letter_type, "ca-repo-notice", x);
  assert.equal(detectLetter("NOTICE OF INTENT TO DISPOSE OF REPOSSESSED MOTOR VEHICLE. You may redeem the vehicle or reinstate the contract.", t).letter_type, "ca-repo-notice");
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
  for (const x of ["public housing sent a notice about pest control", "public housing is doing my annual recertification"])
    assert.notEqual(detectLetter(x, t).letter_type, "hud-public-housing", x);
  // The housing authority ending a voucher is its own letter now (tried before the owner's contract ending).
  assert.equal(detectLetter("the housing authority is terminating my voucher", t).letter_type, "hud-voucher-termination");
  for (const x of ["the housing authority is inspecting my unit next week", "the housing authority says my rent share is going up"])
    assert.notEqual(detectLetter(x, t).letter_type, "hud-voucher-termination", x);
  assert.equal(detectLetter("HOUSING AUTHORITY. Public housing lease termination notice. Failure to pay rent. You may request a grievance hearing.", t).letter_type, "hud-public-housing");
});

test("stack review: other programs' disability letters, decisions vs reconsiderations, missed dates, sold cars, the housing authority", () => {
  const t = "2026-09-30";
  const is = (x, id) => assert.equal(detectLetter(x, t).letter_type, id, x);
  const not = (x, id) => assert.notEqual(detectLetter(x, t).letter_type, id, x);
  // R1/R2: workers' comp, state disability, long-term disability through work and the VA aren't Social Security.
  not("the judge denied my workers comp disability claim at the hearing", "ssa-appeals-council");
  for (const x of ["my state disability is stopping", "my long term disability insurance through work is ending", "the VA is reducing my disability rating"])
    not(x, "ssa-benefits-ending");
  not("the VA denied my disability again", "ssa-recon");
  is("EDD stopped my disability payments", "ca-edd-sdi");
  for (const x of ["EDD denied my unemployment because I was on state disability before", "EDD denied my unemployment and told me to apply for disability instead"])
    is(x, "ca-edd-determination");
  is("Social Security says my retirement benefits are stopping", "ssa-benefits-ending");
  // A sentence that names Social Security stays Social Security's, even when it mentions EDD too.
  is("social security denied my disability and EDD cut off my SDI too", "ssa-initial");
  assert.ok(computeDeadline("ssa-benefits-ending", "2026-09-13", "2026-09-14").next_steps.some(s => /For retirement, survivors or other benefits that aren't about disability, appealing doesn't keep payments going/.test(s)));
  // R3: a reconsideration that mentions the Appeals Council is still a reconsideration; a hearing decision isn't.
  is("SOCIAL SECURITY ADMINISTRATION Notice of Reconsideration. We found you are not disabled. If you disagree, request a hearing before an administrative law judge. If you then disagree with the hearing, you can ask the Appeals Council.", "ssa-recon");
  is("SOCIAL SECURITY ADMINISTRATION. Notice of Decision - Unfavorable. The administrative law judge found you not disabled. If you disagree, you may ask the Appeals Council to review it.", "ssa-appeals-council");
  // A reconsideration notice, verbatim from review: "hearing decision" there is the next step, not this letter.
  is("SOCIAL SECURITY ADMINISTRATION Notice of Reconsideration. If you disagree, you may request a hearing before an administrative law judge. If you disagree with the hearing decision, you may ask the Appeals Council to review it.", "ssa-recon");
  // …even when the decision mentions the reconsideration that came before it (the reconsideration bonus would win).
  is("SOCIAL SECURITY ADMINISTRATION. Notice of Decision - Unfavorable. After your reconsideration, the administrative law judge found you not disabled. You may ask the Appeals Council to review this hearing decision.", "ssa-appeals-council");
  // R4: a missed traffic court date isn't a ticket to act on by its date.
  for (const x of ["I missed my traffic court date", "I didn't go to court for my traffic ticket and now there's a fee"]) not(x, "ca-traffic-ticket");
  // After the sale there's nothing to redeem: that's a deficiency.
  for (const x of ["they repossessed my car and sold it and now I owe the difference", "my car was repossessed and sold at auction, they say I owe a deficiency"])
    not(x, "ca-repo-notice");
  // The housing authority as landlord isn't a utility; multi-word city utilities aren't private ones.
  not("the housing authority is shutting off my water", "ca-water-shutoff");
  not("the housing authority says they're turning off the power in my unit", "ca-utility-shutoff");
  for (const x of ["the city of Palo Alto utilities is shutting off my electric", "City Utilities sent a disconnect notice for my power"]) not(x, "ca-utility-shutoff");
  not("the city of San Luis Obispo utilities is shutting off my electric", "ca-utility-shutoff");
  // The city pattern stays inside a name: a city mentioned elsewhere in the sentence doesn't exclude a private utility.
  is("the city of Oakland told me the power company will shut off my power", "ca-utility-shutoff");
  // A voucher ending with no one named goes to the housing authority's rule, which is tried first (a short hearing window).
  is("my section 8 voucher contract is being terminated", "hud-voucher-termination");
  assert.ok(SPOKEN_ORDER.indexOf("hud-voucher-termination") < SPOKEN_ORDER.indexOf("ca-subsidy-end"));
  is("I got kicked off section 8", "hud-voucher-termination");
  is("the hospital sent my bill to collections", "debt-validation");
});

test("the date answer with the letter known: a bill's due date looks back only for a rule counted from it", () => {
  const t = "2026-09-30";
  // The dialog's date turn: the answer alone has no letter in it, so the known letter comes along as letterType.
  for (const x of ["the due date was August 1st", "it's due August 1st", "due date August 1st"]) {
    assert.equal(detectLetter(x, t).suggested_notice_date, null, x);
    assert.equal(detectLetter(x, t, [], { letterType: "ca-water-shutoff" }).suggested_notice_date, "2026-08-01", x);
  }
  assert.equal(detectLetter("it's due October 5th", t, [], { letterType: "ssa-recon" }).suggested_notice_date, null);
});

test("routing: strong decision markers, EDD-led sentences, the judge's ruling, SSI's Notice of Decision, city names, a breath-test refusal, the VA", () => {
  const t = "2026-09-30";
  const is = (x, id) => assert.equal(detectLetter(x, t).letter_type, id, x);
  const not = (x, id) => assert.notEqual(detectLetter(x, t).letter_type, id, x);
  // E1: a judge's decision is a decision, even after the words "notice of reconsideration".
  is("SOCIAL SECURITY ADMINISTRATION. After your notice of reconsideration, the administrative law judge found you not disabled. You may ask the Appeals Council to review this hearing decision.", "ssa-appeals-council");
  // n1: a hearing that went against you is the Appeals Council's step.
  is("the Social Security judge ruled against me at my hearing", "ssa-appeals-council");
  // A Notice of Reconsideration says which letter it is, even when it mentions the hearing to come.
  is("SOCIAL SECURITY ADMINISTRATION Notice of Reconsideration. We still find you are not disabled. If you disagree after the hearing, you may ask the Appeals Council.", "ssa-recon");
  // With no decision in it, a denial that mentions a hearing is asked about: had the hearing yet? (Both answers give
  // 60 days plus 5; only the next step differs.)
  const ASK = ["ssa-recon", "ssa-appeals-council"];
  for (const x of ["Social Security denied me again and the judge said I can have a hearing", "Social Security denied me again after the hearing was scheduled",
    "social security denied me again, what do I say at my hearing", "social security denied me again, after the hearing gets scheduled what happens",
    "social security denied me again and my hearing is scheduled", "social security denied me again and the hearing was postponed",
    "I lost after the hearing, social security denied my disability", "after my hearing social security said no again", "they said no at my hearing for social security",
    "what do I say at my hearing if social security denied me again", "social security denied me again and I need help at the hearing because they denied me twice",
    "they turned me down at the hearing, social security disability", "social security denied my disability and my hearing is next month",
    "social security denied me, what do I bring to my hearing", "SSA turned me down, when is my hearing"]) {
    const q = detectLetter(x, t);
    assert.equal(q.letter_type, null, x); assert.deepEqual(q.candidates, ASK, x);
    assert.equal(q.speech, "Have you already had your Social Security hearing with a judge?", x);
  }
  // The answers, both ways, including the ones that could be misread.
  for (const [a, id] of [["yes", "ssa-appeals-council"], ["yeah, I already had it", "ssa-appeals-council"], ["the judge said no", "ssa-appeals-council"],
    ["I lost", "ssa-appeals-council"], ["no", "ssa-recon"], ["not yet", "ssa-recon"], ["no, I haven't had it", "ssa-recon"],
    ["it's scheduled for next month", "ssa-recon"], ["I'm still waiting", "ssa-recon"],
    ["yes, I had it last month", "ssa-appeals-council"], ["no, not yet", "ssa-recon"], ["it's next week", "ssa-recon"]])
    assert.equal(detectLetter(a, t, ASK).letter_type, id, a);
  // "I don't know" settles nothing, so the question comes again.
  const again = detectLetter("I don't know", t, ASK);
  assert.equal(again.letter_type, null); assert.deepEqual(again.candidates, ASK); assert.equal(again.speech, "Have you already had your Social Security hearing with a judge?");
  // dd9's sentences: asked (never the Appeals Council directly); and one said after the hearing, never recon directly.
  for (const x of ["after the hearing was scheduled social security denied me again", "I have to show up at my hearing because they denied me again, social security",
    "what happens at my hearing if social security denied me twice", "at my hearing next month can I say they denied me unfairly, social security",
    "social security denied me after my hearing"]) assert.deepEqual(detectLetter(x, t).candidates, ASK, x);
  // The ask never takes another program's letter that mentions Social Security, SSI or a disability: the rules pick
  // first, and the ask overrides only its own letters (or an initial denial), or nothing.
  for (const [x, id] of [["my SSI was cut and I asked for a hearing", "ssa-benefits-ending"], ["they're stopping my SSI, can I get a hearing", "ssa-benefits-ending"],
    ["social security says I was overpaid, I want a hearing", "ssa-overpayment"],
    ["I got an unlawful detainer and the hearing is next week, I'm on SSI", "ca-ud"],
    ["I got an eviction summons, I live on social security, when is my hearing", "ca-ud"],
    ["my landlord gave me a 3 day notice, I'm on social security, do I get a hearing", "ca-3day"],
    ["the county cut my CalFresh, I have a disability, I want a state hearing", "ca-noa"],
    ["I got a DUI and the DMV is taking my license, I'm on SSI, I want a hearing", "ca-dmv-aps"],
    ["public housing is evicting me, I'm on SSI, I want a grievance hearing", "hud-public-housing"],
    ["I got a jury summons, I'm on disability, is there a hearing to be excused", "jury-summons"],
    ["the housing authority is terminating my section 8 and I have a hearing, I'm on SSI", "hud-voucher-termination"],
    ["I have a disability placard and want a hearing on my parking ticket", "ca-parking-ticket"]]) is(x, id);
  // A housing *letter* isn't a reconsideration; a Social Security denial from a tenant still is.
  for (const x of ["social security denied my disability again, and my landlord wants to evict me", "social security denied my disability a second time, I'm a tenant and scared"])
    is(x, "ssa-recon");
  // The ask needs an outcome or appeal word: other hearings from callers on SSI aren't asked.
  for (const x of ["I have a custody hearing next week and I'm on SSI", "I have an immigration hearing and I get SSI", "I'm on SSI and I have a criminal hearing for a misdemeanor",
    "I'm on social security and I have a small claims hearing", "I have a hearing about my disability accommodation at work with a judge"])
    assert.deepEqual(detectLetter(x, t).candidates, [], x);
  is("the disability judge denied me at my hearing, social security", "ssa-appeals-council");
  not("the judge denied my disability accommodation at my job hearing", "ssa-appeals-council");
  // With no denial word, a disability judge's hearing to come is still asked about; only another court's hearing
  // (small claims, custody, immigration, criminal…) keeps Social Security out.
  assert.deepEqual(detectLetter("I have a hearing with the disability judge next month", t).candidates, ASK);
  not("the DMV is suspending my license, I'm on disability, can I get a hearing", "ssa-benefits-ending");
  is("PG&E is shutting off my power, I am on SSI, can I get a hearing", "ca-utility-shutoff");
  is("the IRS sent a final notice of intent to levy my social security, I want a hearing", "irs-levy");
  assert.deepEqual(detectLetter("a debt collector is garnishing my social security, can I get a hearing", t).candidates, []);
  assert.equal(detectLetter("I went but they haven't decided", t, ASK).letter_type, "ssa-appeals-council");
  // A bare "disability" with a hearing isn't Social Security's.
  assert.equal(detectLetter("I have a hearing about my disability accommodation at work", t).letter_type, null);
  assert.deepEqual(detectLetter("I have a hearing about my disability accommodation at work", t).candidates, []);
  // Answers that could be misread: an outcome beats a leading "no"; a hearing already had isn't "not yet".
  for (const [a, id] of [["no, the judge ruled against me", "ssa-appeals-council"], ["I had it but I haven't heard back yet", "ssa-appeals-council"],
    ["I haven't gotten the decision yet", "ssa-appeals-council"], ["I haven't had my hearing yet", "ssa-recon"], ["I asked for one but haven't had it", "ssa-recon"]])
    assert.equal(detectLetter(a, t, ASK).letter_type, id, a);
  // A Notice of Reconsideration that mentions losing at a hearing still says which letter it is (the title guard).
  is("SOCIAL SECURITY ADMINISTRATION Notice of Reconsideration. We still find you are not disabled. Many people who lost at the hearing ask the Appeals Council; first you may request a hearing before an administrative law judge.", "ssa-recon");
  // A printed initial denial isn't asked about a hearing: it says what it is. (Which SSA rule its scoring picks is
  // outside this change.)
  assert.deepEqual(detectLetter("SOCIAL SECURITY ADMINISTRATION. Notice of Disapproved Claim. We found you are not disabled. If you disagree, you may request reconsideration; a hearing comes later.", t).candidates, []);
  // n3: an SSI initial determination is titled "Notice of Decision".
  is("SOCIAL SECURITY ADMINISTRATION. Supplemental Security Income. Notice of Decision. You are not eligible for SSI. If you disagree, you may ask for reconsideration within 60 days.", "ssa-initial");
  // S1: a sentence that leads with EDD is EDD's; one that leads with Social Security stays Social Security's.
  is("EDD denied my disability, I'm also on social security", "ca-edd-sdi");
  is("social security denied my disability and EDD cut off my SDI too", "ssa-initial");
  // O2: a city named in the sentence isn't a city utility's name; "Water and Power" is.
  is("the city of Oakland said power will be cut off", "ca-utility-shutoff");
  is("the city of Oakland said power will be cut off for my building", "ca-utility-shutoff");
  not("Glendale Water and Power is disconnecting my electric", "ca-utility-shutoff");
  // n2: refusing the breath test is an admin per se suspension.
  is("I refused the breathalyzer and the DMV is suspending my license", "ca-dmv-aps");
  is("DEPARTMENT OF MOTOR VEHICLES. Order of suspension. You refused the breathalyzer. You may request a hearing.", "ca-dmv-aps");
  // The VA, not "Va." (Virginia).
  is("I moved from Va. and they denied my disability again", "ssa-recon");
  not("my disability check from the va is being reduced", "ssa-benefits-ending");
  not("the VA denied my disability claim", "ssa-initial");
  // A due date read back that lands most of a year ago is asked again, not taken.
  assert.equal(detectLetter("the due date was December 1st", t, [], { letterType: "ca-water-shutoff" }).suggested_notice_date, null);
  assert.equal(detectLetter("the due date was August 1st", t, [], { letterType: "ca-water-shutoff" }).suggested_notice_date, "2026-08-01");
});

test("follow-ups: other courts' hearings, 'reconsidered', and 'filed an eviction'", () => {
  const t = "2026-09-30";
  // Another court's hearing that went against a caller on Social Security isn't the Appeals Council's.
  for (const x of ["I'm on social security and I lost my custody hearing", "I'm on SSI and the judge denied bail at my criminal hearing",
    "I'm on SSDI and my immigration judge denied my asylum at the hearing"])
    assert.notEqual(detectLetter(x, t).letter_type, "ssa-appeals-council", x);
  // …unless it names a Social Security appeal.
  assert.equal(detectLetter("my disability hearing went against me, and I also have a custody case, social security", t).letter_type === "ssa-appeals-council"
    || detectLetter("my disability hearing went against me, and I also have a custody case, social security", t).candidates.includes("ssa-appeals-council"), true);
  assert.equal(detectLetter("social security reconsidered and I still can't get disability", t).letter_type, "ssa-recon");
  assert.equal(detectLetter("I get SSI and my landlord filed an eviction, the hearing is next week", t).letter_type, "ca-ud");
  assert.equal(detectLetter("I lost my eviction case and the sheriff put a notice on my door", t).letter_type, "ca-sheriff-vacate");
});

test("Social Security said as income, the county's hearing, and 'I haven't went yet'", () => {
  const t = "2026-09-30";
  // The rules pick first: a county benefits hearing from a caller on SSI keeps its rule (not the hearing question).
  for (const x of ["I'm on SSI and the county denied my CalFresh, I want a hearing", "I'm on SSDI, Medi-Cal denied my claim, I want a fair hearing"])
    assert.equal(detectLetter(x, t).letter_type, "ca-noa", x);
  // …and when another program's rule picks the letter, the hearing question doesn't take it, even with a Social Security
  // denial in the same sentence (the DMV's 10 days come first).
  assert.equal(detectLetter("the DMV suspended my license after the DUI and social security denied me, I want a hearing", t).letter_type, "ca-dmv-aps");
  // Social Security as income next to another agency's decision isn't a Social Security letter.
  assert.equal(detectLetter("I'm on social security, the DMV denied my license after the DUI, I want a hearing", t).letter_type, "ca-dmv-aps");
  assert.equal(detectLetter("social security is my income and the housing authority denied my section 8, I want a hearing", t).letter_type, "hud-voucher-termination");
  for (const x of ["I'm on SSI and my parking ticket appeal was denied, can I get a hearing", "I'm on SSI and my landlord denied my repair request, can I get a hearing"]) {
    const r = detectLetter(x, t);
    assert.ok(!["ssa-recon", "ssa-appeals-council", "ssa-initial"].includes(r.letter_type) && r.candidates.length === 0, x);
  }
  // A Social Security denial said by someone on SSI is still Social Security's.
  assert.equal(detectLetter("I'm on SSI and social security denied my disability again", t).letter_type, "ssa-recon");
  assert.equal(detectLetter("I haven't went yet", t, ["ssa-recon", "ssa-appeals-council"]).letter_type, "ssa-recon");
});

test("Social Security deciding (not just income), a Social Security judge, and cue-less hearing letters", () => {
  const t = "2026-09-30";
  const is = (x, id) => assert.equal(detectLetter(x, t).letter_type, id, x);
  // S1: Social Security (or "they") is the one deciding; the agency word is only the reason.
  for (const [x, id] of [["I get SSDI and social security says I was overpaid because of my EDD payments", "ssa-overpayment"],
    ["I'm on SSI and they are cutting it because I live with my landlord for free", "ssa-benefits-ending"],
    ["I get SSI and social security is reducing my check because Medi-Cal pays my nursing home", "ssa-benefits-ending"],
    ["I receive SSI and the county says I have too many resources, and social security denied me again", "ssa-recon"],
    ["I'm on SSI and social security denied my disability again, the county said to appeal", "ssa-recon"]]) is(x, id);
  // …while Social Security as income next to another agency's decision still keeps that agency's rule.
  is("I'm on social security, the DMV denied my license after the DUI, I want a hearing", "ca-dmv-aps");
  is("social security is my income and the housing authority denied my section 8, I want a hearing", "hud-voucher-termination");
  is("my landlord gave me a 3 day notice, I'm on social security, do I get a hearing", "ca-3day");
  // S2: a Social Security judge is a Social Security appeal, even with a custody case in the same breath.
  for (const x of ["the social security judge denied me at the hearing, I also have a custody case",
    "the social security judge ruled against me at my hearing, and now my ex wants custody"]) is(x, "ssa-appeals-council");
  // A letter about a hearing to come, with no denial word and no judge, isn't guessed as a reconsideration.
  for (const x of ["Social Security sent me a letter and I have a hearing coming up, what's my deadline", "I got a letter from social security about a hearing"])
    assert.notEqual(detectLetter(x, t).letter_type, "ssa-recon", x);
  assert.deepEqual(detectLetter("I have a hearing with the disability judge next month", t).candidates, ["ssa-recon", "ssa-appeals-council"]);
});

test("Social Security deciding, from the gate's set; a lost Social Security hearing; the DMV with no income phrase", () => {
  const t = "2026-09-30";
  const is = (x, id) => assert.equal(detectLetter(x, t).letter_type, id, x);
  for (const [x, id] of [["I get SSI and social security is stopping it because I got Medi-Cal", "ssa-benefits-ending"],
    ["I'm on SSI and social security is cutting my check because of my Section 8 rent", "ssa-benefits-ending"],
    ["I'm on SSDI and social security denied my disability again, the county said to appeal", "ssa-recon"],
    ["I'm on SSI and social security says I was overpaid, the county told me to call", "ssa-overpayment"],
    ["I receive SSI, social security sent a notice of overpayment, the IRS took my refund", "ssa-overpayment"]]) is(x, id);
  // The county's own hearings from callers on SSI still keep the county's rule.
  for (const x of ["I'm on SSI and the county denied my CalFresh, I want a hearing", "I'm on SSDI, Medi-Cal denied my claim, I want a fair hearing"]) is(x, "ca-noa");
  is("I lost at my social security hearing", "ssa-appeals-council");
  // With no income phrase, the DMV words in NOT_SSA are what keep a DMV letter out of Social Security's rules.
  assert.notEqual(detectLetter("the DMV suspended my disability parking placard and I want a hearing", t).letter_type, "ssa-benefits-ending");
});

// ---- foreclosure (a deed of trust), and small claims ---------------------------------------------------------------
test("foreclosure and small claims: HEDGE with nothing to count; the right people, the right letters", () => {
  const t = "2026-09-30";
  const is = (x, id) => assert.equal(detectLetter(x, t).letter_type, id, x);
  const not = (x, id) => assert.notEqual(detectLetter(x, t).letter_type, id, x);
  for (const id of ["ca-foreclosure-nod", "ca-foreclosure-sale", "ca-small-claims"]) {
    const r = computeDeadline(id, undefined, t);
    assert.equal(r.deadline, null, id); assert.equal(r.confidence, "HEDGE", id);
  }
  assert.match(computeDeadline("ca-foreclosure-nod", undefined, t).speech, /^A Notice of Default starts the foreclosure clock: the home can't be sold until at least 3 months and 20 days after it was recorded/);
  assert.match(computeDeadline("ca-foreclosure-sale", undefined, t).speech, /You can usually still catch up on the loan \(reinstate\) until 5 business days before that date\./);
  assert.ok(computeDeadline("ca-foreclosure-sale", undefined, t).sources.some(s => s.includes("2924c(e)")));
  const sc = computeDeadline("ca-small-claims", undefined, t);
  assert.ok(sc.next_steps.some(s => /^If you can't go that day, ask the court in writing to postpone it, at least 10 days before the hearing if you can\. Later, you can still ask, but you'll need a good reason\. Mail or hand a copy to each of the other parties the same day\.$/.test(s)) && sc.next_steps.some(s => /at least 15 days before the hearing, or 20/.test(s)));
  is("I got a notice of default on my house", "ca-foreclosure-nod");
  is("NOTICE OF DEFAULT AND ELECTION TO SELL UNDER DEED OF TRUST. You may have the legal right to bring your account in good standing by paying all of your past due payments.", "ca-foreclosure-nod");
  is("I got a notice of trustee's sale", "ca-foreclosure-sale");
  is("they're auctioning off my house next month", "ca-foreclosure-sale");
  is("they're suing me in small claims", "ca-small-claims");
  is("PLAINTIFF'S CLAIM AND ORDER TO GO TO SMALL CLAIMS COURT (SC-100). The defendant must appear at the hearing.", "ca-small-claims");
  for (const x of ["my car is going to be sold at auction", "the storage unit is auctioning my things", "the county tax collector says my house will be sold at a tax sale"])
    not(x, "ca-foreclosure-sale");
  // A printed vehicle or tax-sale notice scores like a trustee's sale without the exclusion.
  for (const x of ["NOTICE OF SALE. Your vehicle will be sold at public auction to the highest bidder.", "NOTICE OF SALE. Tax-defaulted property will be sold at public auction to the highest bidder."])
    not(x, "ca-foreclosure-sale");
  for (const x of ["the county says my property taxes are in default", "my landlord is being foreclosed on and I rent the house"]) not(x, "ca-foreclosure-nod");
  for (const x of ["I want to sue my landlord in small claims for my deposit", "I won my small claims case but they won't pay"]) not(x, "ca-small-claims");
});

test("foreclosure and small claims: evictions stay evictions, tenants and other sales stay out", () => {
  const t = "2026-09-30";
  const is = (x, id) => assert.equal(detectLetter(x, t).letter_type, id, x);
  const not = (x, id) => assert.notEqual(detectLetter(x, t).letter_type, id, x);
  // Small claims can't hear an eviction: an unlawful detainer keeps its 5 court days.
  for (const x of ["I got an unlawful detainer, is this small claims?", "my landlord filed an eviction, it's not small claims right?",
    "I got eviction papers from small claims court"]) is(x, "ca-ud");
  // A printed small-claims form that speaks of eviction isn't a small-claims answer either (the exclusion, not the order).
  not("PLAINTIFF'S CLAIM AND ORDER TO GO TO SMALL CLAIMS COURT. The plaintiff asks the court to evict the defendant from the rental.", "ca-small-claims");
  is("my landlord is suing me in small claims for back rent", "ca-small-claims");
  is("a debt collector sued me in small claims", "ca-small-claims");
  is("I got a summons for small claims court", "ca-small-claims");
  // A tenant, or an IRS or sheriff's sale, isn't a trustee's sale to catch up on.
  for (const x of ["my landlord's house has a notice of trustee's sale, I rent here", "I got a notice to vacate, the house I rent was sold at a foreclosure auction",
    "the IRS is going to auction my house", "the sheriff is auctioning my house for a judgment"]) not(x, "ca-foreclosure-sale");
  // A notice of default followed by a notice of sale is at the sale stage.
  is("I got a notice of default and now a notice of trustee's sale", "ca-foreclosure-sale");
});

test("small claims defendants, evictions, and HOA foreclosures", () => {
  const t = "2026-09-30";
  const is = (x, id) => assert.equal(detectLetter(x, t).letter_type, id, x);
  for (const x of ["my landlord filed an eviction, is that like small claims?", "I got eviction papers, not small claims"]) is(x, "ca-ud");
  // Defendants who mention collecting, not paying or a judgment are still being sued.
  for (const x of ["a collection agency is suing me in small claims", "my landlord is suing me in small claims because he says I won't pay for the damage",
    "they're suing me in small claims and I'm afraid of a judgment", "a debt collector sued me in small claims"]) is(x, "ca-small-claims");
  assert.notEqual(detectLetter("I won my small claims case and they won't pay", t).letter_type, "ca-small-claims");
  // An HOA's foreclosure is answered by the Notice of Default rule, with the § 5715 redemption step (see below).
  for (const x of ["the HOA sent a notice of default on my condo", "my homeowners association is foreclosing on an assessment lien"])
    assert.equal(detectLetter(x, t).letter_type, "ca-foreclosure-nod", x);
  assert.ok(computeDeadline("ca-foreclosure-nod", undefined, t).sources.some(s => s.includes("2924c(b)(1)")));
});

test("after #19: a printed 'no deficiency judgment', curly apostrophes, 'a UD', back rent after an eviction, 'they' and whose program", () => {
  const t = "2026-09-30";
  const is = (x, id) => assert.equal(detectLetter(x, t).letter_type, id, x);
  is("NOTICE OF TRUSTEE'S SALE. The trustee will sell at public auction to the highest bidder. Deed of trust dated 2019. No deficiency judgment.", "ca-foreclosure-sale");
  assert.notEqual(detectLetter("the sheriff is selling my house to collect a judgment", t).letter_type, "ca-foreclosure-sale");
  for (const x of ["I won’t pay, and they’re suing me in small claims", "I won’t pay my landlord for the damage and he’s suing me in small claims"]) is(x, "ca-small-claims");
  is("I got a UD", "ca-ud");
  is("my landlord is suing me in small claims for back rent after he evicted me", "ca-small-claims");
  // "They" is Social Security only when what they cut is Social Security's.
  is("I get SSI, they stopped my Medi-Cal", "ca-noa");
  is("I'm on SSI and they are cutting it because I live with my landlord for free", "ssa-benefits-ending");
  // A cue-less hearing that names another court, from a caller on SSI, isn't asked (H4).
  assert.deepEqual(detectLetter("I'm on SSI and I have a small claims hearing", t).candidates, []);
});

test("an HOA's foreclosure: the deed-of-trust rules answer, with the § 5715 redemption step, pinned word for word", () => {
  const t = "2026-09-30";
  const STEP = /^If your homeowners association is foreclosing without going to court over assessments that came due from 2006 on, you may still be able to redeem the home for 90 days after the sale, and the notice of sale is supposed to mention that right\. Ask legal aid right away\.$/;
  for (const [x, id] of [["my HOA sent a notice of default", "ca-foreclosure-nod"], ["the HOA is auctioning my condo for unpaid assessments", "ca-foreclosure-sale"],
    ["NOTICE OF TRUSTEE'S SALE under a notice of delinquent assessment. The homeowners association will sell at public auction to the highest bidder.", "ca-foreclosure-sale"]]) {
    const r = detectLetter(x, t); assert.equal(r.letter_type, id, x);
    const c = computeDeadline(id, undefined, t);
    assert.ok(c.next_steps.some(s => STEP.test(s)), id);
    assert.ok(c.sources.some(s => s.includes("5715(a)–(b)")), id);
  }
  // The plain deed-of-trust notices still route as before.
  assert.equal(detectLetter("I got a notice of default on my house", t).letter_type, "ca-foreclosure-nod");
  assert.equal(detectLetter("I got a notice of trustee's sale", t).letter_type, "ca-foreclosure-sale");
});

test("after #20: 'UD' in capitals, the ask hears ssa-recon's own cues, and 'they denied me again'", () => {
  const t = "2026-09-30";
  assert.equal(detectLetter("I got a UD", t).letter_type, "ca-ud");
  for (const x of ["I got a UD.", "My landlord served me a UD."]) assert.equal(detectLetter(x, t).letter_type, "ca-ud", x);
  assert.notEqual(detectLetter("¿Puede Ud. ayudarme con una carta?", t).letter_type, "ca-ud");
  // A storage renter's unit isn't a home under a trustee's sale.
  assert.notEqual(detectLetter("they're auctioning off my unit, I owe rent on it", t).letter_type, "ca-foreclosure-sale");
  for (const x of ["social security says I'm not disabled and I have a hearing", "social security rejected my claim twice and I have a hearing"])
    assert.deepEqual(detectLetter(x, t).candidates, ["ssa-recon", "ssa-appeals-council"], x);
  assert.equal(detectLetter("I'm on SSI and they denied me again, the county told me to appeal", t).letter_type, "ssa-recon");
});

test("small claims papers from a debt collector are small claims, not a validation notice", () => {
  const t = "2026-09-30";
  for (const x of ["I got small claims papers from a debt collector", "a debt collector sued me in small claims", "the collection agency is suing me in small claims court"])
    assert.equal(detectLetter(x, t).letter_type, "ca-small-claims", x);
  assert.equal(detectLetter("I got a letter from a debt collector", t).letter_type, "debt-validation");
});

test("a validation notice's hypotheticals and denials about a suit stay validation notices", () => {
  const t = "2026-10-01";
  const V = "This is a communication from a debt collector. Validation notice. You can dispute the debt by October 30, 2026. ";
  for (const x of ["If you do not pay, you may be served with a lawsuit.", "We have not filed a complaint against you.",
    "We have not filed a lawsuit against you.", "If you receive a summons, do not ignore it.",
    "If you have been served with court papers, contact an attorney.", "No summons or complaint has been filed against you.",
    // A lawsuit as a possible consequence is the notice's own wording, not a suit.
    "A lawsuit may be filed if you do not pay.", "A lawsuit could be filed against you.", "Legal action, including a lawsuit, may follow.",
    "A lawsuit might result if this is unpaid.", "If unpaid, a lawsuit may be filed.",
    // The phrase is short, but not so short that "lawsuit … court" leaks back in.
    "If you do not pay within 30 days of this notice we may file a lawsuit against you in the superior court"])
    assert.equal(detectLetter(V + x, t).letter_type, "debt-validation", x);
  // Said, not printed (under 2 on the printed detector): the spoken rules, civil summons first, read the guarded text too.
  const dv = RULES.find(r => r.id === "debt-validation");
  for (const x of ["a collection agency letter says if you receive a summons do not ignore it", "the collection agency says if you get court papers call a lawyer",
    "a collection agency letter, it says we have not filed a lawsuit against you", "collection agency letter: if you have been served with a summons, contact an attorney",
    // The hedged phrase takes its object, so "lawsuit … court" doesn't leak back in.
    "a collections letter says if you do not pay you may be served with a lawsuit in the superior court"]) {
    assert.ok(dv.detect.filter(r => r.test(x)).length < 2, x);
    assert.equal(detectLetter(x, t).letter_type, "debt-validation", x);
  }
});

test("an 'If …' sentence's future consequence is hypothetical too; a past maybe gets asked", () => {
  const t = "2026-10-01";
  const V = "This is a communication from a debt collector. Validation notice. You can dispute the debt by October 30, 2026. ";
  for (const x of ["If you are sued you will be served with a summons and complaint.", "If you are sued by us in court the summons will tell you how to respond."])
    assert.equal(detectLetter(V + x, t).letter_type, "debt-validation", x);
  // "may have been served" / "may have sued me": not a hypothetical, not known either. The line asks.
  const AMONG = ["ca-civil-summons", "debt-validation"];
  for (const x of ["The debt collector says you may have been served already with a lawsuit.", "the debt collector may have sued me already",
    // A bare "lawsuit" from a collector: papers, or still the letter? Asked, not the letter's answer.
    "the lawsuit from the collection agency", "a lawsuit by a debt collector", "the debt collector's lawsuit"]) {
    const r = detectLetter(x, t);
    assert.equal(r.letter_type, null, x);
    assert.deepEqual(r.candidates, AMONG, x);
    assert.match(r.speech, /court papers about a lawsuit, like a summons, or a letter from the debt collector\?$/);
  }
  for (const [said, want] of [["I got a summons", "ca-civil-summons"], ["court papers", "ca-civil-summons"], ["a letter from the debt collector", "debt-validation"],
    ["no, no papers, just the letter", "debt-validation"], ["I don't know", null],
    // A denied court word, or one only in the letter, is the letter; "both" is the summons; a bare "no" is asked again.
    ["I didn't get a summons, just the letter", "debt-validation"], ["no summons", "debt-validation"], ["not a summons", "debt-validation"],
    ["the letter mentions a lawsuit", "debt-validation"], ["I haven't been served, it's just a letter", "debt-validation"],
    ["both", "ca-civil-summons"], ["I got both", "ca-civil-summons"], ["no, it's a summons", "ca-civil-summons"], ["no papers, just a letter", "debt-validation"],
    ["no", null], ["nope", null], ["yes", null],
    // "the letter says they sued me" may mean papers came too: asked again; denied or threatened, it's the letter.
    ["the letter says they sued me", null], ["the letter said there's a lawsuit", null],
    ["the letter says they haven't sued me", "debt-validation"], ["the letter says they will sue me", "debt-validation"]])
    assert.equal(detectLetter(said, t, AMONG).letter_type, want, said);
});

test("a collector's suit said plainly is a civil summons; an SC-100 is small claims", () => {
  const t = "2026-10-01";
  for (const x of ["ABC Collections letter: if you do not pay you may be sued. I was served on Monday with a summons from them",
    "the collection agency sued me, I've never been sued before", "the collection agency is suing me", "the collection agency sued me for my old credit card"])
    assert.equal(detectLetter(x, t).letter_type, "ca-civil-summons", x);
  // A collector's suit over old rent or after a lease is still the collector's; the guard is for an eviction.
  for (const x of ["my landlord's collection agency is suing me for back rent", "the debt collector is suing me, my lease ended last year"])
    assert.equal(detectLetter(x, t).letter_type, "ca-civil-summons", x);
  assert.equal(detectLetter("the collection agency filed a lawsuit against me", t).letter_type, "ca-civil-summons");
  // A threatened or possible lawsuit is still the letter.
  for (const x of ["the debt collector says they might file a lawsuit", "the collection agency threatened a lawsuit", "a collection agency letter about a possible lawsuit"])
    assert.equal(detectLetter(x, t).letter_type, "debt-validation", x);
  // A landlord's suit may be an eviction: not the civil summons answer.
  for (const x of ["I owe a collection agency and my landlord is suing me for back rent", "my landlord is suing me for back rent"])
    assert.notEqual(detectLetter(x, t).letter_type, "ca-civil-summons", x);
  // Papers served with a 3-day notice or a notice to quit: an eviction (10 court days) or a money suit (30)? Asked,
  // even when a rule would have answered.
  for (const x of ["a debt collector served me with papers about a 3 day notice", "a debt collector served me with papers, a notice to quit",
    "the collection agency served me with court papers about a notice to pay rent or quit"]) {
    const r = detectLetter(x, t);
    assert.equal(r.letter_type, null, x);
    assert.deepEqual(r.candidates, ["ca-ud", "ca-civil-summons", "jury-summons"], x);
    assert.equal(r.speech, "Is it about an eviction, a lawsuit about money, or jury duty?");
  }
  // Eviction papers, served: the eviction answer (10 court days), not nothing.
  for (const x of ["my landlord served me with papers for an eviction", "they served me with papers to evict me", "I got a UD and the collection agency is suing me"])
    assert.equal(detectLetter(x, t).letter_type, "ca-ud", x);
  for (const x of ["I got an SC-100 from a debt collector", "SC100 small claims from a debt collector"])
    assert.equal(detectLetter(x, t).letter_type, "ca-small-claims", x);
});

test("a real suit after a notice's hypothetical stays a suit: the guard blanks only the hedged phrase", () => {
  const t = "2026-10-01";
  for (const x of ["if you do not pay you may be served with a lawsuit you got a summons yesterday from the debt collector",
    "If you do not pay you may be served with a lawsuit I got a summons yesterday from a debt collector",
    "the debt collector letter says if you do not pay you may be served with a lawsuit and a summons was delivered to the house yesterday",
    "ABC COLLECTIONS DEBT COLLECTOR IF YOU DO NOT PAY YOU MAY BE SERVED WITH A LAWSUIT A SUMMONS AND COMPLAINT WAS FILED AGAINST YOU ON SEPTEMBER 1",
    // The phrase stops at "and": the collector named after it isn't part of the hypothetical.
    "ABC Collections letter: if you do not pay you may be served with a lawsuit and the debt collector sent a summons yesterday",
    // "before" is about time, not a hedge.
    "Before you were served with this summons, ABC Collections, a debt collector, sent a validation notice."])
    assert.equal(detectLetter(x, t).letter_type, "ca-civil-summons", x);
});

test("a real suit still is one: the hedge guard skips the caller's own words and stops at the clause", () => {
  const t = "2026-10-01";
  for (const x of ["the summons and complaint from the debt collector", "a debt collector served me with court papers",
    "a debt collector sued me and I got a summons", "I got a summons, the debt collector filed a complaint against me",
    "I don't know if the summons from the debt collector is real", "no idea what this summons from the debt collector means",
    "got a summons from a debt collector, never been sued before", "never been sued before, got a summons from a debt collector",
    "not sure what to do about the summons from the debt collector",
    "SUMMONS. You are being sued by a debt collector. If you do not respond to this summons within 30 days, the court may enter a default judgment.",
    // A served-with-papers caller naming a debt collector or a credit card.
    "I was served with papers by a debt collector", "I got served with legal papers over a credit card debt"])
    assert.equal(detectLetter(x, t).letter_type, "ca-civil-summons", x);
  assert.equal(detectLetter("a debt collector sued me in small claims", t).letter_type, "ca-small-claims");
  // A landlord's papers may be an eviction: not the civil summons answer.
  for (const x of ["I was served with papers by my landlord for back rent I owe", "I was served with papers by my landlord, I owe a debt for back rent"])
    assert.notEqual(detectLetter(x, t).letter_type, "ca-civil-summons", x);
});

test("a validation notice's CFPB complaint line and 'served by our office' stay validation notices; a real suit doesn't", () => {
  const t = "2026-10-01";
  const V = "This is a communication from a debt collector. Validation notice. You can dispute the debt by October 30, 2026. ";
  for (const x of [V + "If you have a complaint about how we are collecting this debt, contact the CFPB at consumerfinance.gov.",
    V + "You may also submit a complaint to the Consumer Financial Protection Bureau.",
    V + "This account was served by our office since 2024.",
    "the collection agency says they will sue me if I don't pay"])
    assert.equal(detectLetter(x, t).letter_type, "debt-validation", x);
  // Short and spoken (under 2 on the printed detector): the spoken lookahead decides, and "can't sue me" isn't a suit.
  const said = "a collection agency says they can't sue me";
  assert.ok(RULES.find(r => r.id === "debt-validation").detect.filter(r => r.test(said)).length < 2, "printed score under 2");
  assert.equal(detectLetter(said, t).letter_type, "debt-validation");
  // An actual suit still isn't a validation notice.
  for (const x of ["the summons and complaint from the debt collector", "a debt collector served me with court papers", "a debt collector sued me and I got a summons"])
    assert.equal(detectLetter(x, t).letter_type, "ca-civil-summons", x);
  for (const x of ["I was served with papers by a debt collector", "I got served by a debt collector"])
    assert.notEqual(detectLetter(x, t).letter_type, "debt-validation", x);
});

test("small claims: 'may take me all day' isn't a threat to take me to small claims", () => {
  for (const x of ["I'm being sued in small claims, the hearing may take me all day",
    "my neighbor sued me in small claims and I'm worried it will take me a long time"]) {
    const r = detectLetter(x, "2026-10-01");
    assert.equal(r.letter_type, "ca-small-claims", x);
    assert.equal(r.suggested_notice_date, null, x);   // "all day" and "a long time" aren't dates
  }
  // Threats stay out.
  for (const x of ["they might take me to small claims", "my landlord is threatening to sue me in small claims",
    "my landlord says they'll take me to small claims", "he'll sue me in small claims over the deposit"])
    assert.equal(detectLetter(x, "2026-10-01").letter_type, null, x);
});

test("a validation notice's small-claims boilerplate, a collector's threat, and a time-barred disclosure stay validation notices", () => {
  const t = "2026-09-30";
  for (const x of ["This is a communication from a debt collector. Validation notice. You can dispute the debt by October 30, 2026. This debt may be eligible for small claims.",
    "a debt collector sent me a letter saying they might take me to small claims",
    "This is a communication from a debt collector. Validation notice. You can dispute the debt by October 30, 2026. If you are sued in small claims court, you may have defenses.",
    "This is a communication from a debt collector. Validation notice. The law limits how long you can be sued on a debt. Because of the age of your debt, we will not sue you for it."])
    assert.equal(detectLetter(x, t).letter_type, "debt-validation", x);
  // An actual suit still isn't.
  assert.equal(detectLetter("a debt collector sued me and I got a summons", t).letter_type, "ca-civil-summons");
  // More boilerplate and threats, from the gate: a threat "if I don't pay", "this is not a lawsuit", "we may file a claim in
  // small claims court", and a time-barred disclosure naming the creditor.
  for (const x of ["a debt collector says they'll take me to small claims if I don't pay",
    "This is a communication from a debt collector. Validation notice. You can dispute the debt by October 30, 2026. This is not a lawsuit; no court case has been filed.",
    "This is a communication from a debt collector. Validation notice. You can dispute the debt by October 30, 2026. If you do not pay, we may file a claim in small claims court.",
    "This is a communication from a debt collector. Validation notice. The law limits how long you can be sued on a debt. Because of the age of your debt, XYZ Bank cannot sue you for it."])
    assert.equal(detectLetter(x, t).letter_type, "debt-validation", x);
  // A threat to sue isn't small claims papers.
  for (const x of ["they might take me to small claims", "my landlord is threatening to sue me in small claims"])
    assert.notEqual(detectLetter(x, t).letter_type, "ca-small-claims", x);
});
