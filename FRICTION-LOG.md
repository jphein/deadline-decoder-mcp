# Friction log: building Deadline Decoder for Alexa+

Snags hit while building this MCP server for the Alexa+ track of Amazon's Build, Ship, Shape hackathon (2026). Each entry uses the hackathon's format: task, steps, expected vs. actual, severity, workaround, suggestion. Only snags that actually happened in this build are logged.

## F1. Connect a self-hosted MCP server to a real Alexa+
- Task: point Alexa+ at our Streamable HTTP MCP endpoint and test it by voice.
- Steps: read the hackathon's Alexa+ resources ("Build with Agent Skills", "Streamable HTTP transport") and the Alexa+ track rules; looked for an Alexa+ MCP or Agent Skill registration guide.
- Expected: a guide or console flow for registering an MCP server URL with Alexa+ and testing it on a device or in a simulator.
- Actual: the resources point to the open MCP and Agent Skills standards. We found no Alexa+-specific registration or test path available to us.
- Severity: High (it blocks the real-device demo).
- Workaround: the rules' simulated-Alexa+ path. We built a web simulator that calls the same MCP server.
- Suggestion: publish a developer-preview registration flow, even a sandbox-only one, plus one end-to-end "hello world" for self-hosted MCP on Alexa+.

## F2. Know how Alexa+ will speak a tool result
- Task: make deadline answers sound right when read aloud.
- Steps: looked in the track resources for how Alexa+ renders MCP tool output (text content vs. structuredContent, SSML, pronunciation).
- Expected: guidance on which part of a tool result Alexa+ reads aloud and how to control pronunciation.
- Actual: no guidance found. ISO dates and statute numbers read aloud badly.
- Severity: Medium.
- Workaround: every tool returns a "speech" field written for the ear (spoken dates, counting steps reworded), and the server instructions tell the assistant to read it.
- Suggestion: document how tool results become speech, and support an optional SSML or "speakable text" block in MCP results.

## F3. Target the right MCP version and session mode
- Task: pick the protocol version and session mode Alexa+ will accept.
- Steps: read the track rules ("2025-11-25 (or a later version, once confirmed)") and the resources.
- Expected: a list of the protocol versions Alexa+ negotiates, and whether stateless servers (no Mcp-Session-Id) are supported.
- Actual: only the minimum version is stated. Nothing says whether stateless mode is supported or which later versions are "confirmed".
- Severity: Low.
- Workaround: pinned 2025-11-25, stateless, and tested with the SDK client sending the mcp-protocol-version header.
- Suggestion: publish a compatibility table (versions, transports, session mode) and a small conformance checker.
