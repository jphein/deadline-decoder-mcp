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
  // …but a hearing offered, scheduled or mentioned as the next step is a reconsideration's.
  is("SOCIAL SECURITY ADMINISTRATION Notice of Reconsideration. We still find you are not disabled. If you disagree after the hearing, you may ask the Appeals Council.", "ssa-recon");
  is("Social Security denied me again and the judge said I can have a hearing", "ssa-recon");
  is("Social Security denied me again after the hearing was scheduled", "ssa-recon");
  // Only a past outcome at or after a hearing is a decision; asking about a hearing, or one still to come, isn't.
  for (const x of ["social security denied me again, what do I say at my hearing", "social security denied me again, after the hearing gets scheduled what happens",
    "social security denied me again and my hearing is scheduled", "social security denied me again and the hearing was postponed"]) is(x, "ssa-recon");
  for (const x of ["I lost after the hearing, social security denied my disability", "after my hearing social security said no again",
    "they said no at my hearing for social security"]) is(x, "ssa-appeals-council");
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
