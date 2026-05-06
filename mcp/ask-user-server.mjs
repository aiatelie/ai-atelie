/* ask-user-server.mjs — MCP server exposing one tool: `ask_user`.
 *
 * The model calls `ask_user` whenever it needs structured input from the
 * user mid-turn. The tool sends an MCP `elicitation/create` request up to
 * the host (the Claude Code SDK), which routes it to our editor frontend
 * via the SSE bridge in commentEdit.ts. The user submits the form, the
 * answer flows back, and the tool returns it as the tool result.
 *
 * The schema for structured questions follows the `questions_v2` shape
 * commonly used by design-tool agents.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "ask-user", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

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
      default: {
        description: "Optional default value pre-filled in the form.",
      },
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

  const message = String(args?.message ?? "");
  const kind = (args?.kind ?? "text");
  const options = Array.isArray(args?.options) ? args.options : null;
  const multi = !!args?.multi;

  // Build an MCP-compliant flat JSON Schema for the elicitation reply.
  // MCP elicitation supports only primitives + enum + arrays of primitives.
  let answerSchema;
  if (kind === "enum") {
    if (!options?.length) {
      return errResult("ask_user: kind='enum' requires non-empty `options`");
    }
    answerSchema = multi
      ? { type: "array", items: { type: "string", enum: options }, title: "Pick one or more" }
      : { type: "string", enum: options, title: "Pick one" };
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
      // Custom hint our editor reads to render a dropzone instead of a URL input.
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

  if (args?.default !== undefined) {
    // JSON Schema's default is informational; the UI uses it as initial value.
    answerSchema.default = args.default;
  }

  const requestedSchema = {
    type: "object",
    properties: { answer: answerSchema },
    required: ["answer"],
  };

  let result;
  try {
    result = await server.request(
      { method: "elicitation/create", params: { message, requestedSchema } },
      ElicitResultSchema,
    );
  } catch (err) {
    return errResult(`elicitation failed: ${err?.message ?? String(err)}`);
  }

  return {
    content: [
      { type: "text", text: JSON.stringify({ action: result?.action ?? "unknown", content: result?.content ?? null }) },
    ],
  };
});

function errResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
