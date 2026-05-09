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
  { name: "ask-user", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// Schema kept in lockstep with ask-user-server.mjs so the model sees the
// same tool description and arguments regardless of which provider is
// running. If you change one, change the other.
const TOOL = {
  name: "ask_user",
  description:
    "Ask the user a structured question and wait for a response. Use this when you need clarification BEFORE building anything — pick from discrete options, get a number/range, ask for free text, or request a file. Returns { action: 'accept'|'decline'|'cancel', content?: { answer: ... } }. Always prefer this over plain prose questions when the answer fits a structured shape.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "The question to ask the user, in plain language. Keep it short — the form UI shows it as a header above the input.",
      },
      kind: {
        type: "string",
        enum: ["text", "enum", "number", "boolean", "file"],
        description:
          "Input shape. 'text' (default) = freeform string; 'enum' = pick one of `options`; 'number' = numeric (use min/max/step); 'boolean' = yes/no; 'file' = file dropzone (returns project-relative path).",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "Choices for `kind: 'enum'`. Required for enum, ignored otherwise.",
      },
      multi: {
        type: "boolean",
        description:
          "For `kind: 'enum'` — allow selecting multiple options (renders as checkboxes). Default false.",
      },
      multiline: {
        type: "boolean",
        description:
          "For `kind: 'text'` — render a textarea instead of a one-line input. Default false.",
      },
      min: { type: "number", description: "For `kind: 'number'`." },
      max: { type: "number", description: "For `kind: 'number'`." },
      step: { type: "number", description: "For `kind: 'number'`." },
      default: { description: "Optional default value pre-filled in the form." },
      accept: {
        type: "string",
        description:
          "For `kind: 'file'` — MIME filter (e.g. 'image/*', 'image/png,application/pdf').",
      },
    },
    required: ["message"],
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

  const message = String(args?.message ?? "");
  const kind = (args?.kind ?? "text");
  const options = Array.isArray(args?.options) ? args.options : null;
  const multi = !!args?.multi;

  // Build the same flat reply schema as ask-user-server.mjs so the
  // editor's ElicitForm can render either source identically.
  let answerSchema;
  if (kind === "enum") {
    if (!options?.length) {
      return errResult("ask_user: kind='enum' requires non-empty `options`");
    }
    // For multi-select, always inject universal escape hatches so the user
    // can delegate the decision back to the model or ask for variations.
    let opts = options;
    if (multi) {
      const ESCAPE_HATCHES = ["Decide for me", "Explore a few options"];
      const existing = new Set(opts);
      const missing = ESCAPE_HATCHES.filter((h) => !existing.has(h));
      if (missing.length > 0) opts = [...opts, ...missing];
    }
    answerSchema = multi
      ? { type: "array", items: { type: "string", enum: opts }, title: "Pick one or more" }
      : { type: "string", enum: opts, title: "Pick one" };
  } else if (kind === "number") {
    answerSchema = {
      type: "number",
      title: "Enter a number",
      ...(typeof args?.min === "number" ? { minimum: args.min } : {}),
      ...(typeof args?.max === "number" ? { maximum: args.max } : {}),
      ...(typeof args?.step === "number" ? { multipleOf: args.step } : {}),
    };
  } else if (kind === "boolean") {
    answerSchema = { type: "boolean", title: "Yes / No" };
  } else if (kind === "file") {
    answerSchema = {
      type: "string",
      format: "uri",
      title: "Drop a file",
      description: args?.accept ? `Accepts: ${args.accept}` : undefined,
      "x-input": "dropzone",
      "x-accept": args?.accept ?? undefined,
    };
  } else {
    answerSchema = {
      type: "string",
      title: args?.multiline ? "Your answer (multi-line)" : "Your answer",
      ...(args?.multiline ? { "x-input": "textarea" } : {}),
    };
  }
  if (args?.default !== undefined) answerSchema.default = args.default;

  const requestedSchema = {
    type: "object",
    properties: { answer: answerSchema },
    required: ["answer"],
  };

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
