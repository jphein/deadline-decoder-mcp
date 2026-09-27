// sim.js — a simulated Alexa+ turn loop. Speech in (Web Speech API) -> MCP tool calls over
// Streamable HTTP -> speech out. The page never computes a date itself; it only calls the server.
const $ = (id) => document.getElementById(id);
const els = { ring: $("ring"), status: $("status"), mic: $("mic"), form: $("ask"), q: $("q"), transcript: $("transcript"),
  card: $("card"), log: $("log"), logCount: $("log-count"), speak: $("speak"), remind: $("remind"), again: $("again") };

// ---- MCP client (stateless Streamable HTTP, JSON responses) --------------------------------
let rpcId = 0, calls = 0;
async function callTool(name, args) {
  const req = { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } };
  const res = await fetch("mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify(req),
  });
  const body = await res.json();
  logCall(req, body);
  if (body.error) throw new Error(body.error.message);
  if (body.result.isError) throw new Error(body.result.content?.[0]?.text || "tool error");
  return body.result.structuredContent;
}
function logCall(req, body) {
  const li = document.createElement("li");
  const r = body.result?.structuredContent ?? body.result ?? body.error;
  li.append(Object.assign(document.createElement("code"), { textContent: req.params.name }));
  const pre = document.createElement("pre");
  pre.textContent = `→ ${JSON.stringify(req.params.arguments)}\n← ${JSON.stringify(r, null, 1).slice(0, 1500)}`;
  li.append(pre); els.log.prepend(li);
  els.logCount.textContent = `(${++calls})`;
}

// ---- speech ---------------------------------------------------------------------------
function setRing(state, text) { els.ring.dataset.state = state; if (text) els.status.textContent = text; }
function say(text) {
  addLine("bot", text);
  if (!els.speak.checked || !("speechSynthesis" in window)) { setRing("idle", "Tap the ring or type below"); return Promise.resolve(); }
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = speechSynthesis.getVoices().find(v => /en-US/i.test(v.lang) && /natural|neural|google|samantha|aria|jenny/i.test(v.name))
      || speechSynthesis.getVoices().find(v => /en-US/i.test(v.lang));
    if (v) u.voice = v;
    u.rate = 0.97;
    u.onstart = () => setRing("speaking", "Speaking…");
    u.onend = u.onerror = () => { setRing("idle", "Tap the ring or type below"); resolve(); };
    speechSynthesis.speak(u);
  });
}
function addLine(who, text) {
  const li = document.createElement("li");
  li.className = who; li.textContent = text;
  els.transcript.append(li); li.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function startListening() {
  if (!Recognition) { els.q.focus(); return; }
  speechSynthesis?.cancel();
  rec = new Recognition(); rec.lang = "en-US"; rec.interimResults = true; rec.maxAlternatives = 1;
  let finalText = "";
  rec.onresult = (e) => {
    const t = [...e.results].map(r => r[0].transcript).join(" ");
    els.q.value = t; if (e.results[e.results.length - 1].isFinal) finalText = t;
  };
  rec.onend = () => { els.mic.setAttribute("aria-pressed", "false"); rec = null; if (finalText.trim()) handle(finalText.trim()); else setRing("idle", "I didn't catch that — try again or type"); };
  rec.onerror = () => {};
  rec.start(); els.mic.setAttribute("aria-pressed", "true"); setRing("listening", "Listening…");
}
function stopListening() { rec?.stop(); }
if (!Recognition) { els.mic.querySelector("span").textContent = "Voice input needs Chrome — type instead"; els.mic.disabled = true; }
els.mic.addEventListener("pointerdown", (e) => { e.preventDefault(); startListening(); });
els.mic.addEventListener("pointerup", stopListening);
els.mic.addEventListener("pointerleave", () => rec && stopListening());
els.mic.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !rec) { e.preventDefault(); startListening(); } });
els.mic.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") stopListening(); });
els.ring.tabIndex = 0;
els.ring.addEventListener("click", () => rec ? stopListening() : startListening());

// ---- conversation -----------------------------------------------------------------------
const state = { letter: null, date: null, awaiting: null, last: null };
const YES = /^(yes|yeah|yep|sure|ok|okay|please|do it|go ahead|that's right|correct)\b/i;
const NO = /^(no|nope|nah|not now|no thanks)\b/i;

async function handle(text) {
  addLine("you", text); els.q.value = "";
  setRing("thinking", "Thinking…");
  try {
    if (state.awaiting === "reminder") {
      if (YES.test(text)) return reminder();
      if (NO.test(text)) { state.awaiting = null; return say("Okay. Good luck — and call free legal aid if you want help."); }
    }
    const det = await callTool("detect_letter", { text });
    if (det.recognized && det.letter_type !== state.letter) { state.letter = det.letter_type; state.date = null; }
    if (det.suggested_notice_date) state.date = det.suggested_notice_date;

    if (state.letter && state.date) return answer();
    if (state.letter) { state.awaiting = "date"; return say(det.speech); }
    if (state.date) { state.awaiting = "letter"; await say("Got the date. Which kind of letter is it?"); return offerLetterTypes(); }
    state.awaiting = "letter"; await say(det.speech); return offerLetterTypes();
  } catch (err) {
    say("Sorry, something went wrong: " + err.message);
  }
}

async function answer() {
  const r = await callTool("compute_deadline", { letter_type: state.letter, notice_date: state.date });
  state.last = r; state.awaiting = r.passed ? null : "reminder";
  showCard(r);
  els.remind.hidden = r.passed;
  await say(r.passed ? r.speech : r.speech + " Would you like a reminder on your calendar?");
}

async function reminder() {
  if (!state.last) return;
  const r = await callTool("make_reminder", { letter_type: state.last.letter_type, notice_date: state.last.notice_date });
  const url = URL.createObjectURL(new Blob([r.ics], { type: "text/calendar" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: r.filename });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  state.awaiting = null;
  await say(r.speech);
}

async function offerLetterTypes() {
  const { letter_types } = await callTool("list_letter_types", {});
  const li = document.createElement("li"); li.className = "bot";
  const wrap = document.createElement("div"); wrap.className = "chips";
  for (const t of letter_types) {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = t.title;
    b.onclick = () => { addLine("you", t.title); state.letter = t.id; if (state.date) answer(); else { state.awaiting = "date"; say(`What is the ${t.date_to_ask_for.toLowerCase()}?`); } };
    wrap.append(b);
  }
  li.append(wrap); els.transcript.append(li);
}

function showCard(r) {
  const days = r.days_left;
  $("c-title").textContent = r.letter_title;
  const dEl = $("c-days");
  dEl.textContent = r.passed ? `${-days} day${days === -1 ? "" : "s"} late` : days === 0 ? "Due today" : `${days} day${days === 1 ? "" : "s"} left`;
  dEl.parentElement.classList.toggle("passed", r.passed);
  $("c-date").textContent = `Deadline: ${r.deadline_spoken}`;
  $("c-what").textContent = r.what_to_do;
  const fill = (id, items, f = x => x) => { const el = $(id); el.replaceChildren(...items.map(i => Object.assign(document.createElement("li"), { textContent: f(i) }))); };
  fill("c-math", r.how_we_counted); fill("c-steps", r.next_steps);
  fill("c-help", r.free_help, h => `${h.name} — ${h.how}`); fill("c-src", r.sources);
  els.card.hidden = false;
}

els.form.addEventListener("submit", (e) => { e.preventDefault(); const t = els.q.value.trim(); if (t) handle(t); });
document.querySelectorAll(".chips .chip").forEach(c => c.addEventListener("click", () => handle(c.textContent)));
els.remind.addEventListener("click", () => { addLine("you", "Add a reminder"); reminder(); });
els.again.addEventListener("click", () => state.last && say(state.last.speech));
speechSynthesis?.getVoices(); // warm up the voice list
