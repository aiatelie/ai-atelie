/* codex/streamParser.ts — `codex exec --json` JSONL → AgentEvent.
 *
 * Wire shape (codex-cli 0.134 exec-JSON / "thread events" protocol).
 * CONFIRMED from live `codex exec --json` runs:
 *
 *   {"type":"thread.started","thread_id":"<uuid>"}                       // session id
 *   {"type":"turn.started"}                                             // ignore
 *   {"type":"item.completed","item":{id, type:"agent_message", text}}   // assistant text
 *   {"type":"turn.completed","usage":{input_tokens, cached_input_tokens,
 *       output_tokens, reasoning_output_tokens}}                        // usage
 *   {"type":"error","message":"…"}                                      // hard error
 *   {"type":"turn.failed","error":{"message":"…"}}                      // turn error
 *
 * The remaining `item.*` kinds below are mapped from Codex's documented
 * schema but NOT yet seen live. PROVISIONAL: the kind field name
 * (`item_type` vs `type`) and exact strings vary across builds — this
 * parser accepts both and ignores unknown shapes, so it degrades
 * gracefully. Re-confirm tool kinds against a real edit turn.
 *
 *   {"type":"item.completed","item":{type:"reasoning",     text}}     // thinking
 *   {"type":"item.completed","item":{type:"command_execution",
 *       command, aggregated_output, exit_code}}                       // shell tool
 *   {"type":"item.completed","item":{type:"mcp_tool_call",
 *       server, tool, result}}                                        // MCP tool
 *   {"type":"item.completed","item":{type:"file_change", changes}}    // patch
 *
 * We emit text/tool only on `item.completed` (the terminal item state),
 * never on `item.started`/`item.updated`, so each item is surfaced once.
 */

import type { AgentEvent } from "../../services/types.ts";

type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

type CodexItem = {
  id?: string;
  /** Item kind. Codex builds disagree on the field name; accept both. */
  item_type?: string;
  type?: string;
  text?: string;
  // command_execution
  command?: string | string[];
  aggregated_output?: string;
  exit_code?: number;
  // mcp_tool_call
  server?: string;
  tool?: string;
  result?: unknown;
  output?: unknown;
  // file_change / patch_apply
  changes?: unknown;
  status?: string;
};

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
};

export type CodexParserCallbacks = {
  onAgent: (e: AgentEvent) => void;
  /** Provider-emitted error (`error` / `turn.failed`). The adapter
   *  forwards as a normalized error AND records `emittedError = true`
   *  so a 0-exit after an error is still treated as a failure. */
  onError: (message: string) => void;
  /** Codex's `thread_id` from the first `thread.started`. Used for
   *  resume bookkeeping. Called at most once. */
  onSessionId?: (sessionId: string) => void;
};

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Codex double-encodes API errors: the `message` field is itself a
 *  JSON string like `{"error":{"message":"…"}}`. Unwrap to the human
 *  text. Recurses in case of further nesting; returns "" for empties so
 *  the caller can fall back to a generic label. */
function extractMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s) return "";
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as { message?: unknown; error?: { message?: unknown } };
      const inner =
        (typeof o.error?.message === "string" && o.error.message) ||
        (typeof o.message === "string" && o.message) || "";
      if (inner) return extractMessage(inner) || inner;
    } catch { /* not JSON — fall through to the raw string */ }
  }
  return s;
}

export function createCodexStreamParser(cb: CodexParserCallbacks) {
  let buf = "";
  let sessionIdReported = false;
  let toolSeq = 0;
  // Codex emits BOTH `error` and `turn.failed` for one failure, with the
  // same payload. Surface it once.
  let errorReported = false;
  function reportError(raw: unknown, fallback: string) {
    if (errorReported) return;
    errorReported = true;
    cb.onError(extractMessage(raw) || fallback);
  }

  function feed(chunk: string | Buffer) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  }

  function flush() {
    const tail = buf.trim();
    buf = "";
    if (tail) handleLine(tail);
  }

  function mapItem(item: CodexItem) {
    const kind = item.item_type ?? item.type;
    if (!kind) return;

    if (kind === "agent_message" || kind === "assistant_message") {
      if (typeof item.text === "string" && item.text.length > 0) {
        cb.onAgent({ type: "text", chunk: item.text });
      }
      return;
    }

    if (kind === "reasoning") {
      if (typeof item.text === "string" && item.text.length > 0) {
        cb.onAgent({ type: "thinking", chunk: item.text });
      }
      return;
    }

    if (kind === "command_execution") {
      const id = item.id ?? `cmd-${++toolSeq}`;
      const command = Array.isArray(item.command) ? item.command.join(" ") : item.command ?? "";
      cb.onAgent({ type: "tool", tool: { id, name: "command", input: { command } } });
      cb.onAgent({
        type: "toolResult",
        id,
        content: item.aggregated_output ?? stringify(item.output),
        isError: typeof item.exit_code === "number" && item.exit_code !== 0,
      });
      return;
    }

    if (kind === "mcp_tool_call") {
      const id = item.id ?? `mcp-${++toolSeq}`;
      const name = `${item.server ?? "mcp"}/${item.tool ?? "tool"}`;
      cb.onAgent({ type: "tool", tool: { id, name } });
      cb.onAgent({
        type: "toolResult",
        id,
        content: stringify(item.result ?? item.output),
        isError: item.status === "failed" || item.status === "error",
      });
      return;
    }

    if (kind === "file_change" || kind === "patch_apply") {
      const id = item.id ?? `patch-${++toolSeq}`;
      cb.onAgent({
        type: "tool",
        tool: { id, name: "apply_patch", input: item.changes ? { changes: item.changes } : undefined },
      });
      return;
    }

    // web_search, todo_list, and any future kinds — ignore for now.
  }

  function handleLine(line: string) {
    let obj: CodexEvent;
    try { obj = JSON.parse(line) as CodexEvent; }
    catch { return; } // non-JSON log line (codex prints timestamps to stderr)

    switch (obj.type) {
      case "thread.started":
        if (!sessionIdReported && typeof obj.thread_id === "string" && obj.thread_id) {
          sessionIdReported = true;
          cb.onSessionId?.(obj.thread_id);
        }
        return;
      case "item.completed":
        if (obj.item) mapItem(obj.item);
        return;
      case "turn.completed":
        if (obj.usage) {
          cb.onAgent({
            type: "usage",
            usage: {
              inputTokens: obj.usage.input_tokens,
              outputTokens: obj.usage.output_tokens,
              cacheReadInputTokens: obj.usage.cached_input_tokens,
              reasoningTokens: obj.usage.reasoning_output_tokens,
            },
          });
        }
        return;
      case "turn.failed":
        reportError(obj.error?.message ?? obj.message, "Codex turn failed");
        return;
      case "error":
        reportError(obj.message ?? obj.error?.message, "Codex error");
        return;
      default:
        return; // turn.started, item.started, item.updated, …
    }
  }

  return { feed, flush };
}
