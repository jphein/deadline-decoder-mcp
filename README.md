# Deadline Decoder MCP

**Ask a voice assistant "when is my deadline?" and get the real answer, with the math shown.**

An [MCP](https://modelcontextprotocol.io) server (spec **2025-11-25**, **Streamable HTTP**) that gives Alexa+ and any other MCP-capable assistant exact, cited deadline math for the letters that upend people's lives:

| Letter | Rule |
|---|---|
| Social Security: application denied | 60 days from receipt; receipt presumed 5 days after the notice date; weekend/holiday rollover (20 CFR 404.909, 404.901, 404.3(b)) |
| Social Security: denied again (reconsideration) | same counting, request a hearing (20 CFR 404.933) |
| California 3-day notice to pay rent or quit | 3 **court** days; weekends and judicial holidays excluded (CCP § 1161(2), AB 2343) |
| California eviction court papers (unlawful detainer) | 10 court days to respond (CCP § 1167, AB 2347, eff. 2025) |
| Medi-Cal / CalFresh Notice of Action | 90 days to request a state hearing (W&I Code § 10951) |

**The model never computes a date.** It calls these tools, and the rules are plain, tested JavaScript, so a deadline can't be hallucinated. Every answer includes a `speech` field written for the ear: spoken dates, no ISO strings, counting steps rewritten to sound natural.

## Tools

| Tool | What it does |
|---|---|
| `list_letter_types` | The five letter kinds, their ids, and which date to ask the user for |
| `detect_letter(text, today?)` | Recognizes a letter from its printed text **or from how people say it** ("my landlord taped a three day notice on my door yesterday") and resolves spoken dates without a year ("September 13th", "the 22nd of September", "yesterday") |
| `compute_deadline(letter_type, notice_date, today?)` | Deadline, days left, what to do, how it was counted, next steps, free help, legal sources, and a speakable answer |
| `make_reminder(letter_type, notice_date, today?)` | An `.ics` all-day event with an alert a week before (refuses if the deadline has passed) |

Server instructions tell the assistant to always call `compute_deadline` rather than doing date math itself, and to confirm the date it passes.

## Run

```bash
npm install
npm start                      # MCP at http://127.0.0.1:8766/mcp, simulator at http://127.0.0.1:8766/
npm test                       # 29 tests: the rule/date tests plus decoder and end-to-end MCP tests
```

Behind a reverse proxy: `HOST=0.0.0.0 ALLOWED_HOSTS=deadlines.example.org PORT=8766 npm start` (DNS-rebinding protection stays on for the listed hosts).

Try it from any MCP client (Streamable HTTP, `http://127.0.0.1:8766/mcp`), or with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector   # transport: Streamable HTTP, URL: http://127.0.0.1:8766/mcp
```

## Voice assistant simulator

`public/` is a **simulated Alexa+ experience**: hold to talk (Web Speech API in Chrome) or type; the page calls the MCP server's tools over Streamable HTTP and speaks the answer. A panel shows every MCP tool call and its result. It's a demo harness, not an Amazon product.

![simulator](docs/simulator.png)

## Where the rules come from

`src/rules/dates.js` and `src/rules/rules.js` are copied unchanged from [Deadline Decoder](https://github.com/jphein/deadline-decoder), the web app, by the same author. `src/decoder.js` adds the voice layer (spoken-date parsing, spoken-phrase letter detection, ear-friendly counting steps, days left, reminders); `src/mcp.js` and `src/server.js` add the MCP server.

## Limits

California and federal rules only. Eviction deadlines assume personal service (substituted or posted service adds days; the tool says so). Court holidays are verified against the Judicial Council calendar for 2026 and computed from statute for other years, and the answer says which. This is general information, not legal advice.

## License

MIT © 2026 Jeffrey Pine Hein. Built for [TechEMPOWER](https://techempower.org).
