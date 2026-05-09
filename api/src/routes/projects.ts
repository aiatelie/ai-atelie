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
 *
 * Storage is mediated through the repos in storage/repos/. This file
 * contains only HTTP-shape: parsing, validation, mime/content-type,
 * reload-script injection, EDITMODE regex.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ENV } from "../env.ts";
import { parseAnyDataUrl } from "../services/utils.ts";
import { broadcastShared } from "../services/sseChannels.ts";
import { getRepos, type ProjectManifest } from "../storage/repos/index.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;

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

// Re-export for downstream that imports the type from this file.
export type { ProjectManifest };

/* ─── Reload-script injection (HTML responses get this appended) ─── */

/* The window.ai.complete() bridge — injected into every artifact HTML
 * so a sandboxed iframe (which can't reach the parent's fetch) can call
 * an LLM at runtime. Provider-neutral: the host routes the call through
 * whatever the project's chat is configured to use (Claude Code, Kimi,
 * OpenCode → any provider OpenCode supports). Artifact code never names
 * a specific vendor.
 *
 * See AGENTS.md → "Runtime AI in artifacts" for the end-to-end story.
 *
 *   1. The artifact calls `await window.ai.complete("hello")`.
 *   2. The bridge generates a unique request id and posts
 *      `{ type: "__ai_complete", id, payload }` to window.parent.
 *   3. The host (web/src/lib/tweakBridge.ts) forwards to
 *      /api/artifacts/complete with the active modelId, and posts back
 *      `{ type: "__ai_complete_response", id, result | error }`.
 *   4. The bridge resolves / rejects the original Promise.
 *
 * `window.claude.complete()` is exposed as an alias so any artifacts
 * already authored against the legacy name keep working. The legacy
 * postMessage type `__claude_complete` is still understood by the host.
 *
 * 30s timeout rejects pending calls so a frozen parent can't leak
 * Promises. Self-contained, idempotent, tiny enough to inline.
 */
const AI_COMPLETE_BRIDGE = `
<script>(function(){
  try {
    if (window.ai && typeof window.ai.complete === "function") return;
    var pending = Object.create(null);
    window.addEventListener("message", function(e){
      var d = e.data;
      if (!d) return;
      // Accept both the canonical and the legacy response type so a
      // host running the older bridge still talks to a newer artifact.
      if (d.type !== "__ai_complete_response" && d.type !== "__claude_complete_response") return;
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.result);
    });
    function complete(promptOrOptions){
      return new Promise(function(resolve, reject){
        var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        pending[id] = { resolve: resolve, reject: reject };
        try {
          window.parent.postMessage({ type: "__ai_complete", id: id, payload: promptOrOptions }, "*");
        } catch (err) {
          delete pending[id];
          reject(err);
          return;
        }
        setTimeout(function(){
          if (pending[id]) {
            delete pending[id];
            reject(new Error("window.ai.complete() timed out after 30s"));
          }
        }, 30000);
      });
    }
    window.ai = { complete: complete };
    // Legacy alias — kept so artifacts authored against the old name
    // keep working. Drop in a future release once nothing references it.
    window.claude = { complete: complete };
  } catch(e) { /* injection failure shouldn't break the artifact */ }
})();</script>
`;

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
  // Inject both bridges before </body> when present, otherwise append.
  // Order: the ai bridge first so window.ai.complete is defined before
  // any inline script in the artifact has a chance to call it.
  const combined = AI_COMPLETE_BRIDGE + snippet;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, combined + "</body>");
  return html + combined;
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

/* ─── Starter content for new projects ─── */

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

<!-- DesignCanvas wraps the project in a pannable / zoomable workspace
     that follows the host editor's theme and persists artboard state
     to the project-meta API. The agent can later add more artboards
     for side-by-side variations, or replace this wrapper with a plain
     page if the design genuinely is a single static surface. -->
<script type="text/babel" src="design-canvas.jsx"></script>
</head>
<body style="margin:0">
<div id="root"></div>
<script type="text/babel">
  const { DesignCanvas, DCSection, DCArtboard } = window;
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(DesignCanvas, null,
      React.createElement(DCSection, { id: "main", title: "__NAME__" },
        React.createElement(DCArtboard, { id: "v1", label: "First", width: 800, height: 500 },
          React.createElement(
            "div",
            {
              style: {
                padding: 48,
                fontFamily: "ui-sans-serif, system-ui, sans-serif",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
              },
            },
            React.createElement(
              "h1",
              { style: { fontSize: 36, margin: 0, letterSpacing: -0.5 } },
              "__NAME__",
            ),
            React.createElement(
              "p",
              { style: { color: "#555", margin: 0, fontSize: 15 } },
              "Empty canvas. Tell the AI what to build.",
            ),
          ),
        ),
      ),
    ),
  );
</script>
</body>
</html>
`;

/* Fallback used when mcp/starters/DesignCanvas.jsx can't be read — same
 * shape as the pre-canvas-default starter. New projects still work, they
 * just don't get pan/zoom out of the box. The route logs the underlying
 * error so an operator can find the install issue. */
const STARTER_HTML_FALLBACK = `<!doctype html>
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

/* The canonical DesignCanvas starter is read once on first project create
 * and cached for the rest of the process lifetime. Living in mcp/starters/
 * means the same source ships to every project — both via this route at
 * create time AND via the `mcp__starters__copy_starter` tool when the
 * agent drops it into an existing project. The two pathways stay byte-
 * identical because they both read the same file. */
let designCanvasSource: string | null = null;
async function loadDesignCanvasStarter(): Promise<string> {
  if (designCanvasSource !== null) return designCanvasSource;
  try {
    designCanvasSource = await readFile(
      join(ENV.MCP_DIR, "starters", "DesignCanvas.jsx"),
      "utf8",
    );
  } catch (err) {
    // If the starter is missing for any reason (broken install, atypical
    // layout), fall through to a plain index.html — the new project still
    // works, just without the canvas wrapper. We log loudly so the
    // operator can find it.
    console.warn(`[projects.create] could not read DesignCanvas.jsx: ${err instanceof Error ? err.message : err}`);
    designCanvasSource = "";
  }
  return designCanvasSource;
}

function newProjectId(): string {
  return "p_" + randomBytes(4).toString("hex");
}

/* ─── Routes ─── */

export const projectsRoutes = new Hono();

projectsRoutes.get("/api/projects", async (c) => {
  try { return c.json(await getRepos().projects.list()); }
  catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 500); }
});

projectsRoutes.post("/api/projects/create", async (c) => {
  let body: { name?: string; id?: string; active_skills?: unknown };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const name = (body.name ?? "Untitled").trim() || "Untitled";
  const id = body.id && ID_RE.test(body.id) ? body.id : newProjectId();
  // Validate active_skills at the boundary: array of non-empty strings,
  // capped at a reasonable max so a malformed body can't bloat the
  // manifest. Anything else falls through to the repo's default
  // (all four aesthetic skills checked).
  let activeSkills: string[] | undefined;
  if (Array.isArray(body.active_skills)) {
    const cleaned = body.active_skills
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, 32);
    if (cleaned.length > 0) activeSkills = cleaned;
  }
  try {
    // Read the canonical DesignCanvas starter so every fresh project lands
    // with pan/zoom + theme + state-persistence wired in from prompt #1.
    // Empty string = could not read (logged); ProjectRepo.create() will
    // skip the file and the index.html falls back to a plain page render.
    const designCanvas = await loadDesignCanvasStarter();
    // If we have the starter, use the DesignCanvas-wrapped index.html.
    // Otherwise, generate a minimal plain page so the project still works.
    const indexHtml = designCanvas
      ? STARTER_HTML.replace(/__NAME__/g, name)
      : STARTER_HTML_FALLBACK.replace(/__NAME__/g, name);
    const manifest = await getRepos().projects.create({
      id,
      name,
      indexHtml,
      styleCss: STARTER_CSS.replace(/__NAME__/g, name),
      designCanvas: designCanvas || undefined,
      activeSkills,
    });
    broadcastShared("projects");
    return c.json({ id, manifest });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function requireProject(id: string): Promise<boolean> {
  return getRepos().projects.exists(id);
}

projectsRoutes.get("/api/projects/:id/manifest", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  const manifest = await getRepos().projects.getManifest(id);
  if (!manifest) return c.json({ error: "No manifest" }, 404);
  return c.json(manifest);
});

projectsRoutes.patch("/api/projects/:id/manifest", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  let patch: Partial<ProjectManifest>;
  try { patch = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  try {
    const next = await getRepos().projects.updateManifest(id, patch);
    if (!next) return c.json({ error: "No manifest" }, 404);
    broadcastShared("projects");
    return c.json(next);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.get("/api/projects/:id/__meta-events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const sub = (key: string) => {
      stream.writeSSE({ data: key }).catch(() => { /* aborted */ });
    };
    const unsub = getRepos().projectMeta.subscribe(id, sub);
    stream.onAbort(unsub);
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
  const result = await getRepos().projectMeta.get(id, key);
  if (!result.ok) return c.json({ error: "No meta blob" }, 404);
  if (c.req.header("if-none-match") === result.etag) {
    return new Response(null, { status: 304, headers: { etag: result.etag } });
  }
  return new Response(JSON.stringify(result.value), {
    status: 200,
    headers: { "content-type": "application/json", etag: result.etag },
  });
});

projectsRoutes.patch("/api/projects/:id/meta/:key", async (c) => {
  const { id, key } = c.req.param();
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const ifMatch = c.req.header("if-match") ?? undefined;
  try {
    const result = await getRepos().projectMeta.put(id, key, body, ifMatch ? { ifMatch } : undefined);
    if (!result.ok) {
      return c.json({ error: "ETag mismatch — refetch and retry", current_etag: result.currentEtag }, 412);
    }
    return new Response(JSON.stringify({ ok: true, etag: result.etag }), {
      status: 200,
      headers: { "content-type": "application/json", etag: result.etag },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.get("/api/projects/:id/files", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  try { return c.json(await getRepos().projectFiles.list(id)); }
  catch (err) { return c.json({ error: err instanceof Error ? err.message : String(err) }, 500); }
});

projectsRoutes.post("/api/projects/:id/file/upload", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  let body: { path?: string; dataUrl?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const validated = getRepos().projects.validateFilePath(body.path ?? "");
  const parsed = body.dataUrl ? parseAnyDataUrl(body.dataUrl) : null;
  if (!validated.ok || !parsed) {
    return c.json({ error: !validated.ok ? validated.reason : "Invalid dataUrl" }, 400);
  }
  try {
    const bytes = new Uint8Array(Buffer.from(parsed.data, "base64"));
    await getRepos().projectFiles.write(id, validated.path, bytes);
    const stat = await getRepos().projectFiles.read(id, validated.path);
    return c.json({
      path: validated.path,
      size: stat.ok ? stat.stat.size : bytes.byteLength,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.post("/api/projects/:id/tweak", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  let body: { file?: string; edits?: Record<string, unknown> };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const validated = getRepos().projects.validateFilePath(body.file ?? "");
  if (!validated.ok) return c.json({ error: validated.reason }, 400);
  if (!body.edits || typeof body.edits !== "object" || Array.isArray(body.edits)) {
    return c.json({ error: "edits must be a plain object" }, 400);
  }
  try {
    const read = await getRepos().projectFiles.readText(id, validated.path);
    if (!read.ok) return c.json({ error: "File not found" }, 404);
    const text = read.text;
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
      return c.json({ file: validated.path, unchanged: true });
    }
    await getRepos().projectFiles.write(id, validated.path, replaced);
    return c.json({ file: validated.path, before: parsed, after: merged });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.post("/api/projects/:id/inspector-css", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
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
    const files = getRepos().projectFiles;
    let store: Record<string, Record<string, Record<string, string>>> = {};
    const existing = await files.readText(id, "_inspector_edits.json");
    if (existing.ok) { try { store = JSON.parse(existing.text); } catch { store = {}; } }
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
    await files.write(id, "_inspector_edits.json", JSON.stringify(store, null, 2));
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
    await files.write(id, "_inspector_edits.css", cssLines.join("\n"));
    return c.json({
      rules: ruleCount,
      css_path: "_inspector_edits.css",
      json_path: "_inspector_edits.json",
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.post("/api/projects/:id/file/delete", async (c) => {
  const id = c.req.param("id");
  if (!await requireProject(id)) return c.json({ error: "Project not found" }, 404);
  let body: { path?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "Bad JSON" }, 400); }
  const validated = getRepos().projects.validateFilePath(body.path ?? "");
  if (!validated.ok) return c.json({ error: validated.reason }, 400);
  try {
    const result = await getRepos().projectFiles.delete(id, validated.path);
    if (!result.ok) return c.json({ error: "File not found" }, 404);
    return c.json({ deleted: validated.path });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

projectsRoutes.delete("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Invalid project id" }, 400);
  try {
    await getRepos().projects.delete(id);
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
    const writeReload = () => {
      stream.writeSSE({ data: "reload" }).catch(() => { /* aborted */ });
    };
    const unsub = getRepos().projectFiles.subscribe(id, writeReload);
    stream.onAbort(unsub);
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
  const validated = getRepos().projects.validateFilePath(file);
  if (!validated.ok) return c.text("Forbidden", 403);
  const exists = await getRepos().projectFiles.exists(id, validated.path);
  if (!exists) return c.text("Component not found", 404);
  const compName = basename(file).replace(/\.(jsx|tsx|js|ts)$/, "");
  const html = injectReloadClient(previewHtml(id, file, compName), id);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});

projectsRoutes.get("/p/:id/*", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("Forbidden", 403);
  const prefix = `/p/${id}`;
  let rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "/";
  try { rest = decodeURIComponent(rest); } catch { /* ignore */ }
  if (rest === "" || rest === "/") {
    const manifest = await getRepos().projects.getManifest(id);
    rest = "/" + (manifest?.entry ?? "index.html");
  }
  if (rest.endsWith("/")) rest += "index.html";
  // Strip the leading `/` so it matches the BlobStore's relative format.
  const relPathStr = rest.replace(/^\/+/, "");
  // Manifest is allowed to be served (it's a real file in the project),
  // but `validateFilePath` refuses it for write/delete. We bypass the
  // manifest-protection here by checking only path-traversal segments.
  for (const seg of relPathStr.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return c.text("Forbidden", 403);
    if (seg.startsWith(".")) return c.text("Forbidden", 403);
  }
  const result = await getRepos().projectFiles.read(id, relPathStr);
  if (!result.ok) return c.text("Not found", 404);
  const ext = extname(relPathStr).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  if (ext === ".html" || ext === ".htm") {
    const text = new TextDecoder().decode(result.bytes);
    return new Response(injectReloadClient(text, id), {
      status: 200,
      headers: { "content-type": mime, "cache-control": "no-store" },
    });
  }
  return new Response(result.bytes, {
    status: 200,
    headers: { "content-type": mime, "cache-control": "no-store" },
  });
});

