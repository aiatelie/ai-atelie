/* runRegistry.ts — live registry of in-flight comment-edit POSTs.
 *
 * Keyed by streamId so multiple concurrent runs (multiple tabs / multi-
 * project) coexist cleanly. Exposed via /api/_debug/runs for diagnosis
 * when the user reports "stuck" — we can see exactly what's running and
 * for how long.
 *
 * Pinned to globalThis so a `bun --hot` module reload doesn't lose the
 * record of in-flight runs: if a saved file triggers a reload mid-turn,
 * the new module instance still sees the abort controller of the
 * previous turn and we can clean up via dispose hooks. Without this
 * pinning, every hot reload silently orphans every in-flight kimi/claude
 * subprocess.
 *
 * --- Replay buffer (added for "stream survives reload") ---
 * Each ActiveRun also holds an indexed event buffer + a set of tailers.
 * `appendBufferedEvent` is called by commentEdit.ts on every `send()`
 * so a reloaded client can connect to GET /api/comment-edit/replay/:id
 * and stream the missed events in order, then tail live. The buffer is
 * bounded (RING_MAX_BYTES) and evicts oldest text first to preserve
 * tool envelopes (a `tool` event without its `toolResult` is unhelpful).
 * After the run completes the entry sticks around for BUFFER_GC_MS so a
 * slow reload still sees the terminal frames. The grace timer is the
 * abort policy: when the original client disconnects we wait
 * GRACE_DISCONNECT_MS for a resume before actually aborting the SDK.
 */

/** Per-stream tunables. Picked for typical 5-minute Anthropic turns:
 *  - RING_MAX_BYTES holds enough for ~3000 text chunks plus a handful of
 *    tool envelopes; the keep-tool eviction policy prevents an orphan-
 *    chip UI on resume.
 *  - GRACE_DISCONNECT_MS at 2 minutes covers a Vite full reload, a slow
 *    laptop wake-from-suspend, or a brief network blip — and caps
 *    Anthropic exposure on a closed-tab-and-forget at ~120s of streaming
 *    after the user is gone.
 *  - BUFFER_GC_MS is the post-done retention for very-slow reloads;
 *    cheap to keep around since the SDK call is already finished. */
export const GRACE_DISCONNECT_MS = 120_000;
export const BUFFER_GC_MS = 60_000;
export const RING_MAX_BYTES = 512 * 1024;
export const RUNTIME_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type BufferedEvent = {
  /** Monotonic per-stream index, starting at 0. The wire SSE `id:`
   *  field carries this so a resuming client can request fromIndex=N+1. */
  eventIndex: number;
  event: string;
  data: string;
};

export type Tailer = (ev: BufferedEvent) => void;

export type ActiveRun = {
  startedAt: number;
  projectId?: string;
  abort: AbortController;
  /** Optional log file path (set by routes that wire runLogger). */
  logPath?: string;
  /** Trace id (request-id header). */
  requestId?: string;
  /** Append-only ring of events sent on the original SSE connection.
   *  Replayed in order by the resume endpoint. Bounded by RING_MAX_BYTES. */
  buffer: BufferedEvent[];
  /** Running byte total of `buffer`, used by the eviction policy. */
  bufferBytes: number;
  /** Next eventIndex to assign. Equals buffer.length + evictedCount. */
  nextIndex: number;
  /** Subscribers attached AFTER the original connection — i.e. resumed
   *  clients. Receives every event after their replay flush completes. */
  tailers: Set<Tailer>;
  /** Pending grace-period abort timer. Set when no live subscribers
   *  remain (original socket closed, no tailer attached); cleared on
   *  reattach. Fires the SDK abort if no client returns in time. */
  graceTimer?: ReturnType<typeof setTimeout>;
  /** When the run finished (terminal `done` or fatal error). After this
   *  the entry lingers BUFFER_GC_MS to serve slow reloads. */
  finishedAt?: number;
  terminal?: "done" | "error";
  /** Scheduled GC for the buffered entry post-`finishedAt`. */
  gcTimer?: ReturnType<typeof setTimeout>;
  /** When set true by an explicit client Stop request (POST /abort/:id),
   *  the grace timer is bypassed and the SDK aborts immediately. */
  bypassGrace?: boolean;
};

/** Symbol-keyed slot on globalThis: shared across hot-reloaded module
 *  instances so neither the existing runs nor the spawned-child PIDs
 *  get lost when api/src/* is edited. */
const KEY = Symbol.for("ai-atelie.runRegistry");
type Slot = {
  activeRuns: Map<string, ActiveRun>;
  childPids: Set<number>;
  /** Running total of all buffer bytes across every entry; gates the
   *  RUNTIME_MAX_BUFFER_BYTES cap so we can't accumulate unbounded
   *  history during a swarm of long-running concurrent turns. */
  totalBufferBytes: { v: number };
};
function getSlot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  if (!g[KEY]) {
    g[KEY] = { activeRuns: new Map(), childPids: new Set(), totalBufferBytes: { v: 0 } };
  }
  // Old slots from before the buffer fields existed: backfill so the
  // hot-reload upgrade path doesn't TypeError on `.totalBufferBytes`.
  const slot = g[KEY]!;
  if (!slot.totalBufferBytes) slot.totalBufferBytes = { v: 0 };
  return slot;
}

/** In-flight comment-edit runs, keyed by streamId. */
export const activeRuns: Map<string, ActiveRun> = getSlot().activeRuns;

/** Spawned subprocess PIDs (kimi, claude SDK's child, MCP servers, etc).
 *  Drivers register their child here so the dispose hook in index.ts can
 *  SIGTERM survivors on hot reload or graceful shutdown. */
export const childPids: Set<number> = getSlot().childPids;

export function registerChild(pid: number | undefined): void {
  if (typeof pid === "number" && pid > 0) childPids.add(pid);
}

export function unregisterChild(pid: number | undefined): void {
  if (typeof pid === "number") childPids.delete(pid);
}

/** Fire AbortController on every active run; resolves once we've sent
 *  the signal (children may take a moment to actually exit). */
export function abortAllRuns(reason: string): void {
  for (const [id, run] of activeRuns) {
    if (run.graceTimer) { clearTimeout(run.graceTimer); run.graceTimer = undefined; }
    if (run.gcTimer)    { clearTimeout(run.gcTimer);    run.gcTimer = undefined;   }
    if (!run.abort.signal.aborted) {
      try { run.abort.abort(reason); } catch { /* ignore */ }
      console.warn(`[runRegistry] aborted ${id.slice(0, 8)} reason=${reason}`);
    }
  }
}

/** Send SIGTERM to every registered subprocess. Used as the second-stage
 *  hammer in shutdown — abort signals first, then this if anything
 *  didn't notice. */
export function killAllChildren(): void {
  for (const pid of childPids) {
    try { process.kill(pid, "SIGTERM"); }
    catch { /* already gone */ }
  }
}

/* ─── Replay buffer helpers ─────────────────────────────────────── */

/** Initialize the buffer fields on a fresh ActiveRun. Callers building
 *  the run object inline should spread the result, e.g.:
 *
 *      activeRuns.set(id, { ...freshRunCore(), startedAt, abort, ... });
 */
export function freshRunCore(): Pick<ActiveRun, "buffer" | "bufferBytes" | "nextIndex" | "tailers"> {
  return { buffer: [], bufferBytes: 0, nextIndex: 0, tailers: new Set() };
}

/** Append an event to the run's ring buffer, fan it out to every
 *  attached tailer, and run eviction if RING_MAX_BYTES is exceeded.
 *  Returns the assigned eventIndex (used as the SSE `id:` field).
 *  Caller is responsible for actually writing the SSE bytes; this
 *  function only records + fans out. */
export function appendBufferedEvent(streamId: string, event: string, data: string): number | null {
  const run = activeRuns.get(streamId);
  if (!run) return null;
  const eventIndex = run.nextIndex++;
  const ev: BufferedEvent = { eventIndex, event, data };
  const size = data.length + event.length + 32; // ~overhead per record
  run.buffer.push(ev);
  run.bufferBytes += size;
  getSlot().totalBufferBytes.v += size;

  // Per-stream eviction: prefer dropping `text` events (recoverable from
  // the SDK's terminal `finalText`) over tool envelopes (without which
  // a result chip would appear orphaned in the resumed UI).
  while (run.bufferBytes > RING_MAX_BYTES && run.buffer.length > 1) {
    const idx = run.buffer.findIndex((e) => e.event === "agent" && /"type":"text"/.test(e.data));
    const evictAt = idx >= 0 ? idx : 0; // fallback: drop oldest record
    const dropped = run.buffer.splice(evictAt, 1)[0];
    const dropSize = dropped.data.length + dropped.event.length + 32;
    run.bufferBytes -= dropSize;
    getSlot().totalBufferBytes.v -= dropSize;
  }

  // Runtime cap: greedily evict whole finished-stream buffers first.
  if (getSlot().totalBufferBytes.v > RUNTIME_MAX_BUFFER_BYTES) {
    const finishedFirst = [...activeRuns.entries()].sort(
      ([, a], [, b]) => (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity),
    );
    for (const [, victim] of finishedFirst) {
      if (getSlot().totalBufferBytes.v <= RUNTIME_MAX_BUFFER_BYTES) break;
      if (victim === run) continue;
      getSlot().totalBufferBytes.v -= victim.bufferBytes;
      victim.buffer = [];
      victim.bufferBytes = 0;
    }
  }

  for (const t of run.tailers) {
    try { t(ev); } catch { /* a stale tailer shouldn't break dispatch */ }
  }
  return eventIndex;
}

/** Return all buffered events with eventIndex >= fromIndex, in order.
 *  When the requested range straddles an evicted prefix, the caller
 *  sees a gap (lower indices missing) — `chatStream.ts` accumulators
 *  tolerate this for `text`, and our eviction policy keeps `tool`
 *  envelopes anchored. */
export function replaySince(streamId: string, fromIndex: number): BufferedEvent[] {
  const run = activeRuns.get(streamId);
  if (!run) return [];
  if (fromIndex <= 0) return run.buffer.slice();
  return run.buffer.filter((e) => e.eventIndex >= fromIndex);
}

export function attachTailer(streamId: string, fn: Tailer): boolean {
  const run = activeRuns.get(streamId);
  if (!run) return false;
  run.tailers.add(fn);
  cancelGraceAbort(streamId);
  return true;
}

export function detachTailer(streamId: string, fn: Tailer): void {
  const run = activeRuns.get(streamId);
  if (!run) return;
  run.tailers.delete(fn);
}

/** Schedule the SDK abort to fire after `delayMs` UNLESS a tailer
 *  attaches first. Used by the original SSE handler's `onAbort` and
 *  by tailer-detach when no other client remains. */
export function scheduleGraceAbort(streamId: string, delayMs: number, abortFn: () => void): void {
  const run = activeRuns.get(streamId);
  if (!run) return;
  if (run.graceTimer) clearTimeout(run.graceTimer);
  if (run.bypassGrace) {
    abortFn();
    return;
  }
  const t = setTimeout(() => {
    run.graceTimer = undefined;
    if (run.tailers.size > 0) return;       // someone reattached just in time
    if (run.finishedAt) return;              // ran to completion organically
    if (run.abort.signal.aborted) return;    // already aborted by some other path
    abortFn();
  }, delayMs);
  // Don't keep the process alive on this timer alone.
  if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
    (t as unknown as { unref: () => void }).unref();
  }
  run.graceTimer = t;
}

export function cancelGraceAbort(streamId: string): void {
  const run = activeRuns.get(streamId);
  if (!run) return;
  if (run.graceTimer) clearTimeout(run.graceTimer);
  run.graceTimer = undefined;
}

/** Mark the run as terminal and schedule eventual cleanup. Until the
 *  GC fires the entry stays in `activeRuns` so a slow reload can still
 *  pull the buffered final state via the resume endpoint. */
export function markRunFinished(streamId: string, terminal: "done" | "error"): void {
  const run = activeRuns.get(streamId);
  if (!run) return;
  run.finishedAt = Date.now();
  run.terminal = terminal;
  if (run.graceTimer) { clearTimeout(run.graceTimer); run.graceTimer = undefined; }
  if (run.gcTimer) clearTimeout(run.gcTimer);
  const t = setTimeout(() => {
    const r = activeRuns.get(streamId);
    if (!r) return;
    getSlot().totalBufferBytes.v -= r.bufferBytes;
    activeRuns.delete(streamId);
  }, BUFFER_GC_MS);
  if (typeof (t as unknown as { unref?: () => void }).unref === "function") {
    (t as unknown as { unref: () => void }).unref();
  }
  run.gcTimer = t;
}
