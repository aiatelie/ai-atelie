// Composer polish — three small features added together because they
// all touch the same Composer in `web/src/components/editor/ChatSidebar.tsx`:
//
//   1. `/compress` slash command appears in the slash menu.
//   2. Typing `@` opens a project-file picker; picking inserts the path.
//   3. Dropping a non-image text file appends it as a fenced code block.
//
// All three are UI-only — no agent run needed, so this spec is fast and
// cheap. We use the bundled demo project so the file list is stable.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.ATELIE_BASE_URL ?? "";

test.describe("composer polish", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // Force Sonnet so any accidental agent call is cheap, not Opus.
    await page.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });
    await page.goto(BASE_URL ? `${BASE_URL}/` : "/", { waitUntil: "domcontentloaded" });
    const card = page.getByText("index.html").first();
    await card.waitFor({ timeout: 10_000 });
    await card.click();
    await page.waitForURL(/\/editor/, { timeout: 10_000 });
    await page.waitForSelector("iframe", { timeout: 10_000 });
    await page.waitForTimeout(500);
  });

  test("/compress slash command shows in the menu", async ({ page }) => {
    const composer = page.getByTestId("chat-composer");
    await composer.waitFor({ timeout: 10_000 });
    await composer.click();
    await composer.fill("/comp");

    // The slash menu is rendered above the composer; the row label is the
    // command name. Look for "/compress" in the slash menu items.
    const compress = page.getByRole("option", { name: /\/compress/ });
    await expect(compress).toBeVisible({ timeout: 5_000 });

    await page.screenshot({ path: "test-results/composer-polish-compress.png", fullPage: false });
  });

  test("@ opens the file picker and Tab inserts the path", async ({ page }) => {
    const composer = page.getByTestId("chat-composer");
    await composer.waitFor({ timeout: 10_000 });
    await composer.click();
    // pressSequentially simulates real keystrokes so selectionStart
    // tracks naturally — fill() doesn't always carry a reliable caret.
    await composer.pressSequentially("look at @inde", { delay: 30 });

    // The mention popover lists project files. The bundled demo has an
    // `index.html` at its root, so a query of "inde" must match it.
    const popover = page.getByTestId("mention-popover");
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await expect(popover.getByText("@index.html")).toBeVisible();

    // Tab picks the highlighted entry (first by default).
    await composer.press("Tab");

    // After the pick the textarea must contain the inserted path. We
    // don't pin the exact prefix because the demo project's file path
    // could be either `index.html` or a subpath; just assert we're past
    // the partial query.
    const value = await composer.inputValue();
    expect(value).toMatch(/look at @\S+\.html /);

    await page.screenshot({ path: "test-results/composer-polish-mention.png", fullPage: false });
  });

  test("dropping a text file appends as a fenced code block", async ({ page }) => {
    const composer = page.getByTestId("chat-composer");
    await composer.waitFor({ timeout: 10_000 });
    await composer.click();
    await composer.fill("here's the spec:");

    // Construct a DataTransfer with a small text file in-page and fire
    // a real drop event on the composer. Playwright's setInputFiles
    // works for <input type=file> but not for textarea drop, so we go
    // direct.
    await page.evaluate(() => {
      const file = new File(["title: Hello\nbody: world\n"], "spec.md", { type: "text/markdown" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ta = document.querySelector('[data-testid="chat-composer"]') as HTMLElement;
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
      // Drop is handled on the form ancestor — bubble up.
      ta.dispatchEvent(drop);
    });

    // Wait a beat for the FileReader and setText round-trip.
    await page.waitForTimeout(500);

    const value = await composer.inputValue();
    expect(value).toContain("here's the spec:");
    expect(value).toContain("```md spec.md");
    expect(value).toContain("title: Hello");

    await page.screenshot({ path: "test-results/composer-polish-textdrop.png", fullPage: false });
  });
});
