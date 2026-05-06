/* projectStore.ts — accessor for per-project sandbox content.
 *
 * Today this is filesystem-backed (PROJECTS_ROOT/<id>/). Tomorrow it
 * could become object-storage-backed by replacing this module — every
 * caller goes through `projectDirOf()` and `readProjectManifest()`. */

import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { ENV } from "../env.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;

/** Resolve a project id to its absolute directory under PROJECTS_ROOT.
 *  Returns null for invalid ids or any traversal escape. */
export function projectDirOf(id: string): string | null {
  if (!ID_RE.test(id)) return null;
  const abs = resolvePath(ENV.PROJECTS_ROOT, id);
  if (!abs.startsWith(ENV.PROJECTS_ROOT + "/")) return null;
  return abs;
}

export async function readProjectManifest(id: string): Promise<unknown> {
  const dir = projectDirOf(id);
  if (!dir) return null;
  try {
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

/** Internal URL the API itself is reachable at — used to build URLs we
 *  pass to spawned subprocesses (Playwright, MCP HTTP bridge). The
 *  frontend uses relative paths and goes through the Vite proxy; only
 *  spawned children need the absolute URL. */
export function internalBaseUrl(): string {
  return `http://localhost:${ENV.API_PORT}`;
}
