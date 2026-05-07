/* chatStream.ts — module-level SSE lifecycle for /api/comment-edit.
 *
 * The stream lives outside the React tree so Vite HMR remounts of
 * Editor.tsx don't kill it. State is accumulated in the module and a
 * subscriber model lets the latest Editor instance receive events.
 *
 * On Editor mount:
 *   1. If a pending assistant message references a streamId still active
 *      here, the editor re-subscribes and hydrates from `getStreamState`.
 *   2. If no active stream matches, the message gets flagged "Run
 *      interrupted" — same as before, but only when the stream is truly
 *      dead (HMR-only remounts no longer get false interruptions).
 *
 * Event types mirror what the SSE wire emits, but typed.
 */

export type ElicitRequest = {
  id: string;
  serverName?: string;
  message: string;
  mode?: "form" | "url";
  schema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
};

/** A single tool invocation made by the assistant during a turn.
 *  Carries enough detail to render an expandable accordion chip in the UI:
 *  the tool name (e.g. "Read", "Edit"), a one-line label for the chip
 *  ("Read · index.html"), the raw input the model passed, and — once the
 *  tool finishes — the result text the SDK echoed back (`tool_result`).
 *  `id` is the SDK's `tool_use_id`, used to match results to calls. */
export type ToolCall = {
  name: string;
  label: string;
  input?: Record<string, unknown>;
  /** SDK `tool_use_id`. Present when parsed from the SDK stream. Used by
   *  `toolResult` events to find the matching call. */
  id?: string;
  /** Tool output text. Set when the matching `tool_result` block arrives.
   *  May be empty for tools that succeeded silently. */
  result?: string;
  /** True when the SDK marked the result as an error (e.g. file not found,
   *  permission denied). The UI can colour the result panel accordingly. */
  isError?: boolean;
};

/** Per-turn usage telemetry parsed off the SDK's `result` message. The
 *  chat UI surfaces this as a small badge under the assistant timestamp
 *  (input/output tokens, wall-clock duration, model id). All fields are
 *  optional — older threads + non-SDK providers won't carry usage. */
export type TurnUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Wall-clock duration of the SDK turn, in milliseconds. */
  durationMs?: number;
  /** Provider model id reported by the SDK (e.g. "claude-opus-4-7-…"). */
  model?: string;
};

export type StreamEvent =
  | { type: "text"; chunk: string }
  /** The full final assistant text from the SDK's `result` message.
   *  Only consumed when no deltas arrived this turn — otherwise it would
   *  duplicate the reply on top of the streamed content. */
  | { type: "finalText"; chunk: string }
  | { type: "thinking"; chunk: string }
  | { type: "tool"; tool: ToolCall }
  /** Tool finished — content is the SDK's `tool_result` text (file dump,
   *  grep matches, command output, etc.). Matched to the originating
   *  `tool` event by SDK `tool_use_id`. */
  | { type: "toolResult"; id: string; content: string; isError?: boolean }
  | { type: "turnId"; turnId: string }
  | { type: "elicit"; request: ElicitRequest }
  | { type: "elicitClear"; id: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "error"; message: string }
  | { type: "done" };

export type StreamState = {
  text: string;
  /** Accumulated extended-thinking content (Claude's reasoning). Rendered
   *  as a dimmed/collapsible block above the main reply. */
  thinking: string;
  tools: ToolCall[];
  turnId?: string;
  /** Currently-pending elicitation, if Claude called ask_user during this
   *  turn. Cleared when the user submits a response. */
  elicit?: ElicitRequest;
  /** Per-turn token + duration + model telemetry, populated when the SDK
   *  emits its terminal `result` message. Undefined on older / non-SDK
   *  providers, or until the turn finishes. */
  usage?: TurnUsage;
  error?: string;
  done: boolean;
};

type Listener = (e: StreamEvent) => void;

type ActiveStream = {
  controller: AbortController;
  state: StreamState;
  listeners: Set<Listener>;
  /** Wall-clock ms of the last SSE event dispatched for this stream. Used by
   *  the watchdog to detect a hung connection (server crash, network blip)
   *  that never delivers a graceful `done`. */
  lastEventAt: number;
  /** Watchdog interval token. Cleared when `done` fires normally. */
  watchdog?: ReturnType<typeof setInterval>;
};

const streams = new Map<string, ActiveStream>();

/** No SSE event for this long → consider the stream stalled. */
const WATCHDOG_STALL_MS = 90_000;
/** How often the watchdog re-checks each in-flight stream. */
const WATCHDOG_TICK_MS = 30_000;

export function isStreamActive(streamId: string | undefined): boolean {
  if (!streamId) return false;
  const s = streams.get(streamId);
  return !!s && !s.state.done;
}

export function getStreamState(streamId: string): StreamState | null {
  return streams.get(streamId)?.state ?? null;
}

export function subscribeStream(streamId: string, listener: Listener): () => void {
  const s = streams.get(streamId);
  if (!s) return () => {};
  s.listeners.add(listener);
  // If the stream already finished (or errored) before this listener arrived,
  // replay the terminal event(s) so the late subscriber can sync its UI
  // state. Without this, a tab/component that mounts after `done` fired will
  // hold `pending: true` forever — which is exactly the stuck-thinking bug.
  // Use a microtask so the caller observes the same "subscribe → events
  // arrive asynchronously" shape it would for an in-flight stream.
  if (s.state.done) {
    const error = s.state.error;
    queueMicrotask(() => {
      if (!s.listeners.has(listener)) return; // unsubscribed before microtask fired
      try {
        if (error) listener({ type: "error", message: error });
        listener({ type: "done" });
      } catch { /* a stale listener shouldn't poison cleanup */ }
    });
  }
  return () => { s?.listeners.delete(listener); };
}

export function abortStream(streamId: string) {
  const s = streams.get(streamId);
  if (!s) return;
  try { s.controller.abort(); } catch { /* ignore */ }
}

export function newStreamId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type StartArgs = {
  streamId: string;
  body: unknown;
  /** Single listener to register before the fetch begins. Equivalent to
   *  passing `listeners: [listener]`. */
  listener?: Listener;
  /** Multiple listeners to register before the fetch begins. Useful when
   *  a caller wants to attach more than one observer (e.g. the React
   *  handler + the persistence shadow) without racing subscribeStream. */
  listeners?: Listener[];
};

/** Spawn a fetch and pump SSE blocks into listeners. Returns when the
 *  stream finishes (or errors). Safe to call from any Editor instance. */
export async function startStream({ streamId, body, listener, listeners }: StartArgs): Promise<void> {
  if (streams.has(streamId)) return; // dedupe — caller already started this
  const controller = new AbortController();
  const initial = new Set<Listener>();
  if (listener) initial.add(listener);
  if (listeners) for (const l of listeners) initial.add(l);
  const stream: ActiveStream = {
    controller,
    state: { text: "", thinking: "", tools: [], done: false },
    listeners: initial,
    lastEventAt: Date.now(),
  };
  streams.set(streamId, stream);

  const dispatch = (e: StreamEvent) => {
    stream.lastEventAt = Date.now();
    switch (e.type) {
      case "text":        stream.state.text += e.chunk;       break;
      case "finalText":
        // Only adopt the final result text when no deltas arrived this
        // turn. Prevents the reply from doubling up when both paths fire.
        if (!stream.state.text) stream.state.text = e.chunk;
        break;
      case "thinking":    stream.state.thinking += e.chunk;   break;
      case "tool":        stream.state.tools.push(e.tool);    break;
      case "toolResult": {
        // Match by SDK tool_use_id. If the originating tool_use hasn't
        // arrived (out-of-order, unlikely), drop the result silently —
        // the SDK won't reuse the id.
        const t = stream.state.tools.find((x) => x.id === e.id);
        if (t) { t.result = e.content; t.isError = e.isError; }
        break;
      }
      case "turnId":      stream.state.turnId = e.turnId;     break;
      case "elicit":      stream.state.elicit = e.request;    break;
      case "elicitClear":
        if (stream.state.elicit?.id === e.id) stream.state.elicit = undefined;
        break;
      case "usage":       stream.state.usage = e.usage;       break;
      case "error":       stream.state.error = e.message;     break;
      case "done":
        stream.state.done = true;
        if (stream.watchdog) {
          clearInterval(stream.watchdog);
          stream.watchdog = undefined;
        }
        // The turn may have created/edited/deleted files in the project
        // sandbox. Tell file-list consumers (e.g. FileBrowserView) to
        // refetch so they don't show stale state until manual refresh.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("files:invalidate"));
        }
        break;
    }
    for (const l of stream.listeners) {
      try { l(e); } catch { /* a stale listener shouldn't kill the stream */ }
    }
  };

  // Watchdog: if the SSE connection dies without a graceful `done` (server
  // restart, dropped TCP, suspended tab waking with a stale fetch), the
  // reader loop can hang indefinitely. Tick every WATCHDOG_TICK_MS and
  // synthesise an error+done if no event has arrived in WATCHDOG_STALL_MS.
  // Cleared by the `done` branch above when the stream finishes normally.
  stream.watchdog = setInterval(() => {
    if (stream.state.done) {
      if (stream.watchdog) {
        clearInterval(stream.watchdog);
        stream.watchdog = undefined;
      }
      return;
    }
    if (Date.now() - stream.lastEventAt < WATCHDOG_STALL_MS) return;
    // Abort the underlying fetch so the reader loop unwinds; then push a
    // synthetic terminal pair through dispatch so subscribers (and the
    // accumulated state) reflect the stall.
    try { stream.controller.abort(); } catch { /* ignore */ }
    dispatch({ type: "error", message: "Stream stalled — connection may have dropped." });
    dispatch({ type: "done" });
  }, WATCHDOG_TICK_MS);

  let res: Response;
  try {
    res = await fetch("/api/comment-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      dispatch({ type: "error", message: `Network error: ${err instanceof Error ? err.message : String(err)}` });
    }
    dispatch({ type: "done" });
    return;
  }

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    let msg = txt || `HTTP ${res.status}`;
    try { msg = JSON.parse(txt).error ?? msg; } catch { /* keep raw */ }
    dispatch({ type: "error", message: msg });
    dispatch({ type: "done" });
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Any bytes from the server count as liveness — long kimi tool
      // calls (multi-minute Read/Edit/export-video) often go > 90s
      // without a parseable event but still send keepalive bytes. The
      // server-side heartbeat (commentEdit.ts) emits `:keepalive\n\n`
      // every ~25s during a run; resetting `lastEventAt` here means
      // the 90s watchdog only fires on actual TCP-level silence, not
      // on long thinking pauses where the model is still alive.
      stream.lastEventAt = Date.now();
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const e of parseSseBlock(block)) dispatch(e);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      dispatch({ type: "error", message: `Stream error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  dispatch({ type: "done" });
}

/* ─── SSE block → typed events ───────────────────────────────── */

/** Wire-format AgentEvent — must stay in sync with
 *  api/src/services/types.ts AgentEvent. The server has already
 *  normalized provider frames (Anthropic SDK, kimi stream-json, …)
 *  onto this shape, so the frontend doesn't decode raw frames. */
type WireAgentEvent =
  | { type: "text"; chunk: string }
  | { type: "finalText"; chunk: string }
  | { type: "thinking"; chunk: string }
  | { type: "tool"; tool: { id?: string; name: string; input?: Record<string, unknown> } }
  | { type: "toolResult"; id: string; content: string; isError?: boolean }
  | { type: "usage"; usage: TurnUsage };

function parseSseBlock(block: string): StreamEvent[] {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const dataStr = dataLines.join("\n");
  if (!dataStr) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(dataStr); } catch { return []; }

  if (event === "status") {
    const p = parsed as { phase?: "started" | "done" | "retry"; turnId?: string };
    if (p.phase === "started" && p.turnId) return [{ type: "turnId", turnId: p.turnId }];
    return [];
  }
  if (event === "error") {
    const p = parsed as { message?: string };
    return [{ type: "error", message: p.message ?? "Unknown error" }];
  }
  if (event === "elicit") {
    const p = parsed as ElicitRequest;
    if (!p?.id || !p?.message) return [];
    return [{ type: "elicit", request: p }];
  }
  if (event === "text") {
    const p = parsed as { text?: string };
    return p.text ? [{ type: "text", chunk: p.text }] : [];
  }
  if (event === "agent") {
    const e = parsed as WireAgentEvent;
    switch (e.type) {
      case "text":       return [{ type: "text", chunk: e.chunk }];
      case "finalText":  return [{ type: "finalText", chunk: e.chunk }];
      case "thinking":   return [{ type: "thinking", chunk: e.chunk }];
      case "tool":       return [{ type: "tool", tool: makeToolCall(e.tool.name, e.tool.input, e.tool.id) }];
      case "toolResult": return [{ type: "toolResult", id: e.id, content: e.content, isError: e.isError }];
      case "usage":      return [{ type: "usage", usage: e.usage }];
    }
    return [];
  }
  return [];
}

/** Build the ToolCall object used by the chat UI. The `label` mirrors the
 *  pre-existing chip format ("ToolName · file.ext") so legacy threads keep
 *  rendering identically; `input` is preserved verbatim so the accordion
 *  can show the file path, diff, command, etc. */
function makeToolCall(
  name: string,
  input: Record<string, unknown> | undefined,
  id?: string,
): ToolCall {
  let label = name;
  if (input && typeof input === "object") {
    const path = (input.file_path ?? input.path ?? input.file) as string | undefined;
    if (path) label += ` · ${path.split("/").pop()}`;
    else if (typeof input.command === "string") label += ` · ${input.command.slice(0, 40)}`;
  }
  return { name, label, input, id };
}
