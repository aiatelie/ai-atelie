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
 */

export type ActiveRun = {
  startedAt: number;
  projectId?: string;
  abort: AbortController;
  /** Optional log file path (set by routes that wire runLogger). */
  logPath?: string;
  /** Trace id (request-id header). */
  requestId?: string;
};

/** Symbol-keyed slot on globalThis: shared across hot-reloaded module
 *  instances so neither the existing runs nor the spawned-child PIDs
 *  get lost when api/src/* is edited. */
const KEY = Symbol.for("ai-atelie.runRegistry");
type Slot = {
  activeRuns: Map<string, ActiveRun>;
  childPids: Set<number>;
};
function getSlot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  if (!g[KEY]) {
    g[KEY] = { activeRuns: new Map(), childPids: new Set() };
  }
  return g[KEY]!;
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
