/* capabilities-server.mjs — generic MCP adapter for the host's capability
 * registry. Reads /api/capabilities at boot, exposes each entry as an
 * MCP tool whose handler HTTP-POSTs back to the entry's endpoint. The
 * Claude Agent SDK can then drive any registered capability without
 * either side caring about the others.
 *
 * Why this is generic and not per-feature:
 *
 *   The capability registry (api/src/services/capabilities.ts) is the single
 *   source of truth. This adapter is one of several possible — adding a
 *   new capability is a one-line change to the registry; this file
 *   never grows. Replacing MCP later (with an OpenAI tools adapter or a
 *   different agent runtime) means writing one new file, not touching
 *   the rest of the system.
 *
 * Env vars (set by commentEdit.ts when spawning):
 *   CAP_BRIDGE_URL  — http://<host>/api/capabilities
 *   CAP_BASE_URL    — http://<host>           (used to resolve endpoint paths)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const bridgeUrl = process.env.CAP_BRIDGE_URL;
const baseUrl = process.env.CAP_BASE_URL;
if (!bridgeUrl || !baseUrl) {
  process.stderr.write(
    "capabilities-server: missing CAP_BRIDGE_URL / CAP_BASE_URL env. Host wiring bug.\n",
  );
  process.exit(2);
}

// Fetch the registry once at boot. The list is small and doesn't change
// during a turn, so per-call refetching would just waste latency. If the
// host ever needs hot-add for a new capability it can restart the SDK
// query, which respawns this MCP server.
let CAPS;
try {
  const r = await fetch(bridgeUrl);
  if (!r.ok) throw new Error(`bridge HTTP ${r.status}`);
  const json = await r.json();
  CAPS = json.capabilities ?? [];
} catch (err) {
  process.stderr.write(
    `capabilities-server: could not read registry from ${bridgeUrl} — ${err?.message ?? err}\n`,
  );
  process.exit(1);
}

const server = new Server(
  { name: "capabilities", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// Convert each registry entry into an MCP tool descriptor. The MCP
// protocol's `inputSchema` field accepts the exact same JSON Schema
// shape we already use, so no rewrite is needed.
const tools = CAPS.map((c) => ({
  name: c.id,
  description: c.description,
  inputSchema: c.inputSchema,
}));

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const cap = CAPS.find((c) => c.id === name);
  if (!cap) return errResult(`unknown capability: ${name}`);

  const url = new URL(cap.endpoint, baseUrl).toString();
  let res;
  try {
    res = await fetch(url, {
      method: cap.method,
      headers: cap.method === "POST" ? { "content-type": "application/json" } : undefined,
      body: cap.method === "POST" ? JSON.stringify(args ?? {}) : undefined,
    });
  } catch (err) {
    return errResult(`fetch failed: ${err?.message ?? String(err)}`);
  }

  // Every capability returns a small JSON envelope (artifact metadata
  // for exports, structured data for inspections). Forward verbatim.
  const text = await res.text();
  if (!res.ok) {
    return errResult(`capability returned ${res.status}: ${text.slice(0, 400)}`);
  }
  return { content: [{ type: "text", text }] };
});

function errResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
