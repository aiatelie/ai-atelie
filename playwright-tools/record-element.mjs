#!/usr/bin/env node
/* record-element.mjs — load a page in headless Chromium and capture
 * N frames of a specific element over a duration, at high DPI. The
 * server's ffmpeg step then encodes those frames into MP4 / ProRes /
 * whatever the user picked.
 *
 * Why frame-by-frame instead of Playwright's built-in video recorder?
 *
 *   - Built-in recordVideo only outputs WebM (VP9), no alpha control.
 *   - We want clean alpha (ProRes 4444), arbitrary codecs, and explicit
 *     framerate. Per-frame screenshots give us full control.
 *   - locator.screenshot() respects deviceScaleFactor for retina-quality
 *     re-rasterization (text + vectors stay sharp at 4K). The browser
 *     paints the layout at the higher DPI rather than upscaling pixels.
 *
 * Stdin JSON shape:
 *   {
 *     url:         string                       // absolute http(s) URL
 *     selector:    string                       // CSS selector for the target
 *     duration:    number = 5                   // seconds to record
 *     fps:         number = 30                  // frames per second
 *     scale:       number = 2                   // deviceScaleFactor; output px = element CSS px × scale
 *     viewport?:   { w: number, h: number }     // page viewport in CSS px (default 1920×1080)
 *     backgroundColor?: "transparent" | "white" | "black" | "#RRGGBB" | null
 *     timeoutMs?:  number = 60000
 *   }
 *
 * Stdout JSON shape (one line):
 *   { ok: true, dir: "/tmp/cc-record-<uuid>", framePattern: "frame_%04d.png", count: N, fps, scale, width, height }
 *   { ok: false, error: "<message>" }
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
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

let args;
try { args = await readStdinJson(); }
catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: `bad stdin JSON: ${err.message ?? err}` }) + "\n", () => process.exit(2));
}

const {
  url,
  selector,
  // Duration can be:
  //   - a number (seconds) → record exactly that long
  //   - "auto"             → detect natural animation length after mount
  duration = "auto",
  fps = 30,
  scale = 2,
  viewport = { w: 1920, h: 1080 },
  backgroundColor = null,
  timeoutMs = 60_000,
  /** Hard cap when duration="auto" can't detect anything. */
  fallbackDuration = 5,
  /** Hard cap on auto-detected durations to avoid surprising 60-minute
   *  recordings if some CSS rule has animation-duration: 3600s. */
  maxAutoDuration = 30,
} = args;

if (!url || !selector) {
  process.stdout.write(JSON.stringify({ ok: false, error: "missing url or selector" }) + "\n", () => process.exit(2));
}
if (typeof duration === "number" && (duration <= 0 || duration > 60)) {
  process.stdout.write(JSON.stringify({ ok: false, error: "duration must be between 0 and 60 seconds" }) + "\n", () => process.exit(2));
}
if (fps < 1 || fps > 120) {
  process.stdout.write(JSON.stringify({ ok: false, error: "fps must be between 1 and 120" }) + "\n", () => process.exit(2));
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    deviceScaleFactor: scale,
    viewport: { width: viewport.w, height: viewport.h },
  });

  // Virtualize the page's clock BEFORE navigation so CSS animations,
  // requestAnimationFrame loops, and setTimeout / setInterval all
  // advance only when we explicitly call clock.runFor. Without this,
  // wall-clock screenshot latency (50–200ms per frame) bleeds into the
  // captured animation: at 30fps target you'd see 4–6× speed-up because
  // the animation kept playing during the screenshot.
  await context.clock.install();

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

  // Wait for fonts / images so frame 0 isn't ahead of the actual paint.
  await page.evaluate(async () => {
    if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* */ } }
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

  // Discover the target's bbox so we can return width/height to the
  // server (so ffmpeg knows the canvas size). The bbox is post-transform,
  // post-scale CSS pixels — the actual frame buffer is bbox × scale.
  const bbox = await locator.boundingBox();
  if (!bbox) throw new Error("locator.boundingBox returned null");

  // ── Detect natural animation duration ─────────────────────────
  // If the user picked duration="auto", inspect the captured subtree
  // for CSS animations + Lottie players and use the longest finite
  // length found. Falls back to fallbackDuration when nothing is
  // detected (rAF-only animations have no declarative length).
  const detectedSeconds = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    let max = 0;
    const all = [el, ...Array.from(el.querySelectorAll("*"))];
    for (const node of all) {
      const cs = node.ownerDocument?.defaultView?.getComputedStyle(node);
      if (!cs) continue;
      const durs = (cs.animationDuration || "").split(",").map((s) => parseFloat(s));
      const counts = (cs.animationIterationCount || "").split(",").map((s) => s.trim() === "infinite" ? Infinity : parseFloat(s) || 1);
      const delays = (cs.animationDelay || "").split(",").map((s) => parseFloat(s) || 0);
      for (let i = 0; i < durs.length; i++) {
        const d = durs[i];
        if (!isFinite(d) || isNaN(d) || d <= 0) continue;
        const c = counts[i];
        // For infinite-iteration animations, count one cycle as the
        // "natural" duration; the user can request a longer clip
        // explicitly to capture multiple loops.
        const total = (isFinite(c) ? d * c : d) + Math.max(0, delays[i] || 0);
        if (isFinite(total) && total > max) max = total;
      }
      // Lottie players expose getLottie() to reach the underlying
      // bodymovin instance. Read totalFrames / frameRate for duration.
      const tag = node.tagName.toLowerCase();
      if (tag === "lottie-player" || tag === "dotlottie-player") {
        try {
          const lp = node.getLottie?.();
          if (lp && typeof lp.totalFrames === "number" && typeof lp.frameRate === "number" && lp.frameRate > 0) {
            const d = lp.totalFrames / lp.frameRate;
            if (d > max) max = d;
          }
        } catch { /* lottie may not be ready */ }
      }
    }
    return max;
  }, selector);

  // Resolve final duration:
  //   - explicit number: trust it
  //   - "auto" + detected > 0: use detected (capped)
  //   - "auto" + nothing detected: fallbackDuration (5s default)
  let finalDuration;
  let durationMode;
  if (typeof duration === "number") {
    finalDuration = duration;
    durationMode = "explicit";
  } else if (detectedSeconds > 0) {
    finalDuration = Math.min(detectedSeconds, maxAutoDuration);
    durationMode = "auto-detected";
  } else {
    finalDuration = fallbackDuration;
    durationMode = "auto-fallback";
  }

  const totalFrames = Math.max(1, Math.round(finalDuration * fps));
  const frameIntervalMs = 1000 / fps;

  // Output frames live in a fresh temp dir. Server reads framePattern
  // and dir, hands them to ffmpeg, then unlinks the dir on its way out.
  const outDir = join(tmpdir(), `cc-record-${randomUUID()}`);
  await mkdir(outDir, { recursive: true });

  // ── Deterministic frame loop ──────────────────────────────────
  // For each frame i:
  //   1. Advance the virtualized clock by exactly 1/fps seconds. CSS
  //      animations + Lottie + setInterval / setTimeout / rAF all wake
  //      up at the new virtual time and update.
  //   2. Screenshot the locator. The screenshot is pixel-accurate for
  //      that virtual time, regardless of how long it actually takes
  //      to capture. So 30fps and 60fps produce identical-speed
  //      animations — fps only changes sample density, never speed.
  const opts = {
    type: "png",
    omitBackground: backgroundColor === "transparent",
    animations: "allow",
    caret: "hide",
  };

  // Frame 0: capture at t=0 (just after install + load) without
  // advancing — that's the animation's starting state.
  let buf = await locator.screenshot(opts);
  await writeFile(join(outDir, "frame_0000.png"), buf);
  for (let i = 1; i < totalFrames; i++) {
    await context.clock.runFor(frameIntervalMs);
    buf = await locator.screenshot(opts);
    await writeFile(join(outDir, `frame_${String(i).padStart(4, "0")}.png`), buf);
  }

  const result = {
    ok: true,
    dir: outDir,
    framePattern: "frame_%04d.png",
    count: totalFrames,
    fps,
    scale,
    duration: finalDuration,
    durationMode,
    detectedSeconds,
    // Output pixel dimensions = element CSS bbox × scale.
    width: Math.round(bbox.width * scale),
    height: Math.round(bbox.height * scale),
    backgroundColor,
  };
  process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err.message ?? String(err) }) + "\n", () => process.exit(1));
} finally {
  if (browser) await browser.close().catch(() => {});
}
