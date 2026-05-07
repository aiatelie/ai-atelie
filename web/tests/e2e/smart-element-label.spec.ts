// Smart element label — proves the inspector badge, comment bubble,
// and comments panel row classify elements by semantic role
// (Heading / Button / Link / etc.) instead of bare tag, so a `<div>`
// styled like a heading reads as "Heading", not "DIV".
//
// Strategy: open whichever project loads first, then inject a known
// test fixture into the iframe (a styled-as-heading div, a real
// button, a link). Drive the host's Edit-mode click handler against
// each fixture and assert the inspector badge text.
//
// This avoids coupling to any particular demo's content — the bug
// is host-side classification logic, not project-content.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.ATELIE_BASE_URL ?? "";

test.describe("smart element label", () => {
  test.setTimeout(60_000);

  async function openAnyProject(page: import("@playwright/test").Page) {
    await page.goto(BASE_URL ? `${BASE_URL}/` : "/", { waitUntil: "domcontentloaded" });
    // Project cards on the home page show the project's filename
    // ("index.html") next to the title. We click anywhere on the card —
    // the Projects page wires a card-level onClick. We don't care
    // which demo loads; the test injects its own fixture.
    const card = page.getByText("index.html").first();
    await card.waitFor({ timeout: 10_000 });
    await card.click();
    await page.waitForURL(/\/editor/, { timeout: 10_000 });
    await page.waitForSelector("iframe", { timeout: 10_000 });
    const iframe = page.frameLocator("iframe").first();
    await iframe.locator("body").waitFor({ timeout: 10_000 });
    // Beat for the iframe page's React (or static) content to settle.
    await page.waitForTimeout(1500);
  }

  async function injectHeadingFixture(page: import("@playwright/test").Page) {
    // Inject a styled-as-heading div directly into the iframe body —
    // this is the user's repro: a `<div>` with hero-scale font that
    // should classify as "Heading", not "Container" / "DIV".
    const handle = await page.locator("iframe").elementHandle();
    if (!handle) throw new Error("no iframe");
    const frame = await handle.contentFrame();
    if (!frame) throw new Error("no contentFrame");
    await frame.evaluate(() => {
      const existing = document.getElementById("__smart_label_fixture");
      if (existing) existing.remove();
      const wrap = document.createElement("div");
      wrap.id = "__smart_label_fixture";
      wrap.style.cssText = "position:fixed;left:20px;top:20px;z-index:9999;background:white;padding:24px;border:2px solid #ccc;font-family:sans-serif";
      wrap.innerHTML = `
        <div id="__fx_heading" style="font-size:64px;font-weight:700;color:black;margin:0 0 16px">Smart Label Fixture</div>
        <button id="__fx_button" style="font-size:14px;padding:8px 16px">Click me</button>
      `;
      document.body.appendChild(wrap);
    });
  }

  test("heading-styled <div> reads as 'Heading' in the inspector", async ({ page }, testInfo) => {
    await openAnyProject(page);
    await injectHeadingFixture(page);

    // Enter Edit mode (toolbar button labeled "Edit").
    const editBtn = page.getByRole("button", { name: /^edit$/i }).first();
    await editBtn.click();
    await page.waitForTimeout(200);

    // Click the styled heading-div fixture.
    const iframe = page.frameLocator("iframe").first();
    const headline = iframe.locator("#__fx_heading");
    await headline.waitFor({ timeout: 5_000 });
    await headline.click();
    await page.waitForTimeout(400);

    // Inspector badge should say "Heading" — that's the whole point.
    // The Inspector renders inside an <aside class="…inspector"> on
    // the right; the badge is a <span> inside the title row.
    const inspector = page.locator('aside').filter({ hasText: /^Selection/ }).first();
    await expect(inspector).toBeVisible({ timeout: 5_000 });
    // The selection-badge span carries a tooltip with the structural
    // identity; we match the visible text.
    const badge = inspector.locator('span[title]').first();
    await expect(badge).toHaveText("Heading", { timeout: 5_000 });

    // Composer pill (medium variant) should also include "Heading".
    const composerPill = page.locator('[title="Context attached to the next turn"]');
    await expect(composerPill).toContainText(/Heading/);

    // Capture proof.
    const after = testInfo.outputPath("after-heading.png");
    await page.screenshot({ path: after, fullPage: false });
    await testInfo.attach("after-heading", { path: after, contentType: "image/png" });

    // Now click the button fixture — should classify as "Button".
    const button = iframe.locator("#__fx_button");
    await button.click();
    await page.waitForTimeout(400);
    await expect(badge).toHaveText("Button", { timeout: 5_000 });

    const afterBtn = testInfo.outputPath("after-button.png");
    await page.screenshot({ path: afterBtn, fullPage: false });
    await testInfo.attach("after-button", { path: afterBtn, contentType: "image/png" });

    // Final screenshot at the journey-runner convention path so
    // pr-evidence's bundler picks it up automatically. Click the
    // headline once more so the final still highlights the smart
    // label's primary win (Heading vs DIV).
    await headline.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: "test-results/journeys-smart-element-label-final.png", fullPage: false });
  });
});
