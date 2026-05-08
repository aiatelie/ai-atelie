/* ask-user-server.mjs — MCP server exposing one tool: `ask_user`.
 *
 * The model calls `ask_user` with a BATCHED set of questions whenever it
 * needs structured input from the user. The tool sends an MCP
 * `elicitation/create` request up to the host (the Claude Code SDK),
 * which routes it to our editor frontend via the SSE bridge in
 * commentEdit.ts. The user submits the form, the answer flows back, and
 * the tool returns it as the tool result.
 *
 * The schema follows the `questions_v2` shape common in design-tool
 * agents: one tool call yields N questions in one form. Single-question
 * cases are just N=1.
 *
 * Each enum question gets three escape-hatch options auto-injected
 * server-side: "Decide for me", "Explore a few", and "Other" (paired
 * with an inline textarea via the `x-other-input` flag).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "ask-user", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

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
            id: {
              type: "string",
              description:
                "snake_case key for this question's answer in the result. Example: 'event_type', 'audience', 'banner_count'.",
            },
            kind: {
              type: "string",
              enum: ["enum", "number", "boolean", "text", "file"],
              description:
                "'enum' = pick from `options` (Decide for me / Explore a few / Other auto-added); 'number' = numeric (use min/max/step); 'boolean' = yes/no; 'text' = freeform (set multiline:true for textarea); 'file' = file dropzone (returns project-relative path).",
            },
            title: {
              type: "string",
              description: "Question header shown above the input.",
            },
            subtitle: {
              type: "string",
              description:
                "Optional grey hint below the title, e.g. 'Pick one or a few' or 'Leave blank if you want me to invent placeholder content'.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "Choices for kind:'enum'. Don't include 'Decide for me', 'Explore a few', or 'Other' — those are added automatically.",
            },
            multi: {
              type: "boolean",
              description: "For kind:'enum' — allow selecting multiple options (checkboxes vs radio). Default false.",
            },
            multiline: {
              type: "boolean",
              description: "For kind:'text' — render a textarea instead of a one-line input. Default false.",
            },
            min: { type: "number", description: "For kind:'number'." },
            max: { type: "number", description: "For kind:'number'." },
            step: { type: "number", description: "For kind:'number'." },
            default: { description: "Optional default value pre-filled in the form." },
            accept: {
              type: "string",
              description: "For kind:'file' — MIME filter (e.g. 'image/*', 'image/png,application/pdf').",
            },
            required: {
              type: "boolean",
              description: "If false, the user can leave this question blank. Default true.",
            },
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

  const built = buildBatchedSchema(args);
  if (built.error) return errResult(built.error);
  const { message, requestedSchema } = built;

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
      {
        type: "text",
        text: JSON.stringify({
          action: result?.action ?? "unknown",
          content: result?.content ?? null,
        }),
      },
    ],
  };
});

/** Build the MCP-compliant flat JSON Schema for the elicitation reply
 *  from the model's batched questions[] input.
 *  Returns { message, requestedSchema } on success, { error } on failure. */
export function buildBatchedSchema(args) {
  const title = String(args?.title ?? "").trim();
  const questions = Array.isArray(args?.questions) ? args.questions : null;
  if (!title) return { error: "ask_user: `title` is required." };
  if (!questions?.length) return { error: "ask_user: `questions` must be a non-empty array." };

  const properties = {};
  const required = [];
  const seenIds = new Set();

  for (const q of questions) {
    const id = String(q?.id ?? "").trim();
    if (!id) return { error: "ask_user: every question needs an `id`." };
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      return { error: `ask_user: question id '${id}' must be snake_case (a-z, 0-9, _).` };
    }
    if (seenIds.has(id)) return { error: `ask_user: duplicate question id '${id}'.` };
    seenIds.add(id);

    const kind = q?.kind ?? "text";
    const qSchema = buildFieldSchema(kind, q);
    if (qSchema.error) return { error: `ask_user[${id}]: ${qSchema.error}` };

    qSchema.schema.title = String(q?.title ?? id);
    if (q?.subtitle) qSchema.schema["x-subtitle"] = String(q.subtitle);
    if (q?.default !== undefined) qSchema.schema.default = q.default;

    properties[id] = qSchema.schema;
    if (q?.required !== false) required.push(id);
  }

  return {
    message: title,
    requestedSchema: {
      type: "object",
      title,
      properties,
      ...(required.length ? { required } : {}),
    },
  };
}

/** Build a single-field JSON Schema for one question. Adds the
 *  Decide for me / Explore a few / Other escape hatches on enum kinds. */
function buildFieldSchema(kind, q) {
  if (kind === "enum") {
    const options = Array.isArray(q?.options) ? q.options.filter((o) => typeof o === "string") : null;
    if (!options?.length) return { error: "kind='enum' requires non-empty `options`" };
    // Strip any user-supplied collisions with our reserved escape-hatch labels
    // so the auto-injected ones are unambiguous.
    const RESERVED = new Set(["Decide for me", "Explore a few", "Other"]);
    const userOpts = options.filter((o) => !RESERVED.has(o));
    const finalOptions = [...userOpts, "Decide for me", "Explore a few", "Other"];
    if (q?.multi) {
      return {
        schema: {
          type: "array",
          items: { type: "string", enum: finalOptions },
          "x-other-input": true,
        },
      };
    }
    return {
      schema: {
        type: "string",
        enum: finalOptions,
        "x-other-input": true,
      },
    };
  }
  if (kind === "number") {
    return {
      schema: {
        type: "number",
        ...(typeof q?.min === "number" ? { minimum: q.min } : {}),
        ...(typeof q?.max === "number" ? { maximum: q.max } : {}),
        ...(typeof q?.step === "number" ? { multipleOf: q.step } : {}),
      },
    };
  }
  if (kind === "boolean") {
    return { schema: { type: "boolean" } };
  }
  if (kind === "file") {
    return {
      schema: {
        type: "string",
        format: "uri",
        description: q?.accept ? `Accepts: ${q.accept}` : undefined,
        "x-input": "dropzone",
        "x-accept": q?.accept ?? undefined,
      },
    };
  }
  // text (default)
  return {
    schema: {
      type: "string",
      ...(q?.multiline ? { "x-input": "textarea" } : {}),
    },
  };
}

function errResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
