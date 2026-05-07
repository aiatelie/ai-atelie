// Overlay tracks transform-driven motion — proves the parent's
// hover/selection overlay rectangles follow the target element when
// an ancestor is pan/zoom'd via CSS transform (the demo's `DCViewport`
// pattern). Before this PR, none of scroll/resize/ResizeObserver fired
// on transform changes and the overlay drifted off the element.
//
// Strategy: inject a fixture into the iframe whose ancestor we can
// directly mutate (`outer.style.transform`). Select the inner element,
// snapshot the overlay rect, apply a translate, and assert the overlay
// followed by the same delta — tracking, not drifting.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.ATELIE_BASE_URL ?? "";

test.describe("overlay tracks transform-driven motion", () => {
  test.setTimeout(60_000);

  async function openAnyProject(page: import("@playwright/test").Page) {
    await page.goto(BASE_URL ? `${BASE_URL}/` : "/", { waitUntil: "domcontentloaded" });
    const card = page.getByText("index.html").first();
    await card.waitFor({ timeout: 10_000 });
    await card.click();
    await page.waitForURL(/\/editor/, { timeout: 10_000 });
    await page.waitForSelector("iframe", { timeout: 10_000 });
    const iframe = page.frameLocator("iframe").first();
    await iframe.locator("body").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
  }

  async function injectPanFixture(page: import("@playwright/test").Page) {
    const handle = await page.locator("iframe").elementHandle();
    if (!handle) throw new Error("no iframe");
    const frame = await handle.contentFrame();
    if (!frame) throw new Error("no contentFrame");
    await frame.evaluate(() => {
      const old = document.getElementById("__pan_outer");
      if (old) old.remove();
      // Outer is a transform-target — emulates DCViewport's worldRef.
      const outer = document.createElement("div");
      outer.id = "__pan_outer";
      outer.style.cssText = "position:fixed;left:80px;top:80px;background:white;padding:24px;border:2px solid #888;z-index:9999;font-family:sans-serif";
      const inner = document.createElement("div");
      inner.id = "__pan_inner";
      inner.style.cssText = "font-size:48px;font-weight:700;color:black;line-height:1;margin:0";
      inner.textContent = "Track me";
      outer.appendChild(inner);
      document.body.appendChild(outer);
    });
  }

  /** Read the visible overlay rect (orange selection box) AND the
   *  in-iframe element rect AS PROJECTED INTO THE PARENT VIEWPORT.
   *  Framed mode applies `transform: scale(zoom)` to the iframe so we
   *  read zoom off the inline style and multiply through. */
  async function captureRects(page: import("@playwright/test").Page) {
    return await page.evaluate(() => {
      const overlay = Array.from(document.querySelectorAll<HTMLElement>('div[class*="frameOverlay"] > div'))
        .find((d) => d.getBoundingClientRect().width > 0 && d.style.display !== "none");
      const overlayRect = overlay?.getBoundingClientRect();

      const iframe = document.querySelector("iframe") as HTMLIFrameElement | null;
      if (!iframe) throw new Error("no iframe");
      const ifrRect = iframe.getBoundingClientRect();
      // Pull the zoom factor off the iframe's inline scale transform.
      // In fill mode there's no transform; default to 1.
      const m = (iframe.style.transform || "").match(/scale\(([\d.]+)\)/);
      const zoom = m ? parseFloat(m[1]) : 1;
      const inner = iframe.contentDocument?.getElementById("__pan_inner");
      const innerLocal = inner?.getBoundingClientRect();
      const innerInParent = innerLocal && {
        x: ifrRect.left + innerLocal.left * zoom,
        y: ifrRect.top + innerLocal.top * zoom,
        w: innerLocal.width * zoom,
        h: innerLocal.height * zoom,
      };
      return {
        zoom,
        overlay: overlayRect && { x: overlayRect.left, y: overlayRect.top, w: overlayRect.width, h: overlayRect.height },
        inner: innerInParent,
      };
    });
  }

  test("overlay follows the element when an ancestor's transform changes", async ({ page }, testInfo) => {
    await openAnyProject(page);
    await injectPanFixture(page);

    // Edit mode + click the fixture inner.
    await page.getByRole("button", { name: /^edit$/i }).first().click();
    await page.waitForTimeout(200);

    const iframe = page.frameLocator("iframe").first();
    await iframe.locator("#__pan_inner").click();
    await page.waitForTimeout(400);

    // Snapshot before pan: overlay should already be aligned to inner.
    const before = await captureRects(page);
    expect(before.overlay).toBeTruthy();
    expect(before.inner).toBeTruthy();
    // Sanity: overlay starts within ~3px of the element.
    expect(Math.abs(before.overlay!.x - before.inner!.x)).toBeLessThan(3);
    expect(Math.abs(before.overlay!.y - before.inner!.y)).toBeLessThan(3);

    const beforePath = testInfo.outputPath("before-pan.png");
    await page.screenshot({ path: beforePath, fullPage: false });
    await testInfo.attach("before-pan", { path: beforePath, contentType: "image/png" });

    // Apply a 150x / 80y translate to the OUTER fixture — this is the
    // exact pattern DCViewport uses for pan/zoom. No scroll, no resize,
    // no body-RO trigger. Pre-fix this would have stranded the overlay
    // at its old position.
    const handle = await page.locator("iframe").elementHandle();
    const frame = await handle!.contentFrame();
    await frame!.evaluate(() => {
      const outer = document.getElementById("__pan_outer");
      if (outer) outer.style.transform = "translate3d(150px, 80px, 0)";
    });

    // Wait long enough for the settle window (1s) to cycle a couple
    // of rAF passes after the MutationObserver fires.
    await page.waitForTimeout(300);

    const after = await captureRects(page);
    expect(after.overlay).toBeTruthy();
    expect(after.inner).toBeTruthy();
    // The element moved by (150, 80). The overlay should match the
    // element's NEW position within ~3px (integer rounding).
    expect(Math.abs(after.overlay!.x - after.inner!.x)).toBeLessThan(3);
    expect(Math.abs(after.overlay!.y - after.inner!.y)).toBeLessThan(3);

    const afterPath = testInfo.outputPath("after-pan.png");
    await page.screenshot({ path: afterPath, fullPage: false });
    await testInfo.attach("after-pan", { path: afterPath, contentType: "image/png" });

    // Final screenshot at the journey-runner convention path so the
    // pr-evidence bundler picks it up.
    await page.screenshot({ path: "test-results/journeys-overlay-tracks-transform-final.png", fullPage: false });
  });
});
