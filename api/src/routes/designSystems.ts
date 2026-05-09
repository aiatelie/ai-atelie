/* designSystems.ts — REST surface for the workspace's Design Systems.
 *
 *   GET    /api/design-systems            → list summaries (no description)
 *   POST   /api/design-systems            → create  ({ name, description })
 *   GET    /api/design-systems/:id        → full record
 *   PUT    /api/design-systems/:id        → update  ({ name?, description?, published? })
 *   DELETE /api/design-systems/:id        → delete
 *   POST   /api/design-systems/:id/publish→ toggle published flag (body: { published })
 *
 * Each successful mutation broadcasts on the workspace SSE bus so other
 * tabs / browsers re-fetch the list. The DS list is exposed under the
 * key "design-systems" (not a SharedRepo blob — it has its own scope).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { broadcastShared } from "../services/sseChannels.ts";
import { DesignSystemRepo, getRepos } from "../storage/repos/index.ts";

export const designSystemsRoutes = new Hono();

// Local helper — keep error responses uniform across handlers without
// each one repeating `c.json({ error }, status)`.
type StatusCode = 400 | 404 | 413 | 500;
function bad(c: Context, reason: string, status: StatusCode = 400) {
  return c.json({ error: reason }, status);
}

/**
 * Surface repo errors from clampName / clampDescription as HTTP 413 so the
 * client can display a meaningful "your content is too large" message instead
 * of a generic 500.  The thrown error carries `code: "PAYLOAD_TOO_LARGE"` and
 * `limit` / `actual` for structured client-side display.
 */
function handleRepoError(c: Context, err: unknown) {
  if (
    err instanceof Error &&
    (err as Error & { code?: string }).code === "PAYLOAD_TOO_LARGE"
  ) {
    const e = err as Error & { limit: number; actual: number };
    return c.json(
      { error: err.message, limit: e.limit, actual: e.actual },
      413 as 413,
    );
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}

designSystemsRoutes.get("/api/design-systems", async (c) => {
  try {
    const list = await getRepos().designSystems.list();
    return c.json(list);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

designSystemsRoutes.post("/api/design-systems", async (c) => {
  let body: { name?: unknown; description?: unknown; id?: unknown };
  try { body = await c.req.json(); }
  catch { return bad(c, "Bad JSON"); }
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return bad(c, "name required");
  }
  if (typeof body.description !== "string") {
    return bad(c, "description required");
  }
  const id = typeof body.id === "string" && body.id.trim().length > 0 ? body.id : undefined;
  if (id !== undefined && !DesignSystemRepo.isValidId(id)) {
    return bad(c, "invalid id");
  }
  try {
    const ds = await getRepos().designSystems.create({
      id,
      name: body.name,
      description: body.description,
    });
    broadcastShared("design-systems");
    return c.json(ds);
  } catch (err) {
    return handleRepoError(c, err);
  }
});

designSystemsRoutes.get("/api/design-systems/:id", async (c) => {
  const id = c.req.param("id");
  if (!DesignSystemRepo.isValidId(id)) return bad(c, "invalid id");
  const ds = await getRepos().designSystems.get(id);
  if (!ds) return bad(c, "Not found", 404);
  return c.json(ds);
});

designSystemsRoutes.put("/api/design-systems/:id", async (c) => {
  const id = c.req.param("id");
  if (!DesignSystemRepo.isValidId(id)) return bad(c, "invalid id");
  let body: { name?: unknown; description?: unknown; published?: unknown };
  try { body = await c.req.json(); }
  catch { return bad(c, "Bad JSON"); }
  const patch: { name?: string; description?: string; published?: boolean } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return bad(c, "name must be a string");
    patch.name = body.name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") return bad(c, "description must be a string");
    patch.description = body.description;
  }
  if (body.published !== undefined) {
    if (typeof body.published !== "boolean") return bad(c, "published must be boolean");
    patch.published = body.published;
  }
  try {
    const ds = await getRepos().designSystems.update(id, patch);
    if (!ds) return bad(c, "Not found", 404);
    broadcastShared("design-systems");
    return c.json(ds);
  } catch (err) {
    return handleRepoError(c, err);
  }
});

designSystemsRoutes.delete("/api/design-systems/:id", async (c) => {
  const id = c.req.param("id");
  if (!DesignSystemRepo.isValidId(id)) return bad(c, "invalid id");
  try {
    const ok = await getRepos().designSystems.delete(id);
    if (!ok) return bad(c, "Not found", 404);
    broadcastShared("design-systems");
    return c.json({ deleted: id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

designSystemsRoutes.post("/api/design-systems/:id/publish", async (c) => {
  const id = c.req.param("id");
  if (!DesignSystemRepo.isValidId(id)) return bad(c, "invalid id");

  // Determine intent from the request body:
  //   • No body (Content-Length: 0 or absent) → toggle current value.
  //   • Valid JSON { published: boolean }     → set explicit value.
  //   • Valid JSON but wrong shape            → 400.
  //   • Malformed JSON (body present, not parseable) → 400.
  const rawText = await c.req.text();
  const hasBody = rawText.trim().length > 0;

  if (!hasBody) {
    // Toggle path: read current value and flip it under the per-DS mutex
    // (the mutex lives in setPublished → update, so concurrent toggles
    // serialize correctly — see DsMutex in the repo).
    const cur = await getRepos().designSystems.get(id);
    if (!cur) return bad(c, "Not found", 404);
    const ds = await getRepos().designSystems.setPublished(id, !cur.published);
    if (!ds) return bad(c, "Not found", 404);
    broadcastShared("design-systems");
    return c.json(ds);
  }

  // Body is present — it must be valid JSON.
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return bad(c, "Malformed JSON body — send an empty body to toggle, or { \"published\": true|false } to set explicitly");
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).published !== "boolean"
  ) {
    return bad(c, "Body must be { \"published\": true } or { \"published\": false }, or omit the body entirely to toggle");
  }

  const published = (body as { published: boolean }).published;
  try {
    const ds = await getRepos().designSystems.setPublished(id, published);
    if (!ds) return bad(c, "Not found", 404);
    broadcastShared("design-systems");
    return c.json(ds);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
