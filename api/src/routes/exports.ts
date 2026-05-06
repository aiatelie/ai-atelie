/* exports.ts — Playwright-driven exports of a single element from a
 * project's iframe. Three flavors:
 *
 *   POST /api/export-element  → PNG/JPEG (raster) via export-element.mjs
 *   POST /api/export-ograf    → DaVinci Resolve OGraf bundle (.ograf.zip)
 *   POST /api/export-video    → ProRes 4444 .mov or H.264 .mp4 + ffmpeg
 *
 * Each one targets `${internalBaseUrl}/p/<projectId>/<route>` so headless
 * Chromium loads the same iframe URL the editor renders.
 */

import { Hono } from "hono";
import { renderElement, exportRendererAvailability } from "../services/exportRender.ts";
import { buildOgrafBundle } from "../services/exportOgraf.ts";
import { recordAndEncode, videoRendererAvailability, type VideoArgs } from "../services/exportVideo.ts";
import { saveArtifact, splitFilename } from "../services/exportArtifacts.ts";
import { projectDirOf, internalBaseUrl } from "../services/projectStore.ts";

export const exportsRoutes = new Hono();

function targetUrl(projectId: string, route: string): string {
  return `${internalBaseUrl()}/p/${encodeURIComponent(projectId)}/${route.replace(/^\/+/, "")}`;
}

exportsRoutes.post("/api/export-element", async (c) => {
  type Body = {
    projectId?: string;
    route?: string;
    selector?: string;
    scale?: number;
    format?: "png" | "jpeg" | "jpg";
    backgroundColor?: "transparent" | "white" | null;
    viewport?: { w: number; h: number };
    quality?: number;
    name?: string;
  };
  let body: Body;
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  if (!body.projectId || !body.route || !body.selector) {
    return c.json({ error: "Need { projectId, route, selector }" }, 400);
  }
  const pdir = projectDirOf(body.projectId);
  if (!pdir) return c.json({ error: "invalid projectId" }, 400);
  const reason = await exportRendererAvailability();
  if (reason) return c.json({ error: reason }, 503);
  try {
    const result = await renderElement({
      url: targetUrl(body.projectId, body.route),
      selector: body.selector,
      scale: body.scale,
      format: body.format,
      backgroundColor: body.backgroundColor ?? null,
      viewport: body.viewport,
      quality: body.quality,
    });
    const ext = result.format === "jpeg" ? "jpg" : "png";
    const baseName = body.name ?? `export-${Date.now()}`;
    const artifact = await saveArtifact({
      projectDir: pdir,
      projectId: body.projectId,
      basename: baseName,
      ext,
      kind: "image",
      mime: result.format === "jpeg" ? "image/jpeg" : "image/png",
      bytes: result.bytes,
      metadata: {
        scale: body.scale ?? 2,
        backgroundColor: body.backgroundColor ?? "transparent",
      },
    });
    return c.json(artifact);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

exportsRoutes.post("/api/export-ograf", async (c) => {
  type Body = {
    projectId?: string;
    route?: string;
    selector?: string;
    name?: string;
    editableTitle?: boolean;
  };
  let body: Body;
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  if (!body.projectId || !body.route || !body.selector) {
    return c.json({ error: "Need { projectId, route, selector }" }, 400);
  }
  const pdir = projectDirOf(body.projectId);
  if (!pdir) return c.json({ error: "invalid projectId" }, 400);
  const reason = await exportRendererAvailability();
  if (reason) return c.json({ error: reason }, 503);
  try {
    const result = await buildOgrafBundle({
      url: targetUrl(body.projectId, body.route),
      selector: body.selector,
      name: body.name ?? "graphic",
      editableTitle: body.editableTitle ? "Title" : undefined,
    });
    const { base, ext } = splitFilename(result.filename);
    const artifact = await saveArtifact({
      projectDir: pdir,
      projectId: body.projectId,
      basename: base,
      ext: ext || "zip",
      kind: "html-graphics",
      mime: "application/zip",
      bytes: result.zipBytes,
      metadata: { format: "ograf" },
    });
    return c.json(artifact);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

exportsRoutes.post("/api/export-lottie", async (c) => {
  // Lottie passthrough — the page already has a <lottie-player src=...>;
  // we just persist the source file under the project's exports/ so it
  // shows up as an inline artifact like every other export.
  //
  // The client passes an absolute URL (already resolved against the
  // iframe's baseURI). Server-side fetch sidesteps browser CORS — any
  // host that returned 200 to the iframe will return 200 to us too,
  // and the API isn't bound by browser-origin rules.
  type Body = {
    projectId?: string;
    src?: string;
    name?: string;
  };
  let body: Body;
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  if (!body.projectId || !body.src) {
    return c.json({ error: "Need { projectId, src }" }, 400);
  }
  const pdir = projectDirOf(body.projectId);
  if (!pdir) return c.json({ error: "invalid projectId" }, 400);
  // Allow http(s) absolute URLs and same-origin /p/... relative paths.
  let fetchUrl: string;
  try {
    if (body.src.startsWith("/")) fetchUrl = `${internalBaseUrl()}${body.src}`;
    else fetchUrl = new URL(body.src).toString();
  } catch {
    return c.json({ error: "invalid src URL" }, 400);
  }
  try {
    const res = await fetch(fetchUrl);
    if (!res.ok) return c.json({ error: `fetch failed: HTTP ${res.status}` }, 502);
    const buf = Buffer.from(await res.arrayBuffer());
    const lower = fetchUrl.toLowerCase();
    const isDotLottie = lower.endsWith(".lottie");
    const ext = isDotLottie ? "lottie" : "json";
    const mime = isDotLottie ? "application/zip" : "application/json";
    const baseName = body.name ?? `lottie-${Date.now()}`;
    const artifact = await saveArtifact({
      projectDir: pdir,
      projectId: body.projectId,
      basename: baseName,
      ext,
      kind: "lottie",
      mime,
      bytes: buf,
      metadata: { source: fetchUrl },
    });
    return c.json(artifact);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

exportsRoutes.post("/api/export-video", async (c) => {
  type Body = {
    projectId?: string;
    route?: string;
    selector?: string;
    resolution?: VideoArgs["resolution"];
    customWidth?: number;
    customHeight?: number;
    quality?: VideoArgs["quality"];
    duration?: number;
    fps?: number;
    backgroundColor?: VideoArgs["backgroundColor"];
    name?: string;
  };
  let body: Body;
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  if (!body.projectId || !body.route || !body.selector) {
    return c.json({ error: "Need { projectId, route, selector }" }, 400);
  }
  const pdir = projectDirOf(body.projectId);
  if (!pdir) return c.json({ error: "invalid projectId" }, 400);
  const reason = await videoRendererAvailability();
  if (reason) return c.json({ error: reason }, 503);
  try {
    const result = await recordAndEncode({
      url: targetUrl(body.projectId, body.route),
      selector: body.selector,
      resolution: body.resolution,
      customWidth: body.customWidth,
      customHeight: body.customHeight,
      quality: body.quality,
      duration: body.duration,
      fps: body.fps,
      backgroundColor: body.backgroundColor,
    });
    const baseName = body.name ?? `video-${Date.now()}`;
    const artifact = await saveArtifact({
      projectDir: pdir,
      projectId: body.projectId,
      basename: baseName,
      ext: result.ext,
      kind: "video",
      mime: result.mime,
      bytes: result.bytes,
      metadata: {
        width: result.width,
        height: result.height,
        duration: result.duration,
        fps: result.fps,
        ...result.metadata,
      },
    });
    return c.json(artifact);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
