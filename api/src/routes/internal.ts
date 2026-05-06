/* internal.ts — endpoints used only by spawned subprocesses (MCP servers,
 * etc.). Should never be exposed beyond localhost in prod. */

import { Hono } from "hono";
import { getCurrentStreamForWorker } from "../services/kimiWorkerPool.ts";

export const internalRoutes = new Hono();

/** Look up the current turn's streamId for a kimi worker. Used by
 *  mcp/ask-user-http-server.mjs (pool mode) so each tool call dispatches
 *  to the right SSE stream even though the MCP server's env was set at
 *  worker spawn time (potentially many turns ago). */
internalRoutes.get("/api/_internal/current-stream/:workerKey", (c) => {
  const key = c.req.param("workerKey");
  const streamId = getCurrentStreamForWorker(key);
  if (!streamId) return c.json({ error: "No active turn for that workerKey" }, 404);
  return c.json({ streamId });
});
