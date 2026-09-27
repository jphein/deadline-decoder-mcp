// End-to-end: a real MCP client talks to the real HTTP server over Streamable HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.js";

const fixedNow = () => new Date("2026-09-26T19:00:00Z"); // Sat Sep 26 2026, noon Pacific

async function withClient(fn) {
  const server = createApp({ now: fixedNow }).listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: "test", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    return await fn(client, url);
  } finally {
    await client.close();
    await new Promise(r => server.close(r));
  }
}

test("negotiates protocol 2025-11-25 and lists four tools", () => withClient(async (client) => {
  assert.equal(client.getServerVersion().name, "deadline-decoder");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ["compute_deadline", "detect_letter", "list_letter_types", "make_reminder"]);
  assert.ok(client.getInstructions().includes("Never compute a deadline yourself"));
}));

test("compute_deadline over the wire", () => withClient(async (client) => {
  const r = await client.callTool({ name: "compute_deadline", arguments: { letter_type: "ssa-recon", notice_date: "2026-09-13" } });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.deadline, "2026-11-17");
  assert.equal(r.structuredContent.days_left, 52);
  assert.match(r.content[0].text, /November 17, 2026/);
}));

test("invalid letter type is rejected by the schema", () => withClient(async (client) => {
  const r = await client.callTool({ name: "compute_deadline", arguments: { letter_type: "parking-ticket", notice_date: "2026-09-13" } });
  assert.equal(r.isError, true);
}));

test("impossible date comes back as a tool error, not a server error", () => withClient(async (client) => {
  const r = await client.callTool({ name: "compute_deadline", arguments: { letter_type: "ca-noa", notice_date: "2026-02-30" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not a real calendar date/);
}));

test("GET /mcp is 405 in stateless mode", () => withClient(async (_client, url) => {
  const res = await fetch(url);
  assert.equal(res.status, 405);
}));

test("protocol version header", async () => {
  const server = createApp({ now: fixedNow }).listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }),
  });
  const body = await res.json();
  await new Promise(r => server.close(r));
  assert.equal(body.result.protocolVersion, "2025-11-25");
});
