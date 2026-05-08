/* ask-user-http-server.mjs — HTTP-bridge variant of ask-user-server.mjs.
 *
 * Same `ask_user` tool surface, same input schema, same return shape.
 * The difference is in *how* the question reaches the editor:
 *   • ask-user-server.mjs (Claude path): emits MCP `elicitation/create`
 *     and lets the SDK host route it via `onElicitation`.
 *   • this server (Kimi path): POSTs directly to /api/elicit-ask-user on
 *     the dev server, which dispatches the SSE `elicit` event on the
 *     originating stream and waits for the matching
 *     /api/elicit-response — see api/src/services/elicitBus.ts.
 *
 * Why a second server: kimi --print mode does not implement MCP
 * elicitation/create — there's no host-side elicitation handler, so the
 * Claude path silently no-ops under kimi. The HTTP bridge is a wire
 * kimi can actually drive.
 *
 * Two spawn modes — picked at runtime by which env vars are set:
 *
 *   • Single-shot mode (legacy spawnKimi path):
 *       STREAM_ID         — the per-request stream id, baked at spawn
 *       ELICIT_BRIDGE_URL — full URL of the dev server
 *     Each kimi run gets its own MCP server with the right STREAM_ID.
 *
 *   • Pool mode (kimiWorkerPool path):
 *       WORKER_KEY        — opaque key the API uses to look up the
 *                            *current* turn's streamId
 *       ELICIT_BRIDGE_URL — full URL of the dev server
 *     One MCP server lives across many turns. We fetch the live
 *     streamId from /api/_internal/current-stream/:workerKey on every
 *     tool call so dispatches always hit the right SSE stream.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildBatchedSchema } from "./ask-user-server.mjs";

const STREAM_ID = process.env.STREAM_ID || "";
const WORKER_KEY = process.env.WORKER_KEY || "";
const BRIDGE_URL = process.env.ELICIT_BRIDGE_URL || "";

/** Resolve the current stream id. Single-shot mode uses STREAM_ID env;
 *  pool mode fetches it from the API per call (the worker may serve
 *  many turns, each with a different stream). */
async function currentStreamId() {
  if (STREAM_ID) return STREAM_ID;
  if (!WORKER_KEY || !BRIDGE_URL) return null;
  try {
    const res = await fetch(
      `${BRIDGE_URL}/api/_internal/current-stream/${encodeURIComponent(WORKER_KEY)}`,
    );
    if (!res.ok) return null;
    const j = await res.json();
    return j?.streamId ?? null;
  } catch {
    return null;
  }
}

const server = new Server(
  { name: "ask-user", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

// Schema kept in lockstep with ask-user-server.mjs so the model sees the
// same tool description and arguments regardless of which provider is
// running. If you change one, change the other.
const TOOL = {
  name: "ask_user",
  description:
    "Ask the user a batched set of structured questions and wait for their answers. Use this BEFORE planning when the request is ambiguous — front-load all your clarifying questions in ONE call so the user fills one form and you proceed with full context. Returns { action: 'accept'|'decline'|'cancel', content?: { answers: { [questionId]: value } } }. Each enum question automatically gets 'Decide for me', 'Explore a few', and 'Other' (with inline free-text) appended — you don't need to add them yourself. Always prefer this over plain prose questions.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "Form header shown above all questions, e.g. 'Quick questions about the climbing event banners'. Keep it short.",
      },
      questions: {
        type: "array",
        description:
          "Ordered list of questions. The user sees them in this order and fills them all before submitting once.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "snake_case key for this question's answer." },
            kind: {
              type: "string",
              enum: ["enum", "number", "boolean", "text", "file"],
              description:
                "'enum' = pick from `options` (Decide for me / Explore a few / Other auto-added); 'number'; 'boolean'; 'text' (multiline:true for textarea); 'file' (dropzone).",
            },
            title: { type: "string" },
            subtitle: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            multi: { type: "boolean" },
            multiline: { type: "boolean" },
            min: { type: "number" },
            max: { type: "number" },
            step: { type: "number" },
            default: {},
            accept: { type: "string" },
            required: { type: "boolean", description: "Default true." },
          },
          required: ["id", "kind", "title"],
        },
      },
    },
    required: ["title", "questions"],
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== "ask_user") throw new Error(`unknown tool: ${name}`);

  if (!BRIDGE_URL) {
    return errResult(
      "ask_user is unavailable: ELICIT_BRIDGE_URL not set. Ask the user directly in your text response instead.",
    );
  }
  const streamId = await currentStreamId();
  if (!streamId) {
    return errResult(
      "ask_user is unavailable: no active turn for this worker (STREAM_ID/WORKER_KEY unresolved). " +
      "Ask the user directly in your text response instead.",
    );
  }

  const built = buildBatchedSchema(args);
  if (built.error) return errResult(built.error);
  const { message, requestedSchema } = built;

  let response;
  try {
    const res = await fetch(`${BRIDGE_URL}/api/elicit-ask-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamId, message, schema: requestedSchema, serverName: "ask-user" }),
    });
    if (!res.ok) {
      return errResult(`elicit bridge returned ${res.status}: ${await res.text()}`);
    }
    response = await res.json();
  } catch (err) {
    return errResult(`elicit bridge unreachable: ${err?.message ?? String(err)}`);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          action: response?.action ?? "unknown",
          content: response?.content ?? null,
        }),
      },
    ],
  };
});

function errResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
