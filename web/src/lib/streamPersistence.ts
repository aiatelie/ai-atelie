/* streamPersistence.ts — shadow listener that mirrors stream events into the
 * saved thread archive, independently of any React component lifecycle.
 *
 * The Editor component's stream handler is responsible for VISUAL updates
 * (driving setThreads so the bubble renders deltas). It is bound to React
 * state and dies the moment the user switches projects (the re-attach
 * useEffect cleans up its subscription, and the React state itself is
 * replaced by the new project's archive).
 *
 * That leaves a window where the underlying SSE stream is still alive in
 * `chatStream.ts` but nothing is updating the OTHER project's saved
 * threads.json. If the user reloads the page in that window, all progress
 * accumulated during the away-from-A period is lost.
 *
 * The shadow listener fixes this. For every stream we attach here, we
 * subscribe to its events and mutate the cached ThreadArchive for the
 * owning project, then call saveThreads. The cache + save layer is shared
 * with the React component, so once the shadow has written, a project
 * switch (which calls libLoadThreads) sees the up-to-date archive
 * immediately.
 *
 * Architectural choice — DUAL WRITER:
 *   - React handler updates React state (instant visual feedback).
 *   - Shadow handler updates the cached archive + calls saveThreads
 *     (durable persistence, fires regardless of which project the user
 *     is currently viewing).
 *   - Editor's existing save useEffect skips writes for threads that
 *     have a tracked in-flight stream — the shadow is authoritative
 *     while the stream runs. Non-stream mutations (rename, delete,
 *     edit) flow through the same useEffect and write normally.
 */

import { subscribeStream, type StreamEvent } from "./chatStream";
import { loadThreads as libLoadThreads, saveThreads } from "./threads";
import type { ChatMessage, ChatThread, ThreadArchive } from "../components/editor/ChatSidebar";

type Tracked = {
  projectId: string;
  threadId: string;
  /** Index of the pending assistant message in the thread at attach time.
   *  Stable for the lifetime of the stream — we never insert/remove
   *  messages mid-stream from this index forward. */
  msgIdx: number;
  /** Late subscription handle. Empty until `wireSubscription` runs;
   *  filled once the stream entry is registered in chatStream. */
  unsub: () => void;
  /** Buffered text/thinking deltas, flushed periodically to coalesce
   *  archive mutations + reduce save noise (saveThreads itself debounces
   *  300ms, but we still want to avoid creating dozens of new archive
   *  objects per second). */
  textBuf: string;
  thinkBuf: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  handler: (e: StreamEvent) => void;
};

const tracked = new Map<string, Tracked>();

/** Quiet flush cadence — saveThreads's own 300ms debounce coalesces
 *  bursts on the wire, but applying the mutation less often is also
 *  cheaper for the GC + ETag layer. */
const FLUSH_MS = 250;

/** True when this streamId has a shadow listener mutating its archive. */
export function isShadowTracked(streamId: string | undefined): boolean {
  if (!streamId) return false;
  return tracked.has(streamId);
}

/** True when ANY in-flight stream is wired to (projectId, threadId).
 *  Used by the React save useEffect to decide whether the shadow is
 *  authoritative for the current thread's content right now. */
export function isThreadShadowed(projectId: string, threadId: string): boolean {
  for (const t of tracked.values()) {
    if (t.projectId === projectId && t.threadId === threadId) return true;
  }
  return false;
}

/** Wire a stream to its target message in a project's threads.
 *
 *  Returns the StreamEvent listener — the caller passes it to
 *  startStream's `listeners` array so the shadow is in the dispatch
 *  set BEFORE the fetch begins (no events are missed). The shadow is
 *  also tracked in a module-level map; its detach on `done` is
 *  automatic, but callers can `detachStream` early (e.g. on thread
 *  delete or message truncation).
 *
 *  Idempotent — calling twice for the same streamId replaces the prior
 *  attachment. */
export function attachStreamToThread(args: {
  projectId: string;
  threadId: string;
  streamId: string;
  msgIdx: number;
}): (e: StreamEvent) => void {
  const { projectId, threadId, streamId, msgIdx } = args;

  // Replace any existing entry for this streamId so we don't leak listeners.
  const prior = tracked.get(streamId);
  if (prior) {
    if (prior.flushTimer) clearTimeout(prior.flushTimer);
    try { prior.unsub(); } catch { /* ignore */ }
    tracked.delete(streamId);
  }

  const entry: Tracked = {
    projectId,
    threadId,
    msgIdx,
    unsub: () => {},
    textBuf: "",
    thinkBuf: "",
    flushTimer: null,
    handler: () => {},
  };

  const flushBuffers = () => {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (!entry.textBuf && !entry.thinkBuf) return;
    const t = entry.textBuf; entry.textBuf = "";
    const k = entry.thinkBuf; entry.thinkBuf = "";
    mutateAssistant(entry, (m) => ({
      ...m,
      content: t ? m.content + t : m.content,
      thinking: k ? (m.thinking ?? "") + k : m.thinking,
    }));
  };

  const scheduleFlush = () => {
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(flushBuffers, FLUSH_MS);
  };

  const handler = (e: StreamEvent) => {
    switch (e.type) {
      case "text":
        entry.textBuf += e.chunk;
        scheduleFlush();
        return;
      case "finalText": {
        flushBuffers();
        // Mirrors the React handler: only adopt the SDK's final result
        // text when nothing arrived as deltas this turn.
        mutateAssistant(entry, (m) => (m.content ? m : { ...m, content: e.chunk }));
        return;
      }
      case "thinking":
        entry.thinkBuf += e.chunk;
        scheduleFlush();
        return;
      case "tool":
        flushBuffers();
        mutateAssistant(entry, (m) => ({ ...m, tools: [...m.tools, e.tool] }));
        return;
      case "toolResult":
        // Attach the tool's response text to the matching ToolCall in the
        // persisted message so reloads see the same expand-to-context UI
        // the live UI shows.
        flushBuffers();
        mutateAssistant(entry, (m) => ({
          ...m,
          tools: m.tools.map((t) =>
            t.id === e.id ? { ...t, result: e.content, isError: e.isError } : t,
          ),
        }));
        return;
      case "turnId":
        mutateAssistant(entry, (m) => ({ ...m, turnId: e.turnId }));
        return;
      case "error":
        flushBuffers();
        mutateAssistant(entry, (m) => ({ ...m, error: e.message }));
        return;
      case "done": {
        flushBuffers();
        mutateAssistant(entry, (m) => {
          // Mirror the React handler's "synthesize a fallback content"
          // logic so a refresh sees the same final shape regardless of
          // whether React or shadow finalised the bubble.
          if (!m.content && !m.error && m.tools.length > 0) {
            const files = uniqueFiles(m.tools);
            const summary = files.length > 0
              ? `Made ${m.tools.length} tool call${m.tools.length === 1 ? "" : "s"}, touching: ${files.join(", ")}.`
              : `Made ${m.tools.length} tool call${m.tools.length === 1 ? "" : "s"}.`;
            return { ...m, content: summary, pending: false };
          }
          if (!m.content && !m.error) {
            return { ...m, error: "No reply received from AI (process exited without output).", pending: false };
          }
          return { ...m, pending: false };
        });
        detachStream(streamId);
        return;
      }
      // Elicit / elicitClear / usage are visual-only or session-scoped;
      // the React handler already records them in module state. We don't
      // need to mirror them into the persisted archive here.
      default:
        return;
    }
  };

  entry.handler = handler;
  // Attempt a late subscribe in case startStream registered the entry
  // already (e.g. retry path uses the stored streamId from a prior
  // turn). subscribeStream is a no-op when the stream isn't yet
  // registered — the caller is expected to also pass `handler` to
  // startStream's `listeners` array, which handles the not-yet-running
  // case. Calling both is idempotent because chatStream stores
  // listeners in a Set.
  entry.unsub = subscribeStream(streamId, handler);
  tracked.set(streamId, entry);
  return handler;
}

export function detachStream(streamId: string): void {
  const entry = tracked.get(streamId);
  if (!entry) return;
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  try { entry.unsub(); } catch { /* ignore */ }
  tracked.delete(streamId);
}

/* ─── internals ─────────────────────────────────────────────────── */

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

/** Apply a mutation to the assistant message at `entry.msgIdx` in the
 *  cached archive, then schedule a save. The archive read here is the
 *  same in-memory cache the React component reads via libLoadThreads, so
 *  cross-project state stays consistent. */
function mutateAssistant(
  entry: Tracked,
  mut: (m: AssistantMessage) => AssistantMessage,
): void {
  const archive = libLoadThreads(entry.projectId);
  const threadIdx = archive.threads.findIndex((t) => t.id === entry.threadId);
  if (threadIdx === -1) return; // thread was deleted while we were attached
  const thread = archive.threads[threadIdx];
  const m = thread.messages[entry.msgIdx];
  if (!m || m.role !== "assistant") return;
  const next = mut(m);
  if (next === m) return;
  const messages = thread.messages.slice();
  messages[entry.msgIdx] = next;
  const nextThread: ChatThread = { ...thread, messages };
  const threads = archive.threads.slice();
  threads[threadIdx] = nextThread;
  const nextArchive: ThreadArchive = { threads, activeId: archive.activeId };
  saveThreads(entry.projectId, nextArchive);
}

/** Same shape the Editor uses to summarize tool-only turns. Duplicated
 *  here (instead of imported) to keep this module independent of React. */
function uniqueFiles(tools: AssistantMessage["tools"]): string[] {
  const seen = new Set<string>();
  for (const t of tools) {
    const idx = t.label.indexOf("·");
    if (idx === -1) continue;
    const file = t.label.slice(idx + 1).trim();
    if (file) seen.add(file);
  }
  return Array.from(seen);
}
