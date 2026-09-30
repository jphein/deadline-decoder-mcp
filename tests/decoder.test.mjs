import test from "node:test";
import assert from "node:assert/strict";
import { listLetterTypes, computeDeadline, detectLetter, findSpokenDates, makeReminder, todayIso, forTheEar, DecoderError } from "../src/decoder.js";

test("lists the letter types: the original five first, in their order, then the newer ones", () => {
  assert.deepEqual(listLetterTypes().slice(0, 5).map(t => t.id), ["ssa-recon", "ssa-initial", "ca-3day", "ca-ud", "ca-noa"]);
  assert.ok(listLetterTypes().length > 5);
});

test("SSA reconsideration: deadline, days left and speakable answer", () => {
  const r = computeDeadline("ssa-recon", "2026-09-13", "2026-09-26");
  assert.equal(r.deadline, "2026-11-17");
  assert.equal(r.days_left, 52);
  assert.equal(r.passed, false);
  assert.match(r.speech, /^Your deadline is Tuesday, November 17, 2026, 52 days from today\./);
  assert.match(r.speech, /not legal advice/);
  assert.ok(r.sources.some(s => s.includes("404.933")));
});

test("3-day notice over Thanksgiving explains the skipped days", () => {
  const r = computeDeadline("ca-3day", "2026-11-25", "2026-11-25");
  assert.equal(r.deadline, "2026-12-02");
  assert.ok(r.how_we_counted.some(m => m.includes("Thanksgiving")));
});

test("counting steps are rewritten for the ear", () => {
  assert.equal(forTheEar("2026-09-25 skipped — Native American Day."), "Friday, September 25 is skipped: it's Native American Day.");
  assert.equal(forTheEar("2026-11-28 skipped — Saturday."), "Saturday, November 28 is skipped: it's a Saturday.");
  const r = computeDeadline("ca-ud", "2026-09-22", "2026-09-26");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(r.speech), "no ISO dates in speech");
});

test("a passed deadline says so and points to help", () => {
  const r = computeDeadline("ca-noa", "2026-01-02", "2026-09-26");
  assert.equal(r.passed, true);
  assert.match(r.speech, /has passed/);
  assert.match(r.speech, /legal aid/);
});

test("bad input is a DecoderError, not a crash", () => {
  assert.throws(() => computeDeadline("nope", "2026-09-13"), DecoderError);
  assert.throws(() => computeDeadline("ssa-recon", "09/13/2026"), DecoderError);
  assert.throws(() => computeDeadline("ssa-recon", "2026-02-30"), DecoderError);
});

test("detect_letter recognizes a letter and its date", () => {
  const r = detectLetter("SOCIAL SECURITY ADMINISTRATION Notice of Reconsideration. Date: September 13, 2026. If you disagree, you may request a hearing before an administrative law judge.");
  assert.equal(r.letter_type, "ssa-recon");
  assert.equal(r.suggested_notice_date, "2026-09-13");
});

test("detect_letter understands how people say it out loud", () => {
  const t = "2026-09-26";
  const a = detectLetter("I got a letter from Social Security dated September 13th, they denied my disability again", t);
  assert.equal(a.letter_type, "ssa-recon");
  assert.equal(a.suggested_notice_date, "2026-09-13");
  const b = detectLetter("my landlord taped a three day notice on my door yesterday", t);
  assert.equal(b.letter_type, "ca-3day");
  assert.equal(b.suggested_notice_date, "2026-09-25");
  const c = detectLetter("I was handed eviction papers on the 1st of September", t);
  assert.equal(c.letter_type, "ca-ud");
  assert.equal(c.suggested_notice_date, "2026-09-01");
  const e = detectLetter("the county says my CalFresh is stopping, the notice is from December 20th", t);
  assert.equal(e.letter_type, "ca-noa");
  assert.equal(e.suggested_notice_date, "2025-12-20"); // no year spoken: the most recent past Dec 20
});

test("a printed initial denial is not mistaken for a second denial", () => {
  const r = detectLetter("SOCIAL SECURITY ADMINISTRATION. Notice of Disapproved Claim. We have determined that you are not disabled. If you disagree, you may ask for reconsideration within 60 days. Date: August 3, 2026");
  assert.equal(r.letter_type, "ssa-initial");
});

test("detect_letter admits when it does not know", () => {
  const r = detectLetter("I got a letter and I'm scared, it says something about a deadline");
  assert.equal(r.recognized, false);
  assert.match(r.speech, /couldn't tell/);
});

test("reminder is a valid all-day iCalendar event with a one-week alarm", () => {
  const r = makeReminder("ca-ud", "2026-10-01", "2026-10-01");
  assert.equal(r.deadline, "2026-10-15");
  assert.match(r.ics, /DTSTART;VALUE=DATE:20261015/);
  assert.match(r.ics, /DTEND;VALUE=DATE:20261016/);
  assert.match(r.ics, /TRIGGER:-P7D/);
  assert.ok(r.ics.includes("\r\n"));
});

test("no reminder for a deadline that has passed", () => {
  assert.throws(() => makeReminder("ca-noa", "2026-01-02", "2026-09-26"), DecoderError);
});

test("today is computed in California time", () => {
  // 2026-09-27 05:30 UTC is still 2026-09-26 in Los Angeles
  assert.equal(todayIso("America/Los_Angeles", new Date("2026-09-27T05:30:00Z")), "2026-09-26");
});

test("a date said as an event ahead resolves forward, and is never the letter's date", () => {
  const t = "2026-09-30";
  const at = (text) => findSpokenDates(text, t).map(x => x.iso);
  // Letters arrive after their date: a bare date is the most recent such day.
  assert.deepEqual(at("the letter is dated October 1st"), ["2025-10-01"]);
  assert.deepEqual(at("it came on the 29th of September"), ["2026-09-29"]);
  // An event ahead: the nearest such day on or after today (into next year when needed).
  assert.deepEqual(at("I have to report October 1st"), ["2026-10-01"]);
  assert.deepEqual(at("the hearing is on the 5th of October"), ["2026-10-05"]);
  assert.deepEqual(at("my rent goes up January 1st"), ["2027-01-01"]);
  assert.deepEqual(at("tomorrow"), ["2026-10-01"]);
  // The nearer cue wins: "dated" is nearer the date than "hearing".
  assert.deepEqual(at("my hearing notice dated September 3rd"), ["2026-09-03"]);

  const jury = detectLetter("I got a jury summons to report October 1st", t);
  assert.equal(jury.letter_type, "jury-summons");
  assert.equal(jury.suggested_notice_date, null);
  assert.deepEqual(jury.dates_found, ["2026-10-01"]);
  const rent = detectLetter("I got a rent increase notice yesterday and my rent goes up November 1st", t);
  assert.equal(rent.letter_type, "ca-rent-increase");
  assert.equal(rent.suggested_notice_date, "2026-09-29");
  assert.equal(detectLetter("my rent goes up November 1st", t).suggested_notice_date, null);
  // A printed date after today can't be the letter's date either.
  assert.equal(detectLetter("Notice of Reconsideration dated December 1, 2026", t).suggested_notice_date, null);
});

test("the help sentence reads as a sentence for every kind of letter", () => {
  for (const { id, needs_date } of listLetterTypes()) {
    const r = computeDeadline(id, needs_date ? "2026-09-15" : undefined, "2026-09-16");
    assert.match(r.help_spoken, /^For [a-z ]+(:|,) [^A-Z]*[A-Z0-9a-z]/, id);
    assert.doesNotMatch(r.help_spoken, /, (Your|The|A) /, id);
    assert.doesNotMatch(r.help_spoken, / — /, id);
    assert.ok(r.speech.includes(r.free_help[0].say ?? `For free help: ${r.free_help[0].name}`), id);
  }
  assert.equal(computeDeadline("jury-summons", undefined, "2026-09-16").help_spoken,
    "For questions, call your court's jury office: the phone number and website are printed on your summons.");
});

test("date cues: 'last day' and 'shutting' look ahead, 'was due' looks back, and an undated rule takes no date", () => {
  const t = "2026-09-30";
  const at = (text) => findSpokenDates(text, t).map(x => x.iso);
  assert.deepEqual(at("the last day to respond is October 5th"), ["2026-10-05"]);
  assert.deepEqual(at("they are shutting it off October 5th"), ["2026-10-05"]);
  assert.deepEqual(at("it was due August 1st"), ["2026-08-01"]);
  assert.deepEqual(at("I got it last Tuesday, September 29th"), ["2026-09-29"]);
  assert.equal(detectLetter("the last day to respond is October 5th", t).suggested_notice_date, null);
  // A bill's due date is behind for a rule counted from it: only the rule knows, so the option says so.
  assert.deepEqual(at("due date August 1st"), ["2027-08-01"]);
  assert.deepEqual(findSpokenDates("due date August 1st", t, { pastDue: true }).map(x => x.iso), ["2026-08-01"]);
  // An undated rule (a jury summons) offers no notice date, even one said as the letter's date.
  const jury = detectLetter("I got a jury summons dated September 3rd", t);
  assert.equal(jury.suggested_notice_date, null);
  assert.deepEqual(jury.dates_found, ["2026-09-03"]);
});
