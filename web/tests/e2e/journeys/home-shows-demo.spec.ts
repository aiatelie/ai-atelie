// home-shows-demo journey
//
// Proves: the repo always ships with a working demo project. The home
// page renders the demo tile, clicking it opens /editor?p=demo, and
// the iframe canvas paints content from the demo's index.html.
//
// Why it's load-bearing: a clean clone + bun run dev should give a
// new user something to look at immediately. If the demo silently
// disappears (gitignored by accident, missing manifest, etc.) we
// catch it here before users do.
//
// No project gets created, no cleanup needed.

import { expect, test } from "@playwright/test";

const FINAL_SCREENSHOT = "test-results/journeys-home-shows-demo-final.png";

test.describe("Journey: home shows demo", () => {
  test.setTimeout(45_000);

  test("demo tile is on home and opens a real canvas", async ({ page }) => {
    await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });

    // Demo project tile (its name starts with "AI Atelie demo").
    const demoTile = page.getByRole("link", { name: /AI Atelie demo/i }).first();
    const demoTileFallback = page.locator("text=/AI Atelie demo/i").first();
    const tile = (await demoTile.count()) > 0 ? demoTile : demoTileFallback;
    await expect(tile, "demo tile visible on /projects").toBeVisible();

    await tile.click();

    // Editor with the demo project id.
    await page.waitForURL(/\/editor.*p=demo/, { timeout: 15_000 });

    // Iframe canvas paints — content varies, but it must be non-empty.
    await page.waitForSelector("iframe", { timeout: 15_000 });
    const iframeText = await page
      .frameLocator("iframe")
      .first()
      .locator("body")
      .innerText({ timeout: 8_000 })
      .catch(() => "");
    expect(
      iframeText.trim().length,
      `demo iframe should render non-empty content (got first 200: ${iframeText.slice(0, 200)})`,
    ).toBeGreaterThan(20);

    await page.screenshot({ path: FINAL_SCREENSHOT, fullPage: false });
  });
});
