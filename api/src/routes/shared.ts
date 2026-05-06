/* shared.ts — workspace-wide shared blobs + SSE event channel.
 *
 *   GET  /api/__shared-events  → SSE stream emitting `data: <key>` on writes
 *   GET  /api/shared/:key      → JSON blob, ETag-aware
 *   PATCH /api/shared/:key     → write blob (atomic), broadcasts the key
 *
 * Used by lib/projects (the "what projects exist" list) and
 * lib/sharedAssets (workspace-wide colors/lotties/components library).
 *
 * Storage goes through SharedRepo. The SSE channel multiplexes two
 * event sources:
 *   • the JsonKv driver event (fired automatically on every PATCH)
 *   • the `sharedEvents` workspace bus (used for non-kv signals like
 *     "projects index changed" emitted from project lifecycle routes)
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sharedEvents } from "../services/sseChannels.ts";
import { getRepos, SharedRepo } from "../storage/repos/index.ts";

export const sharedRoutes = new Hono();

sharedRoutes.get("/api/__shared-events", (c) => {
  return streamSSE(c, async (stream) => {
    const writeEvent = (key: string) => {
      stream.writeSSE({ data: key }).catch(() => { /* aborted */ });
    };
    // Driver-level kv changes — PATCHes auto-fire these via the repo.
    const unsubKv = getRepos().shared.subscribe(writeEvent);
    // Workspace-bus signals — project create/delete still emit to this.
    sharedEvents.on("event", writeEvent);
    stream.onAbort(() => {
      unsubKv();
      sharedEvents.off("event", writeEvent);
    });
    await stream.writeSSE({ data: "", event: "connected" }).catch(() => { /* aborted */ });
    while (!stream.aborted) {
      await stream.sleep(25_000);
      // SSE comment for keepalive; clients ignore lines starting with `:`.
      try { await stream.write(":keepalive\n\n"); }
      catch { break; }
    }
  });
});

sharedRoutes.get("/api/shared/:key", async (c) => {
  const key = c.req.param("key");
  if (!SharedRepo.isValidKey(key)) {
    return c.json({ error: "Invalid shared key" }, 400);
  }
  const result = await getRepos().shared.get(key);
  if (!result.ok) {
    return c.json({ error: "No shared blob" }, 404);
  }
  if (c.req.header("if-none-match") === result.etag) {
    return new Response(null, { status: 304, headers: { etag: result.etag } });
  }
  return new Response(JSON.stringify(result.value), {
    status: 200,
    headers: { "content-type": "application/json", etag: result.etag },
  });
});

sharedRoutes.patch("/api/shared/:key", async (c) => {
  const key = c.req.param("key");
  if (!SharedRepo.isValidKey(key)) {
    return c.json({ error: "Invalid shared key" }, 400);
  }
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }

  const ifMatch = c.req.header("if-match") ?? undefined;
  try {
    const result = await getRepos().shared.put(key, body, ifMatch ? { ifMatch } : undefined);
    if (!result.ok) {
      return c.json(
        { error: "ETag mismatch — refetch and retry", current_etag: result.currentEtag },
        412,
      );
    }
    return new Response(JSON.stringify({ ok: true, etag: result.etag }), {
      status: 200,
      headers: { "content-type": "application/json", etag: result.etag },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
