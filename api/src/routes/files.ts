/* files.ts — legacy editor file browser + tool-image preview proxy.
 *
 * These routes are scoped to LEGACY_EDITOR_ROOT (the SPA repo itself);
 * they're separate from the per-project file routes in projects.ts.
 * Used by the old comment-edit fallback flow when there's no projectId.
 *
 *   GET  /api/files               — list pages/components/folders
 *   POST /api/file/delete         — unlink a file under LEGACY_EDITOR_ROOT
 *   POST /api/file/upload         — write under public/uploads/
 *   GET  /api/tool-image?path=…   — image preview for the chat tool accordion
 *                                    (allowed roots: PROJECTS_ROOT, SCREENSHOT_TMP_ROOT)
 */

import { Hono } from "hono";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative as relPath, resolve as resolvePath, basename } from "node:path";
import { ENV } from "../env.ts";
import { mimeFor, safeStat, safeUnder, parseAnyDataUrl } from "../services/utils.ts";
import { walk } from "../services/snapshots.ts";

const LEGACY = ENV.LEGACY_EDITOR_ROOT;

export type FileEntry = {
  path: string;
  name: string;
  size: number;
  modified: number;
  isPage: boolean;
  route?: string;
};

export type FolderEntry = {
  path: string;
  name: string;
  files: { path: string; name: string; size: number; modified: number; mime: string }[];
};

export type FileTree = {
  pages: FileEntry[];
  components: FileEntry[];
  folders: FolderEntry[];
};

const PAGE_ROUTE_MAP: Record<string, string> = {
  "src/routes/Home.tsx": "/",
  "src/routes/Editor.tsx": "/editor",
  "src/routes/Titling.tsx": "/titling",
  "src/routes/Inspirations.tsx": "/inspirations",
  "src/routes/Slot.tsx": "/ep/01/thumbnail",
};

async function listFolder(absDir: string): Promise<FolderEntry["files"]> {
  const entries: FolderEntry["files"] = [];
  const items = await readdir(absDir, { withFileTypes: true }).catch(() => []);
  for (const it of items) {
    if (!it.isFile()) continue;
    if (it.name.startsWith(".")) continue;
    const abs = join(absDir, it.name);
    const st = await safeStat(abs);
    if (!st) continue;
    entries.push({
      path: relPath(LEGACY, abs),
      name: it.name,
      size: st.size,
      modified: st.mtimeMs,
      mime: mimeFor(it.name),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

async function listProjectFiles(): Promise<FileTree> {
  const pages: FileEntry[] = [];
  const components: FileEntry[] = [];
  const folders: FolderEntry[] = [];

  const routesDir = resolvePath(LEGACY, "src/routes");
  const routeFiles = await readdir(routesDir, { withFileTypes: true }).catch(() => []);
  for (const f of routeFiles) {
    if (!f.isFile() || !/\.tsx$/.test(f.name)) continue;
    const abs = join(routesDir, f.name);
    const rel = relPath(LEGACY, abs);
    const st = await safeStat(abs);
    if (!st) continue;
    pages.push({
      path: rel,
      name: f.name,
      size: st.size,
      modified: st.mtimeMs,
      isPage: true,
      route: PAGE_ROUTE_MAP[rel],
    });
  }
  pages.sort((a, b) => a.name.localeCompare(b.name));

  const componentsDir = resolvePath(LEGACY, "src/components");
  for await (const abs of walk(componentsDir)) {
    if (!/\.(tsx|jsx)$/.test(abs)) continue;
    const st = await safeStat(abs);
    if (!st) continue;
    components.push({
      path: relPath(LEGACY, abs),
      name: basename(abs),
      size: st.size,
      modified: st.mtimeMs,
      isPage: false,
    });
  }
  components.sort((a, b) => a.name.localeCompare(b.name));

  const bgDir = resolvePath(LEGACY, "public/bg");
  if (await safeStat(bgDir)) {
    folders.push({ path: "public/bg", name: "bg", files: await listFolder(bgDir) });
  }
  const uploadsDir = resolvePath(LEGACY, "public/uploads");
  await mkdir(uploadsDir, { recursive: true }).catch(() => {});
  folders.push({ path: "public/uploads", name: "uploads", files: await listFolder(uploadsDir) });

  return { pages, components, folders };
}

export const filesRoutes = new Hono();

// GET /api/tool-image — single image for the chat-sidebar tool accordion
// preview. Strict allow-list: only images under the project sandboxes
// (PROJECTS_ROOT) or the per-project diagnostic screenshot dirs
// (SCREENSHOT_TMP_ROOT). Anything else 403s.
filesRoutes.get("/api/tool-image", async (c) => {
  const raw = c.req.query("path") ?? "";
  const abs = resolvePath(raw);
  const allowedRoots = [ENV.PROJECTS_ROOT, ENV.SCREENSHOT_TMP_ROOT];
  const inside = allowedRoots.some((root) => abs === root || abs.startsWith(root + "/"));
  const mime = mimeFor(abs);
  if (!inside || !mime.startsWith("image/")) {
    return c.text("Forbidden", 403);
  }
  try {
    const buf = await readFile(abs);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "content-type": mime,
        "cache-control": "private, max-age=60",
      },
    });
  } catch {
    return c.text("Not found", 404);
  }
});

filesRoutes.get("/api/files", async (c) => {
  try {
    const tree = await listProjectFiles();
    return c.json(tree);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

filesRoutes.post("/api/file/delete", async (c) => {
  let body: { path?: string };
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  const safe = safeUnder(LEGACY, body.path ?? "");
  if (!safe) return c.json({ error: "Invalid path" }, 400);
  try {
    await unlink(safe);
    return c.json({ deleted: relPath(LEGACY, safe) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// POST /api/file/upload — write a binary file. Restricted to
// public/uploads/ to keep the blast radius small.
filesRoutes.post("/api/file/upload", async (c) => {
  let body: { path?: string; dataUrl?: string };
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  const safe = safeUnder(LEGACY, body.path ?? "", { mustExist: false });
  const parsed = body.dataUrl ? parseAnyDataUrl(body.dataUrl) : null;
  if (!safe || !parsed) return c.json({ error: "Invalid path or data URL" }, 400);
  const allowedRoot = resolvePath(LEGACY, "public/uploads");
  if (!safe.startsWith(allowedRoot + "/") && safe !== allowedRoot) {
    return c.json({ error: "Uploads must land under web/public/uploads/" }, 400);
  }
  try {
    await mkdir(dirname(safe), { recursive: true });
    await writeFile(safe, Buffer.from(parsed.data, "base64"));
    const st = await stat(safe);
    return c.json({ path: relPath(LEGACY, safe), size: st.size });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
