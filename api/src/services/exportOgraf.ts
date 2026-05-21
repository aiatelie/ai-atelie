/* exportOgraf.ts — turn a live element (or whole page) into a DaVinci
 * Resolve 21 OGraf bundle (HTML graphics standard).
 *
 * Hard-won lessons baked into this generator (see the OGraf debugging
 * session — all verified against Resolve 21's `ograf-cef-host`):
 *
 *   1. NO runtime fetch. Resolve runs OGraf in a sandboxed Chromium;
 *      `fetch("./content.html")` fails. HTML, CSS and every image/font
 *      are inlined into graphic.mjs (assets as data: URIs).
 *   2. Seekable animations. Resolve scrubs the timeline via the
 *      non-realtime `goToTime()` API; CSS @keyframes are wall-clock
 *      driven and freeze. goToTime() pauses every animation and sets
 *      its currentTime, so @keyframes follow Resolve's clock.
 *   3. Layout-box sizing. The extractor measures offsetWidth/Height,
 *      never getBoundingClientRect (transform-scaled).
 *   4. CSS scope. Element/overlay graphics render inside a shadow root
 *      so the captured page CSS can't leak (`html,body{background}`
 *      would otherwise paint the whole frame). Page graphics render in
 *      light DOM so their own html/body rules apply.
 *
 * Bundle layout (fully self-contained — two files, no assets folder):
 *   <id>.ograf.json   manifest
 *   graphic.mjs       the Web Component, with HTML+CSS+assets inlined
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve as resolvePath, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ENV } from "../env.ts";

const PLAYWRIGHT_TOOLS_DIR = ENV.PLAYWRIGHT_TOOLS_DIR;
const EXTRACT_SCRIPT = resolvePath(PLAYWRIGHT_TOOLS_DIR, "extract-element-html.mjs");

export type OgrafExtractedData = {
  html: string;
  css: string;
  assets: Array<{ url: string; kind: "img" | "font" }>;
  boundingRect: { x: number; y: number; w: number; h: number };
  title: string;
  fontFamilies: string[];
};

/** How a declared prop maps onto the captured DOM.
 *  - text       → element textContent
 *  - background → CSS background colour
 *  - color      → CSS text colour
 *  - fontSize   → CSS font-size, value is a number of px
 *  - fontFamily → CSS font-family, value is a font name string
 *  - opacity    → whole-graphic opacity (0–1)
 *  - duration   → animation-duration, value is a number of seconds */
export type OgrafPropControl =
  | "text"
  | "background"
  | "color"
  | "fontSize"
  | "fontFamily"
  | "opacity"
  | "duration";

/** One editable field surfaced in Resolve's OGraf inspector. The chat
 *  agent proposes these (selector + control) after inspecting the
 *  design; the user confirms. */
export type OgrafProp = {
  /** data key — also the manifest schema property name. */
  key: string;
  /** Inspector label. */
  label: string;
  /** Value type — drives the inspector control + JSON-schema type. */
  type: "text" | "number" | "color";
  /** CSS selector (within the captured subtree) the control acts on.
   *  Ignored for `opacity` (always the whole graphic). */
  target?: string;
  /** What the value changes. */
  control: OgrafPropControl;
  /** Default value. */
  default?: string | number;
};

export type OgrafBundleArgs = {
  url: string;
  selector: string;
  /** Used as both the bundle's filename and its OGraf id (slugified). */
  name: string;
  /** "element" — overlay/asset: shadow-scoped, transparent frame, sized
   *  to the element. "page" — whole page: light DOM, keeps the page
   *  background, sized to the captured root. Default "element". */
  scope?: "element" | "page";
  /** true (default) — animations stay seekable via goToTime(). false —
   *  the graphic is frozen at its resting state (entrance complete,
   *  loops at t=0). */
  animated?: boolean;
  /** Editable props surfaced in Resolve's inspector. Empty = none. */
  props?: OgrafProp[];
};

export type OgrafBundleResult = {
  zipBytes: Buffer;
  filename: string;
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  gif: "image/gif",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

function mimeFromContentType(ct: string | null): string | null {
  if (!ct) return null;
  const m = ct.split(";")[0].trim().toLowerCase();
  return m || null;
}

function extFromUrl(url: string): string | null {
  const m = url.split("?")[0].match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

function slugify(s: string): string {
  return (
    s.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "graphic"
  );
}

async function runExtractor(url: string, selector: string): Promise<OgrafExtractedData> {
  const child = spawn(process.execPath, [EXTRACT_SCRIPT], {
    cwd: PLAYWRIGHT_TOOLS_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => { stdoutChunks.push(d); });
  child.stderr.on("data", (d: Buffer) => { stderrChunks.push(d); });
  child.stdin.write(JSON.stringify({ url, selector }));
  child.stdin.end();
  const exitCode: number = await new Promise((res, rej) => {
    child.on("close", (code) => res(code ?? -1));
    child.on("error", rej);
  });
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) {
    throw new Error(`extract-element-html produced no result (exit=${exitCode}): ${stderr.slice(0, 400)}`);
  }
  let parsed: { ok: boolean; error?: string } & Partial<OgrafExtractedData>;
  try { parsed = JSON.parse(line); }
  catch (err) { throw new Error(`bad extractor JSON: ${(err as Error).message}`); }
  if (!parsed.ok) throw new Error(parsed.error ?? "unknown extractor failure");
  return parsed as OgrafExtractedData;
}

/** Download an asset and return it as a `data:` URI. Resolve's CEF
 *  sandbox blocks runtime fetch of bundle files, so every asset has to
 *  be inlined — a data URI is self-contained and path-independent. */
async function fetchAssetDataUri(url: string, kind: "img" | "font"): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = mimeFromContentType(res.headers.get("content-type"));
    const ext = extFromUrl(url);
    const mime = ct || (ext && EXT_TO_MIME[ext]) || (kind === "font" ? "font/woff2" : "image/png");
    const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

/** Apply a URL-rewrite map to text (longest match first so a URL that
 *  is a prefix of another doesn't win). */
function rewriteUrls(text: string, map: Map<string, string>): string {
  const sorted = Array.from(map.entries()).sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of sorted) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), to);
  }
  return out;
}

/** JSON Schema `properties` block for the manifest, derived from the
 *  declared props. OGraf/GDD reference GUIs build inspector controls
 *  from this — the field label comes from `title` (NOT `description`),
 *  `order` sets display order, and `gddType` is the GDD rich-control
 *  hint (color-rrggbb needs a matching hex `pattern`). */
function propsToSchema(props: OgrafProp[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  props.forEach((p, i) => {
    const entry: Record<string, unknown> = {
      type: p.type === "number" ? "number" : "string",
      title: p.label,
      order: i,
    };
    if (p.default !== undefined) entry.default = p.default;
    if (p.type === "color") {
      entry.gddType = "color-rrggbb";
      entry.pattern = "^#[0-9a-fA-F]{6}$";
    } else if (p.type === "text") {
      entry.gddType = "single-line";
    }
    properties[p.key] = entry;
  });
  return properties;
}

function manifestJson(
  id: string,
  displayName: string,
  size: { w: number; h: number },
  props: OgrafProp[],
): string {
  const manifest: Record<string, unknown> = {
    $schema: "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
    id,
    name: displayName,
    description: "Generated by AI Atelie.",
    version: "1.0.0",
    main: "graphic.mjs",
    supportsRealTime: true,
    supportsNonRealTime: true,
    width: size.w,
    height: size.h,
    schema: {
      type: "object",
      properties: propsToSchema(props),
    },
  };
  return JSON.stringify(manifest, null, 2);
}

/** The Web Component. HTML + CSS are inlined as string constants (no
 *  runtime fetch). Animations are paused and seeked from goToTime() so
 *  they track Resolve's timeline. Props are interpreted at runtime from
 *  an inlined descriptor. */
function graphicModule(args: {
  html: string;
  css: string;
  props: OgrafProp[];
  width: number;
  height: number;
  scope: "element" | "page";
  animated: boolean;
}): string {
  const { html, css, props, width, height, scope, animated } = args;
  return `// graphic.mjs — generated by AI Atelie. OGraf graphic for DaVinci Resolve 21+.
const HTML = ${JSON.stringify(html)};
const CSS = ${JSON.stringify(css)};
const PROPS = ${JSON.stringify(props)};
const W = ${width};
const H = ${height};
const SCOPE = ${JSON.stringify(scope)};
const ANIMATED = ${animated ? "true" : "false"};

class Graphic extends HTMLElement {
  async load(params) {
    this.setAttribute("style", "display:block;width:" + W + "px;height:" + H + "px");
    const style = document.createElement("style");
    style.textContent = CSS;
    const wrap = document.createElement("div");
    wrap.className = "ograf-root";
    wrap.setAttribute("style", "position:relative;width:" + W + "px;height:" + H + "px;overflow:hidden");
    wrap.innerHTML = HTML;
    const override = document.createElement("style");
    // Element/overlay graphics render inside a shadow root so the
    // captured page CSS (html/body backgrounds, resets) can't leak out
    // and paint the whole frame. Page graphics render in light DOM so
    // their own html/body rules still apply.
    if (SCOPE === "element") {
      const root = this.attachShadow({ mode: "open" });
      root.append(style, wrap, override);
    } else {
      this.append(style, wrap, override);
    }
    this._wrap = wrap;
    this._override = override;
    this._data = {};
    this._t = 0;
    this._seek = !!(params && params.renderType && params.renderType !== "realtime");
    this._applyData((params && params.data) || {});
    if (!ANIMATED) this._freezeStatic();
    else if (this._seek) this._applyTime(0);
    return { statusCode: 200, statusMessage: "loaded" };
  }

  _anims() {
    try { return this._wrap.getAnimations({ subtree: true }); } catch (e) { return []; }
  }
  _applyTime(ms) {
    for (const a of this._anims()) { try { a.pause(); a.currentTime = ms; } catch (e) {} }
  }
  _freezeStatic() {
    for (const a of this._anims()) {
      try {
        a.pause();
        const t = a.effect && a.effect.getComputedTiming();
        const end = t && isFinite(t.endTime) ? t.endTime : 0;
        a.currentTime = end;
      } catch (e) {}
    }
  }
  _applyData(data) {
    for (const p of PROPS) {
      const v = data && data[p.key] !== undefined ? data[p.key] : p.default;
      if (v === undefined || v === null) continue;
      this._data[p.key] = v;
      if (p.control === "text" && p.target) {
        const n = this._wrap.querySelector(p.target);
        if (n) n.textContent = String(v);
      } else if (p.control === "opacity") {
        this._wrap.style.opacity = String(v);
      }
    }
    let css = "";
    for (const p of PROPS) {
      const v = this._data[p.key];
      if (v === undefined) continue;
      const tgt = p.target || ".ograf-root";
      if (p.control === "background") css += tgt + "{background:" + v + " !important;}";
      else if (p.control === "color") css += tgt + "{color:" + v + " !important;}";
      else if (p.control === "fontSize") css += tgt + "{font-size:" + v + "px !important;}";
      else if (p.control === "fontFamily") css += tgt + "{font-family:" + v + " !important;}";
      else if (p.control === "duration") css += tgt + "{animation-duration:" + v + "s !important;}";
    }
    this._override.textContent = css;
  }

  async goToTime(params) {
    this._t = (params && params.timestamp) || 0;
    if (ANIMATED) this._applyTime(this._t);
    return { statusCode: 200 };
  }
  async setActionsSchedule(_params) { return { statusCode: 200 }; }
  async updateAction(params) {
    this._applyData((params && params.data) || {});
    if (ANIMATED && this._seek) this._applyTime(this._t);
    else if (!ANIMATED) this._freezeStatic();
    return { statusCode: 200 };
  }
  async playAction(_params) { return { statusCode: 200, currentStep: 0 }; }
  async stopAction(_params) { return { statusCode: 200 }; }
  async customAction(_params) { return { statusCode: 400, statusMessage: "no custom actions" }; }
  async dispose(_params) {
    if (this.shadowRoot) this.shadowRoot.replaceChildren();
    else this.replaceChildren();
  }
}

export default Graphic;
`;
}

async function zipDirectory(dir: string, outZip: string): Promise<void> {
  await new Promise<void>((res, rej) => {
    const z = spawn("zip", ["-r", "-q", outZip, "."], { cwd: dir });
    let stderr = "";
    z.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    z.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`zip exited ${code}: ${stderr || "no stderr"}`));
    });
    z.on("error", rej);
  });
}

export async function buildOgrafBundle(args: OgrafBundleArgs): Promise<OgrafBundleResult> {
  const scope = args.scope === "page" ? "page" : "element";
  const animated = args.animated !== false;
  const props = Array.isArray(args.props) ? args.props : [];

  const data = await runExtractor(args.url, args.selector);

  const id = slugify(args.name || data.title);
  const displayName = args.name || data.title || id;
  const width = Math.max(1, Math.round(data.boundingRect.w));
  const height = Math.max(1, Math.round(data.boundingRect.h));

  // 1. Inline every referenced asset as a data: URI (no runtime fetch).
  const rewrite = new Map<string, string>();
  for (const a of data.assets) {
    const uri = await fetchAssetDataUri(a.url, a.kind);
    if (!uri) continue;
    rewrite.set(a.url, uri);
    try {
      const u = new URL(a.url);
      rewrite.set(u.pathname, uri);
      const last = u.pathname.split("/").pop();
      if (last) rewrite.set(last, uri);
    } catch { /* ignore */ }
  }
  let html = rewriteUrls(data.html, rewrite);
  let css = rewriteUrls(data.css, rewrite);

  // 2. Element/overlay scope: the captured root keeps its original page
  //    position (e.g. `position:absolute;top:56px`). Inside the OGraf
  //    frame that offsets it out of view — pin it to the origin.
  if (scope === "element") {
    css += "\n.ograf-root > :first-child{top:0 !important;left:0 !important;" +
      "right:auto !important;bottom:auto !important;margin:0 !important;}\n";
  }

  // 3. Generate the two bundle files.
  const graphicMjs = graphicModule({ html, css, props, width, height, scope, animated });
  const manifest = manifestJson(id, displayName, { w: width, h: height }, props);

  const work = join(tmpdir(), `cc-ograf-${randomUUID()}`);
  const bundleDir = join(work, id);
  await mkdir(bundleDir, { recursive: true });
  try {
    await writeFile(join(bundleDir, "graphic.mjs"), graphicMjs, "utf8");
    await writeFile(join(bundleDir, `${id}.ograf.json`), manifest, "utf8");
    const zipPath = join(work, `${id}.zip`);
    await zipDirectory(bundleDir, zipPath);
    const zipBytes = await readFile(zipPath);
    return { zipBytes, filename: `${id}.ograf.zip` };
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
