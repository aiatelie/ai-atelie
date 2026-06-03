/* opencode/streamParser.ts — opencode --format json NDJSON → AgentEvent.
 *
 * Wire shape (verified via nexu-io/open-design's reference parser plus
 * multica-ai/multica's Go struct definition):
 *
 *   {type:"step_start",  sessionID, part:{...}}                    // ignore
 *   {type:"text",        sessionID, part:{type:"text", text}}      // text delta
 *   {type:"tool_use",    sessionID, part:{tool, callID, state:{
 *      status,           // "running" | "completed" | ...
 *      input,            // JSON-encoded string OR object
 *      output,           // string OR array of text/image blocks
 *   }}}
 *   {type:"step_finish", part:{tokens:{input, output, cache:{read, write}},
 *                              cost}}
 *   {type:"error",       error:{name, data:{message}}}
 *
 * Two non-obvious behaviors we replicate from the reference:
 *
 *   1. Each tool_use fires TWICE — once when the call starts, once
 *      when it completes with output populated. We de-dup tool-emit
 *      via a `sessionID:callID` Set so the chat UI doesn't show two
 *      chips per call, and only emit `toolResult` once when the
 *      completed event arrives.
 *
 *   2. OpenCode can exit with status 0 even after emitting `error`
 *      events (e.g. invalid model id). The exit code is unreliable;
 *      `type:"error"` events are the real failure signal. The caller
 *      tracks `emittedError` and treats it the same as a non-zero
 *      exit for retry / surface-as-error decisions.
 */

import type { AgentEvent } from "../../services/types.ts";

type OpenCodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
    };
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    cost?: number;
  };
  error?: {
    name?: string;
    data?: { message?: string };
  };
};

export type OpenCodeParserCallbacks = {
  onAgent: (e: AgentEvent) => void;
  /** Provider-emitted error. The adapter forwards as a normalized
   *  error event AND records `emittedError = true` so the run loop
   *  treats this as a failure even if the process exits 0. */
  onError: (message: string) => void;
  /** First sessionID seen on the stream. Useful for future resume
   *  bookkeeping; v1 just logs it. Called at most once per parser. */
  onSessionId?: (sessionId: string) => void;
};

/** Best-effort parse of a value that might already be an object or
 *  might be a JSON string. OpenCode's `state.input` can be either,
 *  depending on the tool. Returns the original value on parse fail. */
function safeParseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** Stringify the `state.output` field, which can be a plain string OR
 *  an array of {type:"text",text}/{type:"image",...} content blocks.
 *  Returns plain text content when possible; falls back to JSON. */
function stringifyOutput(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    let text = "";
    for (const part of v) {
      const p = part as Record<string, unknown>;
      if (p?.type === "text" && typeof p.text === "string") text += p.text;
    }
    if (text) return text;
  }
  try { return JSON.stringify(v ?? ""); } catch { return ""; }
}

export function createOpenCodeStreamParser(cb: OpenCodeParserCallbacks) {
  let buf = "";
  const seenToolUses = new Set<string>();
  let sessionIdReported = false;

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

  function handleLine(line: string) {
    let obj: OpenCodeEvent;
    try { obj = JSON.parse(line) as OpenCodeEvent; }
    catch { return; }

    if (!sessionIdReported && typeof obj.sessionID === "string" && obj.sessionID) {
      sessionIdReported = true;
      cb.onSessionId?.(obj.sessionID);
    }

    const part = obj.part ?? {};
    const t = obj.type;

    if (t === "step_start") return;

    if (t === "reasoning" && typeof part.text === "string" && part.text.length > 0) {
      cb.onAgent({ type: "thinking", chunk: part.text });
      return;
    }

    if (t === "text" && typeof part.text === "string" && part.text.length > 0) {
      cb.onAgent({ type: "text", chunk: part.text });
      return;
    }

    if (t === "tool_use" && typeof part.tool === "string" && typeof part.callID === "string") {
      const state = part.state ?? {};
      const dedupKey = `${obj.sessionID ?? "session"}:${part.callID}`;
      if (!seenToolUses.has(dedupKey)) {
        seenToolUses.add(dedupKey);
        const parsedInput = safeParseJson(state.input);
        cb.onAgent({
          type: "tool",
          tool: {
            id: part.callID,
            name: part.tool,
            input: (parsedInput && typeof parsedInput === "object" ? parsedInput : undefined) as Record<string, unknown> | undefined,
          },
        });
      }
      if (state.status === "completed") {
        cb.onAgent({
          type: "toolResult",
          id: part.callID,
          content: stringifyOutput(state.output),
          isError: false,
        });
      }
      return;
    }

    if (t === "step_finish") {
      const tokens = part.tokens;
      if (tokens) {
        cb.onAgent({
          type: "usage",
          usage: {
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheCreationInputTokens: tokens.cache?.write,
            cacheReadInputTokens: tokens.cache?.read,
          },
        });
      }
      return;
    }

    if (t === "error") {
      const msg = obj.error?.data?.message || obj.error?.name || "OpenCode error";
      cb.onError(msg);
      return;
    }
  }

  return { feed, flush };
}
