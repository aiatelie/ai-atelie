/* skillsCatalog.ts — GET /api/skills/catalog.
 *
 * Returns the contents of `<SKILLS_DIR>/index.json` so the web client
 * (DesignSystemPanel) can render the toggle list of catalog skills
 * without baking the index into the bundle. The index updates on disk
 * whenever a new skill is added; clients re-fetch on dialog open.
 *
 * This route is read-only. Per-project skill SELECTION (which catalog
 * entries are active for a given project) lives on the project's
 * manifest under `design.active_skills` and is written via the
 * existing PATCH /api/projects/:id/manifest route.
 */

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ENV } from "../env.ts";

export const skillsCatalogRoute = new Hono();

skillsCatalogRoute.get("/api/skills/catalog", async (c) => {
  const indexPath = join(ENV.SKILLS_DIR, "index.json");
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    return c.json(parsed);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "catalog unavailable" },
      500,
    );
  }
});
