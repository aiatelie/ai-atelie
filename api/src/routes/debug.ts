/* debug.ts — GET /api/_debug/runs.
 *
 * Live snapshot of in-flight comment-edit POSTs. Useful when the user
 * thinks "the backend is stuck" — `curl /api/_debug/runs` from a
 * terminal shows which streams are actually running, how long they've
 * been running, which project they belong to. Plain GET, no auth (this
 * is local-dev). Each entry also lists whether its AbortController has
 * been signalled — handy for diagnosing wedges. */

import { Hono } from "hono";
import { activeRuns } from "../services/runRegistry.ts";

export const debugRoutes = new Hono();

debugRoutes.get("/api/_debug/runs", (c) => {
  const now = Date.now();
  const out = Array.from(activeRuns.entries()).map(([streamId, run]) => ({
    streamId: streamId.slice(0, 8),
    projectId: run.projectId ?? null,
    elapsedSec: Math.round((now - run.startedAt) / 1000),
    aborted: run.abort.signal.aborted,
    requestId: run.requestId ?? null,
    logPath: run.logPath ?? null,
  }));
  return c.json({ count: out.length, runs: out });
});
