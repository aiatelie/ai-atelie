/* projects.ts — per-project sandbox content + project CRUD.
 *
 * Two surfaces:
 *
 *  • /p/:id/* — static file serve from PROJECTS_ROOT/<id>/. HTML responses
 *    get a tiny SSE-driven reload script injected so iframes refresh when
 *    the AI rewrites a file. /p/:id/__reload is the SSE channel itself.
 *
 *  • /api/projects/* — REST: create, manifest read/patch, files list,
 *    upload, delete, recursive project delete, tweak edits, inspector
 *    CSS, per-project meta blobs + SSE event channel.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative as relPath, resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { ENV } from "../env.ts";
import { projectDirOf } from "../services/projectStore.ts";
import { parseAnyDataUrl } from "../services/utils.ts";
import {
  broadcastMeta,
  broadcastShared,
  destroyMetaChannel,
  destroyReloadChannel,
  getMetaEmitter,
  getOrCreateReloadChannel,
} from "../services/sseChannels.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const META_KEY_RE = /^[a-zA-Z0-9_-]+$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".jsx":  "text/javascript; charset=utf-8",
  ".tsx":  "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".otf":  "font/otf",
  ".mp4":  "video/mp4",
  ".mp3":  "audio/mpeg",
  ".txt":  "text/plain; charset=utf-8",
  ".md":   "text/markdown; charset=utf-8",
};

export type ProjectManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: "sandbox";
  createdAt: number;
  updatedAt: number;
  pages: Array<{ file: string; label: string; title?: string }>;
  components?: Array<{ file: string; name: string }>;
  entry: string;
};

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

/** Resolve a project-relative path; null if invalid or escapes the dir. */
export function safeProjectFilePath(id: string, rel: string): string | null {
  if (!ID_RE.test(id)) return null;
  if (typeof rel !== "string" || rel.includes("\0")) return null;
  const projectDir = projectDirOf(id);
  if (!projectDir) return null;
  const cleaned = rel.replace(/^\/+/, "");
  const abs = resolvePath(projectDir, cleaned);
  if (!isInside(projectDir, abs)) return null;
  return abs;
}

function projectMetaPath(id: string, key: string): string | null {
  if (!ID_RE.test(id) || !META_KEY_RE.test(key)) return null;
  const projectDir = projectDirOf(id);
  if (!projectDir) return null;
  return resolvePath(projectDir, ".meta", `${key}.json`);
}

function etagFromMtime(mtimeMs: number): string {
  return `W/"${Math.floor(mtimeMs).toString(36)}"`;
}

/* ─── Manifest IO ─── */

async function readManifest(id: string): Promise<ProjectManifest | null> {
  const p = safeProjectFilePath(id, "manifest.json");
  if (!p) return null;
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as ProjectManifest;
  } catch { return null; }
}

async function writeManifest(id: string, m: ProjectManifest): Promise<void> {
  const p = safeProjectFilePath(id, "manifest.json");
  if (!p) throw new Error("Invalid project id");
  await mkdir(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  await writeFile(tmp, JSON.stringify(m, null, 2), "utf8");
  await rename(tmp, p);
}

/* ─── Listing all projects ─── */

async function listAllProjects(): Promise<Array<{
  id: string; name: string; createdAt: number; updatedAt: number;
  pages: ProjectManifest["pages"];
}>> {
  const out: Array<{ id: string; name: string; createdAt: number; updatedAt: number; pages: ProjectManifest["pages"] }> = [];
  const entries = await readdir(ENV.PROJECTS_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const manifest = await readManifest(entry.name);
    if (!manifest) continue;
    out.push({
      id: manifest.id,
      name: manifest.name,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      pages: manifest.pages,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/* ─── Reload-script injection (HTML responses get this appended) ─── */

function injectReloadClient(html: string, id: string): string {
  const snippet = `
<script>(function(){try{
  var K="__cc_scroll";
  try {
    var r = sessionStorage.getItem(K);
    if (r) {
      sessionStorage.removeItem(K);
      var p = JSON.parse(r);
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){ window.scrollTo(p[0]||0, p[1]||0); });
      });
    }
  } catch(e){}
  var es = new EventSource("/p/${id}/__reload");
  es.onmessage = function(){
    try { sessionStorage.setItem(K, JSON.stringify([window.scrollX||0, window.scrollY||0])); } catch(e){}
    location.reload();
  };
}catch(e){}})();</script>
`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, snippet + "</body>");
  return html + snippet;
}

/* ─── Synthetic component preview ─── */

const REACT_CDN = "https://unpkg.com/react@18.3.1/umd/react.development.js";
const REACT_DOM_CDN = "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js";
const BABEL_CDN = "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js";

function previewHtml(id: string, file: string, name: string): string {
  const safeName = name.replace(/[^A-Za-z0-9_$]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Preview · ${safeName}</title>
<link rel="stylesheet" href="/p/${id}/style.css" onerror="this.remove()" />
<script src="${REACT_CDN}"></script>
<script src="${REACT_DOM_CDN}"></script>
<script src="${BABEL_CDN}"></script>
<script type="text/babel" src="/p/${id}/${file}"></script>
<style>
  html, body { margin: 0; padding: 0; min-height: 100vh; background: #f1ede2; color: #29261b; font-family: ui-sans-serif, system-ui, sans-serif; }
  #root { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px; }
  .__preview-empty { color: rgba(0,0,0,0.5); text-align: center; max-width: 480px; line-height: 1.5; font-size: 13px; }
  .__preview-empty code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
  .__preview-banner { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.7); color: #fff; font-size: 11px; padding: 4px 10px; border-radius: 999px; letter-spacing: 0.06em; text-transform: uppercase; pointer-events: none; }
</style>
</head>
<body>
<div class="__preview-banner">Preview · ${safeName}</div>
<div id="root"></div>
<script type="text/babel">
  (function(){
    var C = window.${safeName};
    var target = document.getElementById("root");
    if (typeof C === "function") {
      ReactDOM.createRoot(target).render(React.createElement(C));
    } else {
      target.innerHTML = '<div class="__preview-empty">Component <code>${safeName}</code> isn\\'t exposed as a global yet. Add <code>window.${safeName} = ${safeName};</code> at the bottom of <code>${file}</code>.</div>';
    }
  })();
</script>
</body>
</html>
`;
}

/* ─── File listing inside a project ─── */

const SKIP_DIRS = new Set(["node_modules", ".git"]);

async function* walkProject(absDir: string): AsyncGenerator<string> {
  const items = await readdir(absDir, { withFileTypes: true }).catch(() => []);
  for (const it of items) {
    if (it.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(it.name)) continue;
    const abs = join(absDir, it.name);
    if (it.isDirectory()) yield* walkProject(abs);
    else if (it.isFile()) yield abs;
  }
}

export type SandboxFileEntry = {
  path: string;
  name: string;
  size: number;
  modified: number;
  kind: "page" | "component" | "asset" | "config";
};

async function listProjectFiles(id: string): Promise<{ files: SandboxFileEntry[] }> {
  const projectDir = projectDirOf(id);
  if (!projectDir) throw new Error("Invalid project id");
  const files: SandboxFileEntry[] = [];
  for await (const abs of walkProject(projectDir)) {
    const rel = relPath(projectDir, abs);
    if (rel === "manifest.json") continue;
    const st = await stat(abs).catch(() => null);
    if (!st) continue;
    const ext = extname(abs).toLowerCase();
    let kind: SandboxFileEntry["kind"] = "asset";
    if (ext === ".html" || ext === ".htm") kind = "page";
    else if (ext === ".jsx" || ext === ".tsx") kind = "component";
    else if (ext === ".css" || ext === ".js" || ext === ".mjs" || ext === ".json") kind = "config";
    files.push({ path: rel, name: basename(abs), size: st.size, modified: st.mtimeMs, kind });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

/* ─── Scaffold + delete ─── */

function newProjectId(): string {
  return "p_" + randomBytes(4).toString("hex");
}

const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__NAME__</title>
<link rel="stylesheet" href="style.css" />

<script src="${REACT_CDN}"></script>
<script src="${REACT_DOM_CDN}"></script>
<script src="${BABEL_CDN}"></script>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement("div", { style: { padding: 48, fontFamily: "ui-sans-serif, system-ui, sans-serif" } },
      React.createElement("h1", null, "__NAME__"),
      React.createElement("p", null, "Empty canvas. Tell the AI what to build.")
    )
  );
</script>
</body>
</html>
`;

const STARTER_CSS = `/* __NAME__ — base styles. Edit freely. */
:root {
  --primary: #d97757;
  --cream: #f1ede2;
  --ink: #29261b;
}
html, body { margin: 0; padding: 0; background: var(--cream); color: var(--ink); font-family: ui-sans-serif, system-ui, sans-serif; }
`;

async function scaffoldProject(id: string, name: string): Promise<ProjectManifest> {
  const projectDir = projectDirOf(id);
  if (!projectDir) throw new Error("Invalid project id");
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(projectDir, "uploads"), { recursive: true });
  const now = Date.now();
  const manifest: ProjectManifest = {
    schemaVersion: 1,
    id,
    name,
    kind: "sandbox",
    createdAt: now,
    updatedAt: now,
    pages: [{ file: "index.html", label: "index.html", title: name }],
    components: [],
    entry: "index.html",
  };
  await writeFile(join(projectDir, "index.html"), STARTER_HTML.replace(/__NAME__/g, name), "utf8");
  await writeFile(join(projectDir, "style.css"), STARTER_CSS.replace(/__NAME__/g, name), "utf8");
  await writeManifest(id, manifest);
  return manifest;
}

async function deleteProjectDir(id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("Invalid project id");
  const projectDir = projectDirOf(id);
  if (!projectDir || projectDir === ENV.PROJECTS_ROOT) {
    throw new Error("Refusing to delete outside projects/");
  }
  // Tear down channels first so we don't get reload events for our own deletes.
  destroyReloadChannel(id);
  destroyMetaChannel(id);
  await rm(projectDir, { recursive: true, force: true });
}

/* ─── Routes ─── */

export const projectsRoutes = new Hono();

projectsRoutes.get("/api/projects", async (c) => {
  try { return c.json(await listAllProjects()); }
  catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 500); }
});

projectsRoutes.post("/api/projects/create", async (c) => {
  let body: { name?: string; id?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const name = (body.name ?? "Untitled").trim() || "Untitled";
  const id = body.id && ID_RE.test(body.id) ? body.id : newProjectId();
  try {
    const manifest = await scaffoldProject(id, name);
    broadcastShared("projects");
    return c.json({ id, manifest });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// All per-project endpoints require an existing project dir.
async function requireProject(id: string): Promise<string | null> {
  const dir = projectDirOf(id);
  if (!dir) return null;
  const exists = await stat(dir).then(() => true).catch(() => false);
  return exists ? dir : null;
}

projectsRoutes.get("/api/projects/:id/manifest", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  const manifest = await readManifest(id);
  if (!manifest) return c.json({ error: "No manifest" }, 404);
  return c.json(manifest);
});

projectsRoutes.patch("/api/projects/:id/manifest", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  let patch: Partial<ProjectManifest>;
  try { patch = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const cur = await readManifest(id);
  if (!cur) return c.json({ error: "No manifest" }, 404);
  const next: ProjectManifest = { ...cur, ...patch, id, kind: "sandbox", updatedAt: Date.now() };
  try {
    await writeManifest(id, next);
    broadcastShared("projects");
    return c.json(next);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.get("/api/projects/:id/__meta-events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const emitter = getMetaEmitter(id);
    const sub = (key: string) => {
      stream.writeSSE({ data: key }).catch(() => { /* aborted */ });
    };
    emitter.on("event", sub);
    stream.onAbort(() => emitter.off("event", sub));
    await stream.writeSSE({ data: "", event: "connected" }).catch(() => { /* aborted */ });
    while (!stream.aborted) {
      await stream.sleep(25_000);
      try { await stream.write(":keepalive\n\n"); } catch { break; }
    }
  });
});

projectsRoutes.get("/api/projects/:id/meta/:key", async (c) => {
  const { id, key } = c.req.param();
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  const path = projectMetaPath(id, key);
  if (!path) return c.json({ error: "Invalid meta key" }, 400);
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
    return c.json({ error: "No meta blob" }, 404);
  }
});

projectsRoutes.patch("/api/projects/:id/meta/:key", async (c) => {
  const { id, key } = c.req.param();
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  const path = projectMetaPath(id, key);
  if (!path) return c.json({ error: "Invalid meta key" }, 400);
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const ifMatch = c.req.header("if-match");
  if (ifMatch) {
    const cur = await stat(path).catch(() => null);
    const curEtag = cur ? etagFromMtime(cur.mtimeMs) : null;
    if (curEtag !== ifMatch) {
      return c.json({ error: "ETag mismatch — refetch and retry", current_etag: curEtag }, 412);
    }
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, path);
    const st = await stat(path);
    const etag = etagFromMtime(st.mtimeMs);
    broadcastMeta(id, key);
    return new Response(JSON.stringify({ ok: true, etag }), {
      status: 200,
      headers: { "content-type": "application/json", etag },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.get("/api/projects/:id/files", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  try { return c.json(await listProjectFiles(id)); }
  catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 500); }
});

projectsRoutes.post("/api/projects/:id/file/upload", async (c) => {
  const id = c.req.param("id");
  const projectDir = await requireProject(id);
  if (!projectDir) return c.json({ error: "Project not found" }, 404);
  let body: { path?: string; dataUrl?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const safe = safeProjectFilePath(id, body.path ?? "");
  const parsed = body.dataUrl ? parseAnyDataUrl(body.dataUrl) : null;
  if (!safe || !parsed) return c.json({ error: "Invalid path or dataUrl" }, 400);
  if (basename(safe) === "manifest.json") return c.json({ error: "Refusing to overwrite manifest.json" }, 400);
  try {
    await mkdir(dirname(safe), { recursive: true });
    const tmp = safe + ".tmp";
    await writeFile(tmp, Buffer.from(parsed.data, "base64"));
    await rename(tmp, safe);
    const st = await stat(safe);
    return c.json({ path: relPath(projectDir, safe), size: st.size });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.post("/api/projects/:id/tweak", async (c) => {
  const id = c.req.param("id");
  const projectDir = await requireProject(id);
  if (!projectDir) return c.json({ error: "Project not found" }, 404);
  let body: { file?: string; edits?: Record<string, unknown> };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const safe = safeProjectFilePath(id, body.file ?? "");
  if (!safe) return c.json({ error: "Invalid path" }, 400);
  if (!body.edits || typeof body.edits !== "object" || Array.isArray(body.edits)) {
    return c.json({ error: "edits must be a plain object" }, 400);
  }
  try {
    const text = await readFile(safe, "utf8");
    const re = /\/\*EDITMODE-BEGIN\*\/\s*([\s\S]*?)\s*\/\*EDITMODE-END\*\//;
    const match = text.match(re);
    if (!match) {
      return c.json({
        error: "No EDITMODE-marked block found in file",
        hint: "The file must contain `/*EDITMODE-BEGIN*/{...}/*EDITMODE-END*/` exactly once.",
      }, 404);
    }
    const beforeJson = match[1];
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(beforeJson); }
    catch (err) {
      return c.json({
        error: "EDITMODE block is not valid JSON",
        detail: err instanceof Error ? err.message : String(err),
      }, 422);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return c.json({ error: "EDITMODE block must be a plain object" }, 422);
    }
    const merged = { ...parsed, ...body.edits };
    const afterJson = JSON.stringify(merged, null, 2);
    const replaced = text.replace(re, `/*EDITMODE-BEGIN*/${afterJson}/*EDITMODE-END*/`);
    if (replaced === text) {
      return c.json({ file: relPath(projectDir, safe), unchanged: true });
    }
    const tmp = safe + ".tmp";
    await writeFile(tmp, replaced, "utf8");
    await rename(tmp, safe);
    return c.json({ file: relPath(projectDir, safe), before: parsed, after: merged });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.post("/api/projects/:id/inspector-css", async (c) => {
  const id = c.req.param("id");
  const projectDir = await requireProject(id);
  if (!projectDir) return c.json({ error: "Project not found" }, 404);
  let body: { route?: string; edits?: Record<string, Record<string, string>> };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const route = String(body.route ?? "").trim();
  if (!route) return c.json({ error: "route required" }, 400);
  if (!body.edits || typeof body.edits !== "object" || Array.isArray(body.edits)) {
    return c.json({ error: "edits must be a plain object" }, 400);
  }
  for (const [sel, props] of Object.entries(body.edits)) {
    if (!sel || typeof sel !== "string") return c.json({ error: "selector must be a string" }, 400);
    if (!props || typeof props !== "object" || Array.isArray(props)) {
      return c.json({ error: `edits[${sel}] must be a plain object` }, 400);
    }
    for (const [prop, value] of Object.entries(props)) {
      if (typeof prop !== "string" || typeof value !== "string") {
        return c.json({ error: `edits[${sel}][${prop}] must be string→string` }, 400);
      }
    }
  }
  try {
    const jsonPath = join(projectDir, "_inspector_edits.json");
    let store: Record<string, Record<string, Record<string, string>>> = {};
    const existing = await readFile(jsonPath, "utf8").catch(() => null);
    if (existing) { try { store = JSON.parse(existing); } catch { store = {}; } }
    const slice: Record<string, Record<string, string>> = {};
    for (const [sel, props] of Object.entries(body.edits)) {
      const trimmed: Record<string, string> = {};
      for (const [k, v] of Object.entries(props)) {
        if (v === "" || v == null) continue;
        trimmed[k] = v;
      }
      if (Object.keys(trimmed).length > 0) slice[sel] = trimmed;
    }
    if (Object.keys(slice).length === 0) delete store[route];
    else store[route] = slice;
    const jsonTmp = jsonPath + ".tmp";
    await writeFile(jsonTmp, JSON.stringify(store, null, 2), "utf8");
    await rename(jsonTmp, jsonPath);
    const cssLines: string[] = [
      "/* AUTO-GENERATED by the editor's Inspector → Save action.",
      " * Edit by hand at your own risk; the next Save will overwrite.",
      " * Source: _inspector_edits.json */",
      "",
    ];
    let ruleCount = 0;
    for (const [r, sels] of Object.entries(store)) {
      const selEntries = Object.entries(sels);
      if (selEntries.length === 0) continue;
      cssLines.push(`/* ─── route: ${r} ─── */`);
      for (const [sel, props] of selEntries) {
        const propEntries = Object.entries(props);
        if (propEntries.length === 0) continue;
        ruleCount += 1;
        cssLines.push(`${sel} {`);
        for (const [k, v] of propEntries) {
          cssLines.push(`  ${k}: ${v} !important;`);
        }
        cssLines.push(`}`);
      }
      cssLines.push("");
    }
    const cssPath = join(projectDir, "_inspector_edits.css");
    const cssTmp = cssPath + ".tmp";
    await writeFile(cssTmp, cssLines.join("\n"), "utf8");
    await rename(cssTmp, cssPath);
    return c.json({
      rules: ruleCount,
      css_path: relPath(projectDir, cssPath),
      json_path: relPath(projectDir, jsonPath),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.post("/api/projects/:id/file/delete", async (c) => {
  const id = c.req.param("id");
  const projectDir = await requireProject(id);
  if (!projectDir) return c.json({ error: "Project not found" }, 404);
  let body: { path?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const safe = safeProjectFilePath(id, body.path ?? "");
  if (!safe) return c.json({ error: "Invalid path" }, 400);
  if (basename(safe) === "manifest.json") return c.json({ error: "Refusing to delete manifest.json" }, 400);
  try { await unlink(safe); return c.json({ deleted: relPath(projectDir, safe) }); }
  catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 500); }
});

projectsRoutes.delete("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Invalid project id" }, 400);
  try {
    await deleteProjectDir(id);
    broadcastShared("projects");
    return c.json({ deleted: id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/* ─── /p/:id/* — sandbox content serve ─── */

projectsRoutes.get("/p/:id/__reload", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.text("Not found", 404);
  return streamSSE(c, async (stream) => {
    const ch = await getOrCreateReloadChannel(id);
    if (!ch) {
      try { await stream.write(":no-channel\n\n"); } catch { /* ignore */ }
      return;
    }
    const sub = () => { stream.writeSSE({ data: "reload" }).catch(() => { /* aborted */ }); };
    ch.emitter.on("reload", sub);
    stream.onAbort(() => ch.emitter.off("reload", sub));
    await stream.writeSSE({ data: "", event: "connected" }).catch(() => { /* aborted */ });
    while (!stream.aborted) {
      await stream.sleep(25_000);
      try { await stream.write(":keepalive\n\n"); } catch { break; }
    }
  });
});

projectsRoutes.get("/p/:id/_preview/*", async (c) => {
  const id = c.req.param("id");
  // Route param `*` for a wildcard rest-of-path: hono exposes it via
  // c.req.path. Compute the file path manually.
  const prefix = `/p/${id}/_preview/`;
  if (!c.req.path.startsWith(prefix)) return c.text("Not found", 404);
  const fileRaw = c.req.path.slice(prefix.length);
  const file = decodeURIComponent(fileRaw);
  const safe = safeProjectFilePath(id, file);
  if (!safe || !(await stat(safe).then(() => true).catch(() => false))) {
    return c.text("Component not found", 404);
  }
  const compName = basename(file).replace(/\.(jsx|tsx|js|ts)$/, "");
  const html = injectReloadClient(previewHtml(id, file, compName), id);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});

projectsRoutes.get("/p/:id/*", async (c) => {
  const id = c.req.param("id");
  const projectDir = projectDirOf(id);
  if (!projectDir) return c.text("Forbidden", 403);
  const prefix = `/p/${id}`;
  let rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "/";
  try { rest = decodeURIComponent(rest); } catch { /* ignore */ }
  if (rest === "" || rest === "/") {
    rest = "/" + ((await readManifest(id))?.entry ?? "index.html");
  }
  if (rest.endsWith("/")) rest += "index.html";
  const safe = safeProjectFilePath(id, rest);
  if (!safe) return c.text("Forbidden", 403);
  let buf: Buffer;
  try { buf = await readFile(safe); }
  catch { return c.text("Not found", 404); }
  const ext = extname(safe).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  if (ext === ".html" || ext === ".htm") {
    // Ensure the reload channel is ready so the injected script can connect.
    await getOrCreateReloadChannel(id);
    return new Response(injectReloadClient(buf.toString("utf8"), id), {
      status: 200,
      headers: { "content-type": mime, "cache-control": "no-store" },
    });
  }
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { "content-type": mime, "cache-control": "no-store" },
  });
});
