#!/usr/bin/env node
/* extract-element-html.mjs — load a page in headless Chromium, grab the
 * targeted element's outerHTML + every stylesheet + every referenced asset
 * URL. Sibling to export-element.mjs (which screenshots); this one feeds
 * the OGraf bundle generator (web/server/exportOgraf.ts).
 *
 * Stdin JSON shape:
 *   {
 *     url:       string                  // absolute http(s) URL
 *     selector:  string                  // CSS selector for the target element
 *     timeoutMs?: number = 30000
 *   }
 *
 * Stdout JSON shape (one line):
 *   {
 *     ok: true,
 *     html: string,                       // outerHTML of the matched element
 *     css: string,                        // concatenated text of every stylesheet
 *     assets: Array<{ url, kind }>,       // referenced images/fonts found in HTML/CSS
 *     boundingRect: { x, y, w, h },       // for the manifest's reference size
 *     title: string,                      // best-effort label from <h1>/aria/role
 *     fontFamilies: string[]              // unique font-family values used by the subtree
 *   }
 *   { ok: false, error: string }
 */

import { chromium } from "playwright";

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

let args;
try { args = await readStdinJson(); }
catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: `bad stdin JSON: ${err.message}` }) + "\n");
  process.exit(2);
}

const { url, selector, timeoutMs = 30_000 } = args;
if (!url || !selector) {
  process.stdout.write(JSON.stringify({ ok: false, error: "missing url or selector" }) + "\n");
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 2160 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

  // Same React-mount wait as export-element.mjs.
  await page.waitForFunction(
    () => {
      const root = document.getElementById("root");
      if (root && root.children.length > 0) return true;
      return Array.from(document.body.children).some((c) => c.tagName !== "SCRIPT");
    },
    { timeout: timeoutMs },
  );
  await page.evaluate(async () => {
    if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* */ } }
  });

  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: timeoutMs });

  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no element matched ${sel}`);

    // 1. outerHTML — the structure we'll embed in the OGraf graphic.
    const html = el.outerHTML;

    // 2. All stylesheets — both <link rel=stylesheet> (read via cssRules)
    //    and inline <style>. CORS-blocked sheets get skipped silently.
    const cssParts = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const rules = sheet.cssRules;
        if (!rules) continue;
        let txt = "";
        for (const r of Array.from(rules)) txt += r.cssText + "\n";
        cssParts.push(txt);
      } catch {
        // Cross-origin or otherwise inaccessible — leave a marker so the
        // server can decide whether to refetch via direct HTTP.
        if (sheet.href) cssParts.push(`/* unavailable: ${sheet.href} */`);
      }
    }
    for (const styleEl of Array.from(document.querySelectorAll("style"))) {
      cssParts.push(styleEl.textContent || "");
    }
    const css = cssParts.join("\n");

    // 3. Asset URLs referenced from inside the captured subtree:
    //    - <img src>, <picture><source srcset>
    //    - inline style background-image: url(...)
    //    - any element's computed background-image (catches CSS-class bg)
    const assetSet = new Map();
    function add(url, kind) {
      if (!url || url.startsWith("data:")) return;
      const abs = new URL(url, document.baseURI).toString();
      if (!assetSet.has(abs)) assetSet.set(abs, kind);
    }
    const subtree = [el, ...Array.from(el.querySelectorAll("*"))];
    for (const node of subtree) {
      if (node.tagName === "IMG") {
        add(node.currentSrc || node.src, "img");
      }
      const cs = window.getComputedStyle(node);
      const bg = cs.backgroundImage;
      if (bg && bg !== "none") {
        const matches = [...bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)];
        for (const m of matches) add(m[1], "img");
      }
    }
    // 4. Font URLs from @font-face rules in document stylesheets — tracked
    //    only if a font-family in those rules is actually used by the
    //    captured subtree. Keeps the bundle from including every webfont
    //    on the page.
    const usedFamilies = new Set();
    for (const node of subtree) {
      const ff = window.getComputedStyle(node).fontFamily;
      if (!ff) continue;
      ff.split(",").forEach((name) => usedFamilies.add(name.trim().replace(/^["']|["']$/g, "")));
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const r of Array.from(sheet.cssRules ?? [])) {
          if (r.constructor.name !== "CSSFontFaceRule") continue;
          const fam = (r.style.getPropertyValue("font-family") || "").replace(/^["']|["']$/g, "").trim();
          if (!usedFamilies.has(fam)) continue;
          const src = r.style.getPropertyValue("src");
          if (!src) continue;
          const matches = [...src.matchAll(/url\(["']?([^"')]+)["']?\)/g)];
          for (const m of matches) add(m[1], "font");
        }
      } catch { /* CORS-blocked sheet */ }
    }

    // 5. Element size — surfaced to the server so it can size the OGraf
    //    graphic. Use offsetWidth/offsetHeight (layout box) NOT
    //    getBoundingClientRect: the latter is scaled by any ancestor CSS
    //    `transform` (the design canvas fits the artboard to the viewport
    //    with a scale transform), which would record a shrunk size.
    const r = el.getBoundingClientRect();
    const boundingRect = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: el.offsetWidth || Math.round(r.width),
      h: el.offsetHeight || Math.round(r.height),
    };

    // 6. Best-effort title — used as the OGraf manifest's display name.
    const title =
      el.getAttribute("aria-label") ||
      el.getAttribute("data-name") ||
      el.querySelector("h1, h2, [role='heading']")?.textContent?.trim() ||
      el.id ||
      el.tagName.toLowerCase();

    return {
      html,
      css,
      assets: Array.from(assetSet, ([url, kind]) => ({ url, kind })),
      boundingRect,
      title: title.slice(0, 120),
      fontFamilies: Array.from(usedFamilies),
    };
  }, selector);

  // process.exit() does NOT wait for stdout to drain — when this script
  // emits >8KB of JSON (typical), the kernel pipe buffer holds 8KB and
  // process.exit drops the rest on the floor. Reproduces as
  // "Unterminated string in JSON at position 8181" downstream. Pass a
  // callback to write() so we exit only after the buffer flushes.
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n", () => process.exit(0));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message ?? String(err) }) + "\n", () => process.exit(1));
} finally {
  if (browser) await browser.close().catch(() => {});
}
