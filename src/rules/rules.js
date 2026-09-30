// SPDX-License-Identifier: AGPL-3.0-or-later
// rules.js — one entry per kind of letter. Every rule cites its source, and every result shows its
// arithmetic. The first five rules count with hand-written compute() functions; newer ones are written as data
// with spec() and counted by count(): an anchor date, an optional mailing presumption, N calendar or court days,
// then a roll-forward rule for a last day on a weekend or holiday. A HEDGE rule says "usually" and sends people
// to the date printed on their notice. When a statute's roll-forward rule isn't certain, a rule doesn't roll:
// an answer that is early is safe, and one that is late isn't.
import { d, addDays, addCourtDays, addDaysRolling, isFederalWorkday, isCourtDay, isDcBusinessDay, whyNotWorkday, fmt, fmtDay, iso, CA_VERIFIED_YEARS } from "./dates.js";

const LSNC = { name: "Legal Services of Northern California", how: "free civil legal aid — lsnc.net or call your local office" };
const LAWHELP = { name: "LawHelpCA.org", how: "find free legal aid anywhere in California by county" };
const SELFHELP = { name: "California Courts Self-Help Guide", how: "selfhelp.courts.ca.gov — forms and step-by-step help" };
const TWO11 = { name: "211", how: "dial 2-1-1 from any phone, 24/7, English and Spanish" };
const JURY = { name: "Your court's jury office", how: "the phone number and website are printed on your summons" };
const EDD = { name: "EDD", how: "1-800-300-5616 in English, 1-800-326-8937 in Spanish" };
const SSA = { name: "Social Security", how: "1-800-772-1213 (TTY 1-800-325-0778)" };
const STATE_HEARINGS = { name: "CDSS State Hearings", how: "(800) 743-8525 (voice and TDD)" };
const PARKING_AGENCY = { name: "The agency that gave the ticket", how: "its phone number and website are on the ticket or notice" };
const PAYPLAN = "If you get public benefits or have a low income, ask the agency about a payment plan. People who qualify must be offered one before an unpaid ticket is sent to the DMV.";

function yearNote(date) {
  return CA_VERIFIED_YEARS.includes(date.getUTCFullYear()) ? "" :
    " Court holidays for this year are computed from the statute, not checked against the court calendar — confirm with the court.";
}

// ---- rules as data ----------------------------------------------------------------------------------------------
// How a last day that isn't a working day moves forward. "none": it doesn't (the statute counts calendar days and
// says nothing more, or its rule isn't certain). court: Code Civ. Proc. §§ 12a, 135. federal: 20 CFR 404.3(b).
// dc: 26 U.S.C. §§ 6213(a), 7503 (Saturday, Sunday, or a legal holiday in the District of Columbia).
export const ROLL = {
  none: { ok: () => true, next: "" },
  court: { ok: isCourtDay, next: "court day" },
  federal: { ok: isFederalWorkday, next: "workday" },
  dc: { ok: isDcBusinessDay, next: "business day" },
};
// The date each kind of rule counts from, as the first counting step says it.
export const ANCHORS = { notice: "Notice dated", served: "Served", issued: "Issued", mailed: "Mailed" };
const WORDS = ["zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** Count a rule's days from its anchor date. Returns the last day, the uncorrected last day, and what moved it. */
export function count(anchor, { days, unit = "calendar", mail = 0, roll = "none" }) {
  if (!ROLL[roll]) throw new Error(`unknown roll rule: ${roll}`);
  const start = addDays(anchor, mail);
  if (unit === "court") { const { date, skipped } = addCourtDays(start, days); return { start, raw: date, date, skipped, rolled: [] }; }
  if (unit !== "calendar") throw new Error(`unknown unit: ${unit}`);
  const { date, rolled } = addDaysRolling(start, days, ROLL[roll].ok);
  return { start, raw: addDays(start, days), date, skipped: [], rolled };
}

function rollLine(rolled, date, next) {
  const what = (w) => (/^(Saturday|Sunday)$/.test(w) ? `a ${w}` : w);
  const also = rolled.slice(1).filter(r => !/^(Saturday|Sunday)$/.test(r.why)).map(r => `${fmtDay(d(r.date))} is ${r.why}`);
  return `That's ${what(rolled[0].why)}${also.length ? `, and ${also.join(", and ")}` : ""}, so the deadline moves to the next ${next}: ${fmt(date)}.`;
}

/** The counting steps, written to be read or heard (no ISO dates). */
export function countSteps(s, anchor, c) {
  const { days, unit = "calendar", mail = 0, roll = "none" } = s.count;
  const lines = [`${ANCHORS[s.anchor]} ${fmt(anchor)}.${s.anchor === "served" ? " The day you are served does not count." : ""}`];
  if (mail) lines.push(`${s.mailWho ?? "The law"} assumes you got it ${mail} days later: ${fmt(c.start)}.`);
  if (unit === "court") {
    lines.push("Saturdays, Sundays and court holidays do not count.");
    lines.push(...c.skipped.filter(x => !/Saturday|Sunday/.test(x.why)).map(x => `${x.date} skipped — ${x.why}.`));
    lines.push(`${WORDS[days] ?? days} court days end ${fmt(c.date)}.` + yearNote(c.date));
  } else {
    const from = mail ? "then" : s.anchor === "served" ? "the day you were served" : "that date";
    lines.push(`${s.confidence === "HEDGE" ? "Usually the deadline is " : ""}${days} days from ${from}: ${fmt(c.raw)}.`);
    if (c.rolled.length) lines.push(rollLine(c.rolled, c.date, ROLL[roll].next) + (roll === "court" ? yearNote(c.date) : ""));
    // A rule that doesn't roll says so when its day isn't a working day, instead of passing it off as final.
    if (roll === "none" && !isCourtDay(c.raw)) lines.push(`That's ${/^(Saturday|Sunday)$/.test(whyNotWorkday(c.raw)) ? `a ${whyNotWorkday(c.raw)}` : whyNotWorkday(c.raw)}. Don't count on extra time: act before then.`);
  }
  if (s.note) lines.push(s.note);
  return lines;
}

/** A second, earlier date some letters carry, such as the last day to keep Social Security from recovering while it
 *  decides. `label` says it, with {date} where the date goes; counted in calendar days from the anchor and never
 *  rolled (early is safe). An item without `days` is a sentence with no date of its own. */
function alsoDates(list = [], anchor) {
  return list.map(a => ({ label: a.label, confidence: a.confidence ?? "SOLID", deadline: a.days === undefined ? null : addDays(anchor, (a.mail ?? 0) + a.days) }));
}

/** A rule written as data. Needs: id, family, title, plain, anchor (a key of ANCHORS, or null when the notice
 *  prints its own date and there is nothing to count), count, headline, steps, help, sources, detect, spoken,
 *  answers, keyterms. Optional: confidence ("SOLID", or "HEDGE" plus a `hedge` sentence), dateLabel,
 *  dateQuestion, mailWho, not (printed cues that rule it out), also (see alsoDates). */
export function spec(s) {
  return {
    confidence: "SOLID", ...s,
    compute(anchor) {
      const base = { headline: s.headline, steps: s.steps, help: s.help, sources: s.sources, hedge: s.hedge };
      if (!s.count) return { ...base, deadline: null, math: [], also: [] };
      const c = count(anchor, s.count);
      return { ...base, deadline: c.date, math: countSteps(s, anchor, c), also: alsoDates(s.also, anchor) };
    },
  };
}

export const RULES = [
  {
    id: "ssa-recon",
    family: "ssa", confidence: "SOLID", anchor: "notice",
    spoken: /\b(social security|ssi|ssdi|disability)\b.*\b(again|second time|twice)\b|\b(again|second time|twice)\b.*\b(social security|ssi|ssdi|disability)\b/i,
    answers: /\b(again|second|twice|reconsider\w*|hearing)\b/i,
    keyterms: ["Social Security", "reconsideration", "administrative law judge", "SSI", "disability"],
    title: "Social Security: my claim was denied (again)",
    plain: "A Social Security notice of reconsideration — the second \"no\".",
    detect: [/reconsideration/i, /social security/i, /(hearing|administrative law judge)/i],
    dateLabel: "Date printed on the notice",
    compute(notice) {
      const received = addDays(notice, 5);
      const { date, rolled } = addDaysRolling(received, 60, isFederalWorkday);
      return {
        deadline: date,
        headline: "Ask for a hearing before a judge",
        math: [
          `Notice dated ${fmt(notice)}.`,
          `Social Security assumes you got it 5 days later: ${fmt(received)}.`,
          `You have 60 days from then: ${fmt(addDays(received, 60))}.`,
          ...rolled.map(r => `${r.date} is a ${r.why}, so the deadline moves to the next workday.`),
        ],
        steps: [
          "File form HA-501, Request for Hearing by Administrative Law Judge. It is free.",
          "You can file online at ssa.gov (Appeal a Decision), by mail, by fax, or in person at any Social Security office.",
          "Keep proof: a fax confirmation, a certified-mail receipt, or the online confirmation number.",
          "You can withdraw a hearing request later. Missing the deadline usually cannot be undone.",
          "If you missed it, you can still ask for more time in writing and explain why (\"good cause\").",
        ],
        help: [LSNC, LAWHELP, TWO11, { name: "Social Security", how: "1-800-772-1213 (TTY 1-800-325-0778)" }],
        sources: ["20 CFR 404.933 and 416.1433 (60 days after you receive the notice)",
                  "20 CFR 404.901 and 416.1401 (notice presumed received 5 days after its date)",
                  "20 CFR 404.3(b) and 416.120(d) (a deadline on a weekend or federal holiday moves to the next workday)"],
      };
    },
  },
  {
    id: "ssa-initial",
    family: "ssa", confidence: "SOLID", anchor: "notice",
    spoken: /\b(social security|ssi|ssdi)\b.*\b(denied|turned (me )?down|rejected|said no)\b|\b(denied|turned down|rejected)\b.*\b(social security|ssi|ssdi|disability)\b/i,
    answers: /\b(first|denied|application|turned down)\b/i,
    keyterms: ["Social Security", "SSI", "SSDI", "disability"],
    title: "Social Security: my application was denied",
    plain: "The first \"no\" on a disability, SSI or other Social Security claim.",
    detect: [/social security/i, /(not disabled|denied|we have determined)/i, /reconsideration/i],
    dateLabel: "Date printed on the notice",
    compute(notice) {
      const received = addDays(notice, 5);
      const { date, rolled } = addDaysRolling(received, 60, isFederalWorkday);
      return {
        deadline: date,
        headline: "Ask Social Security to reconsider",
        math: [`Notice dated ${fmt(notice)}.`, `Presumed received 5 days later: ${fmt(received)}.`,
               `60 days from then: ${fmt(addDays(received, 60))}.`,
               ...rolled.map(r => `${r.date} is a ${r.why}, so the deadline moves to the next workday.`)],
        steps: ["File form SSA-561, Request for Reconsideration (with SSA-3441 for disability claims). It is free.",
                "File online at ssa.gov (Appeal a Decision), by mail, or at any Social Security office.",
                "Keep proof of when you filed."],
        help: [LSNC, LAWHELP, TWO11, { name: "Social Security", how: "1-800-772-1213" }],
        sources: ["20 CFR 404.909 and 416.1409 (60 days after receipt)", "20 CFR 404.901 and 416.1401 (5-day presumption)",
                  "20 CFR 404.3(b) and 416.120(d) (weekend and holiday rule)"],
      };
    },
  },
  {
    id: "ca-3day",
    family: "housing", confidence: "SOLID", anchor: "served",
    spoken: /\b(3|three)[- ]day notice\b|\bnotice to pay (rent )?or quit\b/i,
    answers: /\b(3|three)[- ]day|pay (rent )?or quit\b/i,
    keyterms: ["three day notice", "pay rent or quit", "landlord"],
    title: "California: a 3-day notice to pay rent or move out",
    plain: "A notice from a landlord giving you three days to pay rent or leave.",
    detect: [/(three|3)[- ]day/i, /(pay rent|quit|notice to pay)/i],
    dateLabel: "Date the notice was handed to you (or posted and mailed)",
    compute(served) {
      const { date, skipped } = addCourtDays(served, 3);
      return {
        deadline: date,
        headline: "Pay, or get help, before the notice runs out",
        math: [`Served ${fmt(served)}. The day you are served does not count.`,
               "Saturdays, Sundays and court holidays do not count either.",
               ...skipped.map(s => `${s.date} skipped — ${s.why}.`),
               `Three court days end ${fmt(date)}.` + yearNote(date)],
        steps: ["A 3-day notice is not an eviction order. Only a court can evict you, and you will get court papers first.",
                "If you can pay the full amount demanded, pay it within the three court days and keep a receipt.",
                "Check the notice: it must state the amount, who to pay, and how. Mistakes can make it invalid.",
                "Call free legal aid now. Rental assistance or a payment plan may be possible.",
                "If you later get court papers (a Summons and Complaint), you have 10 court days to respond — use this tool again."],
        help: [LSNC, LAWHELP, SELFHELP, TWO11],
        sources: ["Code of Civil Procedure § 1161(2), as amended by AB 2343 (2018), effective Sept. 1, 2019 (excludes weekends and judicial holidays)",
                  "Code of Civil Procedure § 12 (the first day is excluded)", "Code of Civil Procedure § 135 and Gov. Code § 6700 (judicial holidays)"],
      };
    },
  },
  {
    id: "ca-ud",
    family: "housing", confidence: "SOLID", anchor: "served",
    spoken: /\beviction papers\b|unlawful detainer|\bsu(ed|ing) (me )?to evict|\b(summons|court papers)\b.*\b(evict\w*|landlord|rent|tenant)\b|\b(evict\w*|landlord|rent)\b.*\b(summons|court papers)\b/i,
    answers: /\b(evict\w*|landlord|rent|tenant|apartment|housing|move out)\b/i,
    keyterms: ["unlawful detainer", "eviction", "summons"],
    title: "California: court papers for an eviction (Summons, unlawful detainer)",
    plain: "A Summons and Complaint — the landlord has filed an eviction case.",
    detect: [/unlawful detainer/i, /summons/i],
    dateLabel: "Date you were personally handed the papers",
    compute(served) {
      const { date, skipped } = addCourtDays(served, 10);
      return {
        deadline: date,
        headline: "File a response with the court",
        math: [`Served in person ${fmt(served)}. The day of service does not count.`,
               "Weekends and court holidays do not count.",
               ...skipped.filter(s => !/Saturday|Sunday/.test(s.why)).map(s => `${s.date} skipped — ${s.why}.`),
               `Ten court days end ${fmt(date)}.` + yearNote(date)],
        steps: ["File an Answer (form UD-105) or another response with the court by the deadline. If you do nothing, the landlord can win by default.",
                "Court fees can be waived if you qualify (form FW-001).",
                "If the papers were left with someone else or posted, you usually get extra days — ask legal aid; this tool assumes personal service.",
                "Call free legal aid today. Many tenants have defenses they do not know about."],
        help: [LSNC, SELFHELP, LAWHELP, TWO11],
        sources: ["Code of Civil Procedure § 1167, as amended by AB 2347 (2024), effective Jan. 1, 2025 (10 court days)",
                  "Code of Civil Procedure §§ 12, 135 (counting and holidays)"],
      };
    },
  },
  {
    id: "ca-noa",
    family: "benefits", confidence: "SOLID", anchor: "notice",
    spoken: /notice of action|\b(medi-?cal|calfresh|cal fresh|food stamps|ebt|cash aid|calworks)\b/i,
    answers: /\b(medi-?cal|calfresh|food stamps|calworks|cash aid|county|benefits)\b/i,
    keyterms: ["Medi-Cal", "CalFresh", "CalWORKs", "Notice of Action"],
    title: "Medi-Cal, CalFresh or CalWORKs: a Notice of Action",
    plain: "A county notice that your Medi-Cal, CalFresh (food stamps) or CalWORKs (cash aid) is being denied, cut, or stopped.",
    detect: [/notice of action/i, /(medi-cal|calfresh|cash aid|calworks)/i],
    dateLabel: "Date printed on the notice",
    compute(notice) {
      const deadline = addDays(notice, 90);
      return {
        deadline,
        headline: "Ask for a state hearing",
        math: [`Notice dated ${fmt(notice)}.`, `You have 90 days from the date of the notice: ${fmt(deadline)}.`,
               "With good cause, a late request can be accepted up to 180 days after the notice."],
        steps: ["Ask for a state hearing: call (800) 743-8525, go online, or fill in the back of the notice and mail it.",
                "To keep your benefits while you wait, ask BEFORE the date the change takes effect (it is on the notice). This is called \"aid paid pending\".",
                "Write down the date and time you asked and who you talked to.",
                "You can bring someone to help you, including free legal aid.",
                "If the notice is from your Medi-Cal health plan rather than the county, you usually appeal to the plan first, within 60 days of the date on it."],
        help: [LSNC, { name: "CDSS State Hearings", how: "(800) 743-8525 (voice and TDD)" }, LAWHELP, TWO11],
        sources: ["Welfare and Institutions Code § 10951 (90 days; good cause up to 180)", "LSNC Guide to CalFresh Benefits — Requesting a fair hearing",
                  "42 CFR 431.211 and 431.230(a) (Medi-Cal: notice at least 10 days before the action; services continue if a hearing is asked for before it)",
                  "7 CFR 273.13(a)(1) and 273.15(k)(1) (CalFresh: at least 10 days' notice, with exceptions; benefits continue on a timely hearing request, but not past the end of the certification period)"],
        // No date of its own: the cutoff is the effective date printed on the notice, usually at least 10 days after
        // it but sometimes less, and the request has to come before it, so no computed day is safe to promise.
        also: [{ label: "You may be able to keep your benefits while you wait for the hearing, if you ask before the change takes effect. That date is printed on the notice, usually at least 10 days after it, so ask right away.",
                 confidence: "HEDGE", deadline: null }],
      };
    },
  },
  // ---- court ------------------------------------------------------------------------------------------------
  spec({
    id: "ca-civil-summons",
    family: "court",
    title: "California: court papers for a lawsuit (a Summons that isn't about an eviction)",
    plain: "A Summons and Complaint in a civil case, such as a debt collector or a credit card company suing you.",
    anchor: "served",
    dateLabel: "Date you were personally handed the papers",
    dateQuestion: "What day were the papers handed to you? You can say something like September 13th.",
    count: { days: 30, unit: "calendar", roll: "court" },
    must: /\bsummons\b|citaci[oó]n judicial/i,
    detect: [/\bsummons\b|citaci[oó]n judicial/i, /\b(complaint|plaintiff|demandante)\b/i, /\b(30|thirty) (calendar )?days\b/i],
    not: /unlawful detainer|eviction|desalojo/i,
    spoken: /\b(su(ed|ing) me|being sued|lawsuit|debt collector|collection agency|credit card company)\b.*\b(summons|papers|court)\b|\b(summons|court papers)\b.*\b(debt|money|owe|credit card|collection|lawsuit|sued|suing)\b/i,
    answers: /\b(money|debt|owe|lawsuit|sued|suing|collect\w*|credit card|loan|bill)\b/i,
    keyterms: ["summons", "complaint", "lawsuit", "debt collector"],
    headline: "File a written response with the court",
    steps: [
      "File a written response, usually an Answer, with the court within 30 days of being served. If you don't, the other side can win by default and may be able to take money from your wages or bank account.",
      "Court fees can be waived if you qualify (form FW-001).",
      "If the papers were left with someone else or mailed to you, service takes longer to complete, so you usually get extra days. This count assumes they were handed to you.",
      "Your court's self-help center can help you fill in the Answer for free, and so can legal aid.",
    ],
    help: [SELFHELP, LSNC, LAWHELP, TWO11],
    sources: ["Code of Civil Procedure § 412.20(a)(3) (a written response within 30 days after service)",
              "Code of Civil Procedure § 12 (the day of service does not count)",
              "Code of Civil Procedure §§ 12a and 135 (a last day on a weekend or court holiday moves to the next court day)"],
  }),
  spec({
    id: "jury-summons",
    family: "court",
    title: "A jury summons",
    plain: "A court's summons to serve on a jury.",
    confidence: "HEDGE",
    anchor: null,
    count: null,
    hedge: "A jury summons prints its own date to respond or to report, and that's the date that counts.",
    must: /\bjur(y|or|ors)\b/i,
    detect: [/\bjur(y|or|ors)\b/i, /\bsummons\b/i, /\b(report|respond|juror number|jury service)\b/i],
    spoken: /\bjur(y|or)\b/i,
    answers: /\bjur(y|or)\b/i,
    keyterms: ["jury summons", "jury duty", "juror"],
    headline: "Respond to the court by the date on the summons",
    steps: [
      "Respond by the date on the summons, online or by phone, with the juror number printed on it.",
      "If the date doesn't work, you can usually postpone once. If serving would be a real hardship, ask to be excused and say why.",
      "Don't ignore it: the court can fine a juror who doesn't respond.",
    ],
    help: [JURY, SELFHELP, TWO11],
    sources: ["Code of Civil Procedure § 209 (a summoned juror who fails to respond can be fined)",
              "California Rules of Court, rule 2.1004 (a one-time postponement) and rule 2.1008 (excuse for undue hardship, in writing)"],
  }),
  // ---- traffic: parking tickets (Vehicle Code § 40215) -------------------------------------------------------
  spec({
    id: "ca-parking-ticket",
    family: "traffic",
    title: "California: a parking ticket (notice of parking violation)",
    plain: "A parking ticket left on your car, or mailed to you, by a city, county or other agency.",
    anchor: "issued",
    dateLabel: "Date the ticket was issued (printed on it)",
    dateQuestion: "What date is on the ticket? You can say something like September 13th.",
    count: { days: 21, unit: "calendar", roll: "none" },
    must: /\bpark(ing|ed)?\b/i,
    not: /delinquen|results? of (the |your )?(initial )?review|administrative hearing/i,
    detect: [/notice of parking violation|parking (citation|ticket)/i, /\b(violation|citation|penalty)\b/i, /\b(contest|initial review|pay by|due date)\b/i],
    spoken: /\bparking (ticket|citation|violation)\b|\bticket\b.*\b(parked|parking)\b|\b(parked|parking)\b.*\bticket\b/i,
    answers: /\bpark(ing|ed)?\b/i,
    keyterms: ["parking ticket", "parking citation", "initial review"],
    headline: "Ask the agency for a free review, or pay",
    steps: [
      "To fight the ticket, ask the agency that gave it for an initial review within 21 days of the date it was issued. The review is free, and you can ask by phone, in writing or in person.",
      "If you'll pay it, pay by the date on the ticket, so late penalties aren't added.",
      PAYPLAN,
    ],
    help: [PARKING_AGENCY, LAWHELP, TWO11],
    sources: ["Vehicle Code § 40215(a) (21 calendar days from the issuance of the notice to request an initial review)",
              "Vehicle Code § 40220(a) (before an agency files an unpaid ticket with the DMV, it must offer a person who is indigent, as defined there, a payment plan; for $500 or less in penalties and fees, no more than $25 a month)"],
  }),
  spec({
    id: "ca-parking-delinquent",
    family: "traffic",
    title: "California: a late notice for a parking ticket (notice of delinquent parking violation)",
    plain: "A mailed notice that a parking ticket is unpaid and penalties are being added.",
    anchor: "mailed",
    dateLabel: "Date the notice was mailed (printed on it)",
    dateQuestion: "What date is printed on the notice? You can say something like September 13th.",
    count: { days: 14, unit: "calendar", roll: "none" },
    must: /\bpark(ing|ed)?\b/i,
    detect: [/delinquent parking violation|notice of delinquen/i, /\bpark(ing)?\b/i, /\b(penalt(y|ies)|unpaid|late fee)\b/i],
    spoken: /^(?=.*\b(late|delinquent|overdue|unpaid|past due)\b)(?=.*\bpark(ing|ed)\b)/is,   // any order
    answers: /\b(late|delinquent|overdue|unpaid|past due)\b/i,
    keyterms: ["delinquent parking violation"],
    headline: "Ask for a free review, or pay",
    steps: [
      "You can still ask the agency for an initial review within 14 days of the date this notice was mailed. It's free: by phone, in writing or in person.",
      "Or pay it now, before more penalties are added.",
      PAYPLAN,
    ],
    help: [PARKING_AGENCY, LAWHELP, TWO11],
    sources: ["Vehicle Code § 40215(a) (14 calendar days from the mailing of a notice of delinquent parking violation)",
              "Vehicle Code § 40220(a) (before an agency files an unpaid ticket with the DMV, it must offer a person who is indigent a payment plan)"],
  }),
  spec({
    id: "ca-parking-review",
    family: "traffic",
    title: "California: the result of a parking ticket review (you can ask for a hearing)",
    plain: "A letter with the result of the initial review you asked for, if you still disagree.",
    anchor: "mailed",
    dateLabel: "Date the review result was mailed (printed on it)",
    count: { days: 21, unit: "calendar", roll: "none" },
    must: /\bpark(ing|ed)?\b/i,
    detect: [/\binitial review\b|\breview (result|decision)/i, /\badministrative hearing\b/i, /\bpark(ing)?\b/i],
    spoken: /^(?=.*\b(review|appeal)\b)(?=.*\b(denied|result|decision|lost|upheld|turned down)\b)(?=.*\bpark(ing|ed)\b)/is,   // any order
    answers: /\b(review|hearing|denied|result|decision)\b/i,
    keyterms: ["administrative hearing"],
    headline: "Ask for an administrative hearing",
    steps: [
      "Ask the agency for an administrative hearing within 21 days of the date the review result was mailed.",
      "You'll usually have to pay the ticket amount first, as a deposit. If you have a low income or get public benefits and can show you can't pay, the agency has to let you ask for the hearing without paying.",
      PAYPLAN,
    ],
    help: [PARKING_AGENCY, LAWHELP, TWO11],
    sources: ["Vehicle Code § 40215(b) (21 calendar days after the review result is mailed; the penalty is deposited first, but the agency must let a person who is indigent, as defined in § 40220, ask for a hearing without paying, on proof of inability to pay)"],
  }),
  // ---- Social Security: an overpayment --------------------------------------------------------------------------
  spec({
    id: "ssa-overpayment",
    family: "ssa",
    title: "Social Security: an overpayment notice (they say they paid you too much)",
    plain: "A notice that Social Security or SSI says it paid you too much and wants the money back.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 60, unit: "calendar", mail: 5, roll: "federal" },
    mailWho: "Social Security",
    must: /overpa(id|yment)/i,
    detect: [/overpa(id|yment)/i, /social security|supplemental security income|\bSSI\b/i, /\b(waiver|reconsideration|repay|pay (us )?back)\b/i],
    spoken: /^(?=.*\b(overpaid|overpayment|paid (me )?too much|pay (it |them |that |the money )?back)\b)(?=.*\b(social security|ssi|ssdi|ssa)\b)/is,
    answers: /\b(overpaid|overpayment|too much|pay (it )?back)\b/i,
    keyterms: ["overpayment", "waiver", "Supplemental Security Income"],
    headline: "Appeal it if it's wrong, or ask for a waiver",
    also: [{ label: "For Social Security benefits (not SSI), ask by {date}, 30 days after the date on the notice, and they won't start taking money back while they decide.", days: 30 }],
    steps: [
      "If you weren't overpaid, or the amount is wrong, ask for reconsideration (form SSA-561). If it wasn't your fault and paying it back would be too hard, ask for a waiver (form SSA-632). You can ask for both.",
      "If you get SSI and the notice lowers or stops your payments, appeal within 10 days of getting it, and your payments stay the same while Social Security decides.",
      "Keep proof of when you asked.",
    ],
    help: [LSNC, LAWHELP, TWO11, SSA],
    sources: ["20 CFR 404.909 and 416.1409 (reconsideration within 60 days after you receive the notice)",
              "20 CFR 404.901 and 416.1401 (notice presumed received 5 days after its date)",
              "20 CFR 404.3(b) and 416.120(d) (a last day on a weekend or federal holiday moves to the next workday)",
              "20 CFR 404.502a and 404.506(c) (Social Security benefits: recovery doesn't start on a waiver or reconsideration request within 30 days)",
              "20 CFR 416.1336(b) (SSI: payments continue on an appeal within 10 days after receipt)"],
  }),
  // ---- unemployment -----------------------------------------------------------------------------------------------
  spec({
    id: "ca-edd-determination",
    family: "unemployment",
    title: "EDD: a Notice of Determination or Notice of Overpayment about unemployment benefits",
    plain: "A letter from California's Employment Development Department denying or cutting unemployment benefits, or saying you were overpaid.",
    anchor: "mailed",
    dateLabel: "Mailing date printed on the notice",
    dateQuestion: "What's the mailing date on the notice? You can say something like September 13th.",
    count: { days: 30, unit: "calendar", roll: "none" },
    must: /\bEDD\b|employment development department|unemployment insurance/i,
    detect: [/\bEDD\b|employment development department/i, /notice of (determination|overpayment)|disqualif|ineligible|not eligible/i, /\b(appeal|unemployment insurance|DE 1000M)\b/i],
    spoken: /^(?=.*\b(edd|unemployment)\b)(?=.*\b(denied|disqualif\w*|not eligible|ineligible|stopped|cut off|turned (me )?down|determination|overpaid|overpayment|pay (it )?back)\b)/is,
    answers: /\b(edd|unemployment|jobless)\b/i,
    keyterms: ["EDD", "Employment Development Department", "unemployment", "Notice of Determination", "Notice of Overpayment"],
    note: "EDD counts the 30 days from the mailing date on the notice.",
    headline: "Appeal to the Unemployment Insurance Appeals Board",
    steps: [
      "Appeal within 30 days of the mailing date on the notice. Use the appeal form that came with it (DE 1000M), or a letter saying you disagree and why, and mail it to the address at the top of the notice.",
      "If you're late, appeal anyway and say why: the 30 days can be extended for good cause.",
    ],
    help: [EDD, LAWHELP, TWO11],
    sources: ["Unemployment Insurance Code § 1328 (a determination: 30 days from service of the notice; extended for good cause)",
              "Unemployment Insurance Code § 1377 (a Notice of Overpayment: 30 days from the date it was mailed or served; extended for good cause)",
              "EDD, Unemployment Insurance Appeals (30 days from the mail date of the notice; form DE 1000M)"],
  }),
  // ---- benefits: a Medi-Cal health plan's appeal decision -----------------------------------------------------------
  spec({
    id: "ca-medi-cal-plan",
    family: "benefits",
    title: "Medi-Cal health plan: your appeal was denied (Notice of Appeal Resolution)",
    plain: "A letter from your Medi-Cal managed care plan saying it kept its decision after your appeal.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 120, unit: "calendar", roll: "none" },
    must: /^(?=.*medi-?cal)(?=.*(notice of appeal resolution|\bappeal\b))/is,   // the plan's answer to an appeal
    detect: [/notice of appeal resolution/i, /medi-?cal/i, /\b(health plan|managed care|state hearing)\b/i],
    spoken: /^(?=.*\bmedi-?cal\b)(?=.*\b(health plan|managed care|my plan|insurance plan|medi-?cal plan)\b)(?=.*\bappeal\b)(?=.*\b(denied|upheld|said no|lost|turned (it )?down)\b)/is,
    answers: /\b(health plan|managed care|plan|appeal)\b/i,
    keyterms: ["Notice of Appeal Resolution", "managed care plan", "State Hearing"],
    headline: "Ask for a State Hearing",
    steps: [
      "Ask for a State Hearing within 120 days: call (800) 743-8525, or send the hearing form that came with the notice.",
      "Write down the date you asked and who you talked to.",
      "You can bring someone to help you, including free legal aid.",
    ],
    help: [STATE_HEARINGS, LSNC, LAWHELP, TWO11],
    sources: ["Welfare and Institutions Code § 10951 (a State Hearing within 120 calendar days after the plan's notice that it upheld its decision; good cause up to 180 days)",
              "42 CFR 438.408(f)(2) (120 calendar days from the date of the plan's notice of resolution)"],
  }),
  spec({
    id: "ca-medi-cal-plan-denial",
    family: "benefits",
    title: "Medi-Cal health plan: a denial of care or a service (Notice of Adverse Benefit Determination)",
    plain: "A letter from your Medi-Cal managed care plan denying, cutting or stopping a treatment, a medicine or a service.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 60, unit: "calendar", roll: "none" },
    must: /medi-?cal/i,
    not: /notice of appeal resolution/i,
    detect: [/adverse benefit determination|notice of action/i, /\b(health plan|managed care)\b/i, /\b(appeal|grievance)\b/i],
    spoken: /^(?=.*\bmedi-?cal\b)(?=.*\b(health plan|managed care|my plan|insurance plan|medi-?cal plan)\b)(?=.*\b(denied|won't (cover|pay)|not cover|refused|cut|stopped|said no)\b)/is,
    answers: /\b(plan|care|medicine|service|treatment|surgery|doctor)\b/i,
    keyterms: ["Notice of Adverse Benefit Determination", "health plan"],
    headline: "Appeal to your health plan",
    steps: [
      "Appeal to your Medi-Cal health plan within 60 days of the date on the notice: call the plan's member services number, or send the appeal form that came with the notice.",
      "If the plan says no again, it sends a Notice of Appeal Resolution, and then you have 120 days to ask for a State Hearing.",
      "If the plan misses its own deadlines for your appeal, you can ask for a State Hearing without waiting.",
      "If waiting could seriously harm your health, ask the plan for an expedited appeal.",
    ],
    help: [LSNC, LAWHELP, TWO11],
    sources: ["42 CFR 438.402(c)(2)(ii) (60 calendar days from the date on the notice to appeal to the plan)",
              "42 CFR 438.402(c)(1)(i) and 438.408 (a State Hearing after the plan upholds its decision, or at once if the plan misses its notice or timing rules: 438.408(c)(3))",
              "42 CFR 438.410 (expedited appeals)"],
  }),
];

// The spoken detector tries rules in this order: most specific first ("a jury summons" before "summons").
export const SPOKEN_ORDER = ["jury-summons", "ca-ud", "ca-civil-summons", "ca-3day", "ca-medi-cal-plan", "ca-medi-cal-plan-denial",
  "ca-noa", "ssa-overpayment", "ssa-recon", "ssa-initial", "ca-edd-determination", "ca-parking-review", "ca-parking-delinquent", "ca-parking-ticket"];

// Words that could mean more than one kind of letter. The line asks which, then matches the answer among
// the candidates' `answers`.
export const AMBIGUOUS = [
  { spoken: /\bsummons\b|\bcourt papers\b/i, candidates: ["ca-ud", "ca-civil-summons", "jury-summons"],
    question: "Is it about an eviction, a lawsuit about money, or jury duty?" },
];

// Every word the recognizer should expect, from every rule (for speech-to-text key-term prompting).
export const KEYTERMS = [...new Set(RULES.flatMap(r => r.keyterms ?? []))];

export function detect(text) {
  if (!text || text.trim().length < 20) return null;
  let best = null, bestScore = 0;
  for (const r of RULES) {
    if ((r.must && !r.must.test(text)) || (r.not && r.not.test(text))) continue;
    const score = r.detect.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
    // "reconsideration" appears in both SSA letters: a reconsideration DETERMINATION offers a hearing.
    const bonus = r.id === "ssa-recon" && /(request (for )?(a )?hearing|administrative law judge)/i.test(text) ? 2 : 0;
    if (score + bonus > bestScore) { best = r; bestScore = score + bonus; }
  }
  return bestScore >= 2 ? best : null;
}
