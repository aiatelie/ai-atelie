/* exportOgraf.ts — turn a live element into a DaVinci Resolve 21
 * OGraf bundle (HTML graphics standard) the user can drag into the
 * Media Pool.
 *
 * Pipeline:
 *   1. Spawn playwright-tools/extract-element-html.mjs which loads the
 *      page, grabs the targeted element's outerHTML, all stylesheets,
 *      and the asset URLs (img / background-image / @font-face) used
 *      by that subtree.
 *   2. Download each referenced asset to a temp `assets/` dir.
 *   3. Rewrite asset URLs in HTML and CSS to point at the bundled paths.
 *   4. Generate `<id>.ograf.json` (manifest) and `graphic.mjs` (the Web
 *      Component the OGraf renderer instantiates).
 *   5. Zip the temp dir via the system `zip` binary (built into macOS
 *      and standard on Linux), return the bytes.
 *
 * Bundle layout:
 *   <id>.ograf.json
 *   graphic.mjs
 *   styles.css
 *   assets/
 *     img-0001.<ext>
 *     font-0001.<ext>
 *     ...
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

export type OgrafBundleArgs = {
  url: string;
  selector: string;
  /** Used as both the bundle's filename and its OGraf id (slugified). */
  name: string;
  /** Default text for a single editable field, surfaced in Resolve's
   *  inspector. Optional — when omitted the graphic ships static. */
  editableTitle?: string;
};

export type OgrafBundleResult = {
  zipBytes: Buffer;
  filename: string;
};

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
  "font/woff2": "woff2",
  "font/woff": "woff",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "application/font-woff2": "woff2",
  "application/font-woff": "woff",
};

function extFromContentType(ct: string | null): string | null {
  if (!ct) return null;
  return MIME_TO_EXT[ct.split(";")[0].trim().toLowerCase()] ?? null;
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
  // Concatenate Buffers, then decode once at the end. `chunk.toString("utf8")`
  // can corrupt multi-byte characters split across data events; buffer-then-
  // decode is the safe pattern.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => { stdoutChunks.push(d); });
  child.stderr.on("data", (d: Buffer) => { stderrChunks.push(d); });
  child.stdin.write(JSON.stringify({ url, selector }));
  child.stdin.end();
  // `close` (not `exit`) fires after stdio streams have flushed —
  // critical for large captured HTML/CSS that comes through stdout in
  // multiple `data` chunks. Listening on `exit` truncates payloads >8KB.
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

async function fetchAsset(url: string, idx: number, kind: "img" | "font"): Promise<{ path: string; bytes: Buffer; abs: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type");
    const ext = extFromContentType(ct) ?? extFromUrl(url) ?? (kind === "font" ? "woff2" : "bin");
    const filename = `${kind === "font" ? "font" : "img"}-${String(idx).padStart(4, "0")}.${ext}`;
    const bytes = Buffer.from(await res.arrayBuffer());
    return { path: `assets/${filename}`, bytes, abs: url };
  } catch {
    return null;
  }
}

/** Apply a URL-rewrite map to text. Replaces every occurrence (in order
 *  by length DESC so longer URLs win when one is a prefix of another). */
function rewriteUrls(text: string, map: Map<string, string>): string {
  const sorted = Array.from(map.entries()).sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of sorted) {
    // Replace bare URL plus url() forms. Escape regex-meaningful chars.
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), to);
  }
  return out;
}

function manifestJson(id: string, displayName: string, rect: { w: number; h: number }, hasEditableTitle: boolean): string {
  const schemaProps: Record<string, unknown> = {};
  if (hasEditableTitle) {
    schemaProps.title = { type: "string", default: displayName };
  }
  const manifest: Record<string, unknown> = {
    $schema: "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json",
    id,
    name: displayName,
    version: "1.0.0",
    main: "graphic.mjs",
    supportsRealTime: true,
    supportsNonRealTime: true,
    width: rect.w,
    height: rect.h,
    schema: {
      type: "object",
      properties: schemaProps,
    },
  };
  return JSON.stringify(manifest, null, 2);
}

function graphicJs(rect: { w: number; h: number }, hasEditableTitle: boolean): string {
  // The Web Component pulls in the captured HTML + bundled stylesheet,
  // pins itself to the captured element's exact CSS dimensions, and
  // exposes a single optional `title` data field that updates the first
  // [data-ograf-title] node it finds in the captured markup.
  return `// graphic.mjs — auto-generated by AI Atelie.
const HTML_RES = "./content.html";
const CSS_RES  = "./styles.css";

class Graphic extends HTMLElement {
  async load({ data } = {}) {
    const [html, css] = await Promise.all([
      fetch(HTML_RES).then((r) => r.text()),
      fetch(CSS_RES).then((r) => r.text()),
    ]);
    this.style.display = "block";
    this.style.width = ${JSON.stringify(rect.w + "px")};
    this.style.height = ${JSON.stringify(rect.h + "px")};
    this.style.position = "relative";
    this.style.overflow = "hidden";
    this.innerHTML = \`<style data-ograf-styles>\${css}</style>\${html}\`;
    ${hasEditableTitle ? "this._applyData(data || {});" : ""}
    return { statusCode: 200, statusMessage: "loaded" };
  }
  ${hasEditableTitle
    ? `_applyData(data) {
      if (typeof data.title === "string") {
        const node = this.querySelector("[data-ograf-title]");
        if (node) node.textContent = data.title;
      }
    }
    async updateAction({ data } = {}) {
      this._applyData(data || {});
      return { statusCode: 200, statusMessage: "updated" };
    }`
    : `async updateAction() { return { statusCode: 200 }; }`}
  async playAction() { return { statusCode: 200, currentStep: 0 }; }
  async stopAction() { return { statusCode: 200 }; }
  async customAction() { return { statusCode: 400, statusMessage: "no custom actions" }; }
  async dispose() { this.innerHTML = ""; }
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
  const data = await runExtractor(args.url, args.selector);

  const id = slugify(args.name || data.title);
  const displayName = args.name || data.title || id;
  const work = join(tmpdir(), `cc-ograf-${randomUUID()}`);
  const bundleDir = join(work, id);
  await mkdir(join(bundleDir, "assets"), { recursive: true });

  try {
    // 1. Download assets and build URL-rewrite map.
    const rewrite = new Map<string, string>();
    let imgIdx = 0;
    let fontIdx = 0;
    for (const a of data.assets) {
      const idx = a.kind === "font" ? ++fontIdx : ++imgIdx;
      const fetched = await fetchAsset(a.url, idx, a.kind);
      if (!fetched) continue;
      const fullPath = join(bundleDir, fetched.path);
      await writeFile(fullPath, fetched.bytes);
      rewrite.set(a.url, fetched.path);
      // Also try matching against the relative form ("./photo.jpg") in
      // case the captured HTML/CSS used the unresolved relative path.
      try {
        const u = new URL(a.url);
        rewrite.set(u.pathname, fetched.path);
        const last = u.pathname.split("/").pop();
        if (last) rewrite.set(last, fetched.path);
      } catch { /* ignore */ }
    }

    // 2. Rewrite URLs in HTML + CSS so the bundle is fully self-contained.
    const htmlRewritten = rewriteUrls(data.html, rewrite);
    const cssRewritten = rewriteUrls(data.css, rewrite);

    // 3. Optionally annotate a single editable title node — best-effort,
    //    finds the first <h1> / [role=heading] and stamps data-ograf-title
    //    so updateAction can target it. Skipped if no obvious title.
    const hasEditableTitle = !!args.editableTitle;
    const finalHtml = hasEditableTitle
      ? htmlRewritten.replace(
          /<(h1|h2)([^>]*)>/i,
          (_m, tag, attrs) => `<${tag}${attrs} data-ograf-title>`,
        )
      : htmlRewritten;

    // 4. Write the bundle files.
    await writeFile(join(bundleDir, "content.html"), finalHtml, "utf8");
    await writeFile(join(bundleDir, "styles.css"), cssRewritten, "utf8");
    await writeFile(
      join(bundleDir, "graphic.mjs"),
      graphicJs(data.boundingRect, hasEditableTitle),
      "utf8",
    );
    await writeFile(
      join(bundleDir, `${id}.ograf.json`),
      manifestJson(id, displayName, data.boundingRect, hasEditableTitle),
      "utf8",
    );

    // 5. Zip the bundle directory.
    const zipPath = join(work, `${id}.zip`);
    await zipDirectory(bundleDir, zipPath);
    const zipBytes = await readFile(zipPath);

    return { zipBytes, filename: `${id}.ograf.zip` };
  } finally {
    // Best-effort cleanup of the temp work dir.
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
