/* shared.ts — workspace-wide shared blobs + SSE event channel.
 *
 *   GET  /api/__shared-events  → SSE stream emitting `data: <key>` on writes
 *   GET  /api/shared/:key      → JSON blob, ETag-aware
 *   PATCH /api/shared/:key     → write blob (atomic), broadcasts the key
 *
 * Used by lib/projects (the "what projects exist" list) and
 * lib/sharedAssets (workspace-wide colors/lotties/components library).
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { ENV } from "../env.ts";
import { broadcastShared, sharedEvents } from "../services/sseChannels.ts";

const META_KEY_RE = /^[a-zA-Z0-9_-]+$/;

function sharedDataPath(key: string): string | null {
  if (!META_KEY_RE.test(key)) return null;
  return resolvePath(ENV.SHARED_ROOT, `${key}.json`);
}

function etagFromMtime(mtimeMs: number): string {
  return `W/"${Math.floor(mtimeMs).toString(36)}"`;
}

export const sharedRoutes = new Hono();

sharedRoutes.get("/api/__shared-events", (c) => {
  return streamSSE(c, async (stream) => {
    const sub = (key: string) => {
      stream.writeSSE({ data: key }).catch(() => { /* aborted */ });
    };
    sharedEvents.on("event", sub);
    stream.onAbort(() => sharedEvents.off("event", sub));
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
  const path = sharedDataPath(key);
  if (!path) return c.json({ error: "Invalid shared key" }, 400);
  try {
    const st = await stat(path);
    const etag = etagFromMtime(st.mtimeMs);
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    const raw = await readFile(path, "utf8");
    return new Response(raw, {
      status: 200,
      headers: { "content-type": "application/json", etag },
    });
  } catch {
    return c.json({ error: "No shared blob" }, 404);
  }
});

sharedRoutes.patch("/api/shared/:key", async (c) => {
  const key = c.req.param("key");
  const path = sharedDataPath(key);
  if (!path) return c.json({ error: "Invalid shared key" }, 400);
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const ifMatch = c.req.header("if-match");
  if (ifMatch) {
    const cur = await stat(path).catch(() => null);
    const curEtag = cur ? etagFromMtime(cur.mtimeMs) : null;
    if (curEtag !== ifMatch) {
      return c.json(
        { error: "ETag mismatch — refetch and retry", current_etag: curEtag },
        412,
      );
    }
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, path);
    const st = await stat(path);
    const etag = etagFromMtime(st.mtimeMs);
    broadcastShared(key);
    return new Response(JSON.stringify({ ok: true, etag }), {
      status: 200,
      headers: { "content-type": "application/json", etag },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
