#!/usr/bin/env node
/* export-element.mjs — render a URL in headless Chromium and screenshot
 * a specific element. Reads JSON args from stdin, writes the image to a
 * temp file, and prints {ok, path, bytes} on stdout so the parent can
 * read + clean up cleanly (binary-on-stdout has too many edge cases on
 * Windows / pipes / CRLF, hence the temp-file dance).
 *
 * Stdin JSON shape:
 *   {
 *     url:        string                        // absolute http(s) URL
 *     selector:   string                        // CSS selector for the target
 *     scale?:     number = 2                    // deviceScaleFactor; output px = element CSS px × scale
 *     format?:    "png" | "jpeg" = "png"
 *     backgroundColor?: "transparent" | "white" | null
 *     viewport?:  { w: number, h: number } = { w: 1920, h: 2160 }
 *     quality?:   number                        // jpeg only, 0–100 (Playwright scale)
 *     timeoutMs?: number = 30000
 *   }
 *
 * Stdout JSON shape (one line):
 *   { ok: true,  path: "/tmp/cc-export/export-<uuid>.<ext>", bytes: <n> }
 *   { ok: false, error: "<message>" }
 *
 * Exits 0 on success (regardless of {ok}), 1 on JS error, 2 on bad args.
 */

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

async function readStdinJson() {
  return new Promise((res, rej) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => {
      try { res(JSON.parse(buf)); } catch (err) { rej(err); }
    });
    process.stdin.on("error", rej);
  });
}

function fail(error, code = 1) {
  process.stderr.write(JSON.stringify({ error }) + "\n");
  process.exit(code);
}

let args;
try {
  args = await readStdinJson();
} catch (err) {
  fail(`bad stdin JSON: ${err.message ?? err}`, 2);
}

const {
  url,
  selector,
  scale = 2,
  format = "png",
  backgroundColor = null,
  viewport = { w: 1920, h: 2160 },
  quality,
  timeoutMs = 30_000,
} = args;

if (!url || typeof url !== "string") fail("missing url", 2);
if (!selector || typeof selector !== "string") fail("missing selector", 2);

const fmt = (format === "jpeg" || format === "jpg") ? "jpeg" : "png";

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    deviceScaleFactor: scale,
    viewport: { width: viewport.w, height: viewport.h },
  });
  const page = await context.newPage();

  // `networkidle` hangs on the in-browser-React project pages: Babel
  // keeps fetching .jsx files dynamically (and HMR / dev-only requests
  // can keep the network "active" forever in dev). `load` fires after
  // initial assets are in; we then wait for #root to have children to
  // confirm React actually mounted.
  await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

  // Many of the project pages are in-browser-React: <script type="text/babel">
  // tags get compiled by @babel/standalone AFTER networkidle has already
  // settled, then ReactDOM.createRoot().render(...) runs. The locator
  // we're trying to screenshot doesn't exist until that whole chain
  // finishes — `networkidle` alone is not enough.
  //
  // Belt-and-suspenders: wait for #root to actually have a child element
  // (good signal that React mounted), then wait for the target selector.
  await page.waitForFunction(
    () => {
      const root = document.getElementById("root");
      if (root && root.children.length > 0) return true;
      // Fallback for non-React pages — body has any non-script child.
      return Array.from(document.body.children).some((c) => c.tagName !== "SCRIPT");
    },
    { timeout: timeoutMs },
  );

  // Now wait for fonts, then for any pending image decodes.
  await page.evaluate(async () => {
    if (typeof document !== "undefined" && document.fonts?.ready) {
      try { await document.fonts.ready; } catch { /* ignore */ }
    }
    const imgs = Array.from(document.querySelectorAll("img"));
    await Promise.all(imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return null;
      if (typeof img.decode === "function") return img.decode().catch(() => undefined);
      return new Promise((r) => {
        img.addEventListener("load", () => r(undefined), { once: true });
        img.addEventListener("error", () => r(undefined), { once: true });
      });
    }));
  });

  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: timeoutMs });

  // Wait for any <img> elements *inside* the target to finish loading —
  // React might mount the wrapper before its hero photo's network fetch
  // resolves. Small per-image safety cap so a broken src doesn't hang us.
  await locator.evaluate(async (el) => {
    const imgs = Array.from(el.querySelectorAll("img"));
    await Promise.all(imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return null;
      return new Promise((r) => {
        const done = () => r(undefined);
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
        setTimeout(done, 5000);
      });
    }));
  });

  const screenshotOpts = {
    type: fmt,
    omitBackground: backgroundColor === "transparent",
    animations: "disabled",
    caret: "hide",
    ...(fmt === "jpeg" && typeof quality === "number" ? { quality } : {}),
  };

  const buf = await locator.screenshot(screenshotOpts);

  const outDir = join(tmpdir(), "cc-export");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `export-${randomUUID()}.${fmt === "jpeg" ? "jpg" : "png"}`);
  await writeFile(outPath, buf);

  // Defer process.exit until stdout drains — process.exit does not wait
  // on its own. Outputs here are small (just a path) so this script
  // never actually hit the truncation bug, but the pattern is the same
  // landmine that bit extract-element-html.mjs.
  process.stdout.write(JSON.stringify({ ok: true, path: outPath, bytes: buf.length }) + "\n", () => process.exit(0));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message ?? String(err) }) + "\n", () => process.exit(1));
} finally {
  if (browser) await browser.close().catch(() => {});
}
