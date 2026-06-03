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
 *
 * Phase 4 (event-sourced canonical log): the server now ALSO emits each
 * turn as an ordered, seq-stamped CanonicalEvent log on a `canon` SSE
 * channel (alongside the legacy flat `agent` wire, which is untouched).
 * We accumulate those into `StreamState.events` and the UI prefers
 * `project(reduce(events))` when present, falling back to the legacy
 * `timeline`/`thinking`/`tools` path otherwise. This makes
 * live == persisted == reconnected by construction. See
 * web/src/lib/canonicalEvents.ts (hand-mirrored from the api module).
 */

import type { CanonicalEvent } from "./canonicalEvents.ts";

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

/** One entry in a turn's chronological timeline: a run of reasoning, a
 *  tool call, or a segment of assistant prose. Built from the stream
 *  events in arrival order so the UI can replay think → act → answer
 *  instead of collapsing everything into one bubble. */
export type TimelineEntry =
  | {
      kind: "thinking";
      text: string;
      /** Reasoning block closed (model finished this thought). Drives the
       *  capsule's "Thinking… M:SS" → "Thought for Ns" transition. Absent
       *  on legacy turns → treated as done. */
      done?: boolean;
      /** Provider spent reasoning tokens but withheld the summary text
       *  (codex). The capsule shows an honest "Reasoned · ~N tok" marker
       *  instead of an empty body. */
      withheld?: boolean;
      tokens?: number;
    }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolCall };

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
  /** One event of the canonical, seq-stamped turn log (Phase 4). Carried
   *  on the `canon` SSE channel parallel to the legacy flat events. */
  | { type: "canon"; event: CanonicalEvent }
  | { type: "error"; message: string }
  | { type: "done" };

export type StreamState = {
  text: string;
  /** Accumulated extended-thinking content (Claude's reasoning). Rendered
   *  as a dimmed/collapsible block above the main reply. */
  thinking: string;
  tools: ToolCall[];
  /** Chronological think → act → answer timeline, built in arrival
   *  order. The canonical source for the timeline UI; content/thinking/
   *  tools above are kept for usage badges, copy, and legacy fallback. */
  timeline: TimelineEntry[];
  /** Canonical, seq-stamped turn log (Phase 4). When non-empty this is the
   *  authoritative turn shape — the UI renders `project(reduce(events))`.
   *  Accumulated from the `canon` SSE channel; deduped by seq so reconnect
   *  overlaps are idempotent. Falls back to `timeline` when empty (legacy
   *  threads / an older server that doesn't emit the canon channel). */
  events: CanonicalEvent[];
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

/** Fold one stream event into the chronological timeline. Consecutive
 *  thinking/text chunks coalesce into the trailing entry; a tool pushes a
 *  new entry; toolResult patches the matching tool entry by id. Pure —
 *  returns a fresh array so React sees a new ref. Unrelated events
 *  (turnId/usage/done/…) pass the timeline through unchanged. */
export function appendTimeline(tl: TimelineEntry[], e: StreamEvent): TimelineEntry[] {
  const last = tl[tl.length - 1];
  switch (e.type) {
    case "thinking":
      if (!e.chunk) return tl;
      if (last && last.kind === "thinking") return [...tl.slice(0, -1), { kind: "thinking", text: last.text + e.chunk }];
      return [...tl, { kind: "thinking", text: e.chunk }];
    case "text":
      if (!e.chunk) return tl;
      if (last && last.kind === "text") return [...tl.slice(0, -1), { kind: "text", text: last.text + e.chunk }];
      return [...tl, { kind: "text", text: e.chunk }];
    case "finalText":
      // Mirror state.text dedup: only adopt the SDK's final text when no
      // streamed text entry already exists this turn.
      if (!e.chunk || tl.some((x) => x.kind === "text")) return tl;
      return [...tl, { kind: "text", text: e.chunk }];
    case "tool":
      return [...tl, { kind: "tool", tool: e.tool }];
    case "toolResult":
      return tl.map((x) =>
        x.kind === "tool" && x.tool.id === e.id
          ? { kind: "tool", tool: { ...x.tool, result: e.content, isError: e.isError } }
          : x,
      );
    default:
      return tl;
  }
}

/** Append a canonical event to the per-stream log, idempotent by seq.
 *  A single SSE connection delivers events in order, but reconnect
 *  (Phase 5) replays a suffix that may overlap what we already have — so
 *  drop any event whose seq we've already incorporated. Mutates in place
 *  (the array lives on the long-lived stream.state); `project(reduce())`
 *  sorts at render time so order is never relied on here. */
function appendCanonical(events: CanonicalEvent[], e: CanonicalEvent): void {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].seq === e.seq) return; // already seen → idempotent
    if (events[i].seq < e.seq) break;    // common case: strictly increasing
  }
  events.push(e);
}

type Listener = (e: StreamEvent) => void;

type ActiveStream = {
  controller: AbortController;
  state: StreamState;
  listeners: Set<Listener>;
  /** Wall-clock ms of the last SSE event dispatched for this stream. Used by
   *  the watchdog to detect a hung connection (server crash, network blip)
   *  that never delivers a graceful `done`. */
  lastEventAt: number;
  /** Highest SSE `id:` consumed for this stream. Set by the parser when
   *  the server tagged each event with a monotonic eventIndex. Used by
   *  `resumeStream(streamId)` so a reloaded tab asks for events it has
   *  not yet seen — the server's replay endpoint slices from this value. */
  lastEventIndex: number;
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
  // Dedupe a genuinely in-flight stream (HMR remount, two callers racing
  // the same id). But a FINISHED entry lingers in the map (we never delete
  // — getStreamState/resume need it), and the retry path deliberately
  // reuses the user message's streamId. A bare has()-check would then make
  // retry a silent no-op and strand the new pending bubble forever, so
  // allow restarting a stream whose prior turn already completed.
  const prior = streams.get(streamId);
  if (prior && !prior.state.done) return;
  const controller = new AbortController();
  const initial = new Set<Listener>();
  if (listener) initial.add(listener);
  if (listeners) for (const l of listeners) initial.add(l);
  const stream: ActiveStream = {
    controller,
    state: { text: "", thinking: "", tools: [], timeline: [], events: [], done: false },
    listeners: initial,
    lastEventAt: Date.now(),
    lastEventIndex: -1,
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
      case "canon":       appendCanonical(stream.state.events, e.event); break;
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
    stream.state.timeline = appendTimeline(stream.state.timeline, e);
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

  await pumpSse(res, stream, dispatch);
  dispatch({ type: "done" });
}

/** Read a fetch Response's SSE body and dispatch each parsed event.
 *  Shared between `startStream` (initial POST) and `resumeStream` (GET
 *  replay). Handles bytes-as-liveness (keepalive comments don't parse
 *  as events but still reset the stall watchdog) and the SSE `id:`
 *  field (recorded as `lastEventIndex` for resume continuity). */
async function pumpSse(
  res: Response,
  stream: ActiveStream,
  dispatch: (e: StreamEvent) => void,
): Promise<void> {
  if (!res.body) return;
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
        const parsed = parseSseBlock(block);
        if (parsed.eventIndex != null) {
          stream.lastEventIndex = Math.max(stream.lastEventIndex, parsed.eventIndex);
        }
        for (const e of parsed.events) dispatch(e);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      dispatch({ type: "error", message: `Stream error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

/** Reattach to a server-side run that's still streaming after a full
 *  page reload. Returns true if the server has the buffered run and
 *  this client successfully started receiving events; false if the run
 *  is no longer in the registry (server restarted, GC'd post-completion,
 *  or the streamId was never tracked).
 *
 *  This NEVER triggers a fresh AI turn. The original POST already kicked
 *  off the SDK call — `resumeStream` is a pure consumer of the buffered
 *  + live event tail. */
export async function resumeStream(streamId: string, listeners: Listener[]): Promise<boolean> {
  // Already running in this tab (HMR remount or two callers in the same
  // process). Just attach listeners and let the existing pump drive them.
  const existing = streams.get(streamId);
  if (existing) {
    for (const l of listeners) existing.listeners.add(l);
    if (existing.state.done) {
      const error = existing.state.error;
      queueMicrotask(() => {
        for (const l of listeners) {
          if (!existing.listeners.has(l)) continue;
          try {
            if (error) l({ type: "error", message: error });
            l({ type: "done" });
          } catch { /* ignore */ }
        }
      });
    } else {
      // Stream is in-flight — replay accumulated state so the new listeners
      // can rebuild the full message instead of seeing only deltas from
      // this point forward. Dispatched via microtask so subscribers observe
      // the same async shape they would for a server-replay flow.
      const s = existing.state;
      queueMicrotask(() => {
        for (const l of listeners) {
          if (!existing.listeners.has(l)) continue;
          try {
            if (s.turnId) l({ type: "turnId", turnId: s.turnId });
            // Canonical log first — when present it's the authoritative turn
            // shape the new listener will render. The legacy replays below
            // keep the fallback path (and usage badges) populated too.
            for (const ev of s.events) l({ type: "canon", event: ev });
            if (s.thinking) l({ type: "thinking", chunk: s.thinking });
            if (s.text) l({ type: "text", chunk: s.text });
            for (const t of s.tools) l({ type: "tool", tool: t });
            for (const t of s.tools) {
              if (t.result != null) l({ type: "toolResult", id: t.id ?? "", content: t.result, isError: t.isError });
            }
            if (s.elicit) l({ type: "elicit", request: s.elicit });
            if (s.usage) l({ type: "usage", usage: s.usage });
            if (s.error) l({ type: "error", message: s.error });
          } catch { /* ignore */ }
        }
      });
    }
    return true;
  }

  const controller = new AbortController();
  const stream: ActiveStream = {
    controller,
    state: { text: "", thinking: "", tools: [], timeline: [], events: [], done: false },
    listeners: new Set(listeners),
    lastEventAt: Date.now(),
    lastEventIndex: -1,
  };

  let res: Response;
  try {
    res = await fetch(
      `/api/comment-edit/replay/${encodeURIComponent(streamId)}?fromIndex=0`,
      { signal: controller.signal },
    );
  } catch (err) {
    // Network failure — caller treats this the same as "no buffered run".
    if ((err as Error).name !== "AbortError") {
      console.warn("[chatStream] resume fetch failed:", err);
    }
    return false;
  }
  if (res.status === 404 || !res.body) return false;
  if (!res.ok) return false;

  // Past this point we're committed: register the stream so subscribers
  // (e.g. the elicit form lookup) can find it via getStreamState.
  streams.set(streamId, stream);

  const dispatch = (e: StreamEvent) => {
    stream.lastEventAt = Date.now();
    switch (e.type) {
      case "text":        stream.state.text += e.chunk;       break;
      case "finalText":
        if (!stream.state.text) stream.state.text = e.chunk;
        break;
      case "thinking":    stream.state.thinking += e.chunk;   break;
      case "tool":        stream.state.tools.push(e.tool);    break;
      case "toolResult": {
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
      case "canon":       appendCanonical(stream.state.events, e.event); break;
      case "error":       stream.state.error = e.message;     break;
      case "done":
        stream.state.done = true;
        if (stream.watchdog) {
          clearInterval(stream.watchdog);
          stream.watchdog = undefined;
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("files:invalidate"));
        }
        break;
    }
    stream.state.timeline = appendTimeline(stream.state.timeline, e);
    for (const l of stream.listeners) {
      try { l(e); } catch { /* a stale listener shouldn't kill the stream */ }
    }
  };

  // Watchdog identical to startStream's — server-side keepalive resets
  // it on every chunk, so a hung resume connection still drops cleanly.
  stream.watchdog = setInterval(() => {
    if (stream.state.done) {
      if (stream.watchdog) {
        clearInterval(stream.watchdog);
        stream.watchdog = undefined;
      }
      return;
    }
    if (Date.now() - stream.lastEventAt < WATCHDOG_STALL_MS) return;
    try { stream.controller.abort(); } catch { /* ignore */ }
    dispatch({ type: "error", message: "Stream stalled — connection may have dropped." });
    dispatch({ type: "done" });
  }, WATCHDOG_TICK_MS);

  // Fire the pump asynchronously; resumeStream returns true immediately
  // so the caller can show the pending bubble while events catch up.
  void (async () => {
    await pumpSse(res, stream, dispatch);
    dispatch({ type: "done" });
  })();

  return true;
}

/** Tell the server we're explicitly stopping this run. Bypasses the
 *  grace window so the SDK aborts immediately rather than waiting the
 *  full GRACE_DISCONNECT_MS in case a tailer reattaches. Best-effort:
 *  errors are swallowed (the local fetch abort is the canonical signal). */
export async function notifyServerStop(streamId: string): Promise<void> {
  try {
    await fetch(
      `/api/comment-edit/abort/${encodeURIComponent(streamId)}`,
      { method: "POST" },
    );
  } catch {
    /* network gone — local abort still fires */
  }
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

function parseSseBlock(block: string): { events: StreamEvent[]; eventIndex: number | null } {
  let event = "message";
  let eventIndex: number | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) eventIndex = n;
    }
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const dataStr = dataLines.join("\n");
  if (!dataStr) return { events: [], eventIndex };
  let parsed: unknown;
  try { parsed = JSON.parse(dataStr); } catch { return { events: [], eventIndex }; }

  const wrap = (events: StreamEvent[]) => ({ events, eventIndex });

  if (event === "status") {
    const p = parsed as { phase?: "started" | "done" | "retry"; turnId?: string };
    if (p.phase === "started" && p.turnId) return wrap([{ type: "turnId", turnId: p.turnId }]);
    return wrap([]);
  }
  if (event === "error") {
    const p = parsed as { message?: string };
    return wrap([{ type: "error", message: p.message ?? "Unknown error" }]);
  }
  if (event === "elicit") {
    const p = parsed as ElicitRequest;
    if (!p?.id || !p?.message) return wrap([]);
    return wrap([{ type: "elicit", request: p }]);
  }
  if (event === "elicitClear") {
    const p = parsed as { id?: string };
    if (!p?.id) return wrap([]);
    return wrap([{ type: "elicitClear", id: p.id }]);
  }
  if (event === "text") {
    const p = parsed as { text?: string };
    return p.text ? wrap([{ type: "text", chunk: p.text }]) : wrap([]);
  }
  if (event === "canon") {
    // One CanonicalEvent (Phase 4). The server stamps `seq` + `id`; we
    // fold it into StreamState.events. Validate the minimum shape so a
    // malformed frame can't poison the log.
    const p = parsed as CanonicalEvent;
    if (p && typeof p === "object" && typeof p.kind === "string" && typeof p.seq === "number") {
      return wrap([{ type: "canon", event: p }]);
    }
    return wrap([]);
  }
  if (event === "agent") {
    const e = parsed as WireAgentEvent;
    switch (e.type) {
      case "text":       return wrap([{ type: "text", chunk: e.chunk }]);
      case "finalText":  return wrap([{ type: "finalText", chunk: e.chunk }]);
      case "thinking":   return wrap([{ type: "thinking", chunk: e.chunk }]);
      case "tool":       return wrap([{ type: "tool", tool: makeToolCall(e.tool.name, e.tool.input, e.tool.id) }]);
      case "toolResult": return wrap([{ type: "toolResult", id: e.id, content: e.content, isError: e.isError }]);
      case "usage":      return wrap([{ type: "usage", usage: e.usage }]);
    }
    return wrap([]);
  }
  return wrap([]);
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
