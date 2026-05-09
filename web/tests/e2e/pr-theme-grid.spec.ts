// PR evidence — theme + design (two-axis) chrome controls.
//
// Two orthogonal axes drive the editor chrome:
//
//   • THEME  — System / Light / Dark / Retro. Lives in Settings →
//     Appearance (4-pill segmented control, unchanged from before).
//   • DESIGN — null + 12 decorative palettes. Lives in Settings →
//     Design only — both pickers are Settings-only journeys.
//
// Picking a theme always clears the design (so the click is visible);
// picking a design overlays on top of the theme. These tests capture
// (a) the Settings dialog at Appearance + Design (showing all 12
// swatches with mini previews), (b) a design picked from the dialog
// reskinning the chrome, and (c) a sweep of representative designs
// applied programmatically as a CSS pipeline smoke.
//
// Worktree-only: a parent dev server holds :5173, so the spec points
// at :5180 by default. Override with PR_THEME_GRID_BASE_URL.

import { test, expect } from "@playwright/test";

const SHOT_DIR = "test-results/pr-theme-grid";
const BASE_URL = process.env.PR_THEME_GRID_BASE_URL || "http://localhost:5180";

test.describe("PR theme + design — visual evidence", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("editor-model-id", "claude-sonnet-4-6");
    });
  });

  /** Drive: /projects → click a project card → /editor → click gear.
   *  Returns once the Settings dialog is visible. */
  async function openSettings(page: import("@playwright/test").Page) {
    await page.goto(`${BASE_URL}/projects`, { waitUntil: "domcontentloaded" });
    // Pick any existing project. The cards render their name as a div
    // with class containing "cardName" — use the first one.
    const firstCard = page.locator("[class*='card']").first();
    await firstCard.click();
    await page.waitForURL(/\/editor/);
    // Wait for the settings gear to appear in the toolbar.
    const gear = page.getByRole("button", { name: /open settings/i });
    await expect(gear).toBeVisible({ timeout: 10_000 });
    await gear.click();
    await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  }

  test("settings → appearance pills are unchanged", async ({ page }) => {
    await openSettings(page);
    // The dialog opens to Appearance by default. Confirm all 4 pills.
    await expect(page.getByRole("button", { name: /^System$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Light$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Dark$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Retro$/ })).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOT_DIR}/01-settings-appearance.png`, fullPage: true });
  });

  test("settings → design shows all 12 swatches in two groups", async ({ page }) => {
    await openSettings(page);
    // Switch to Design section via the sidebar nav.
    await page.getByRole("button", { name: /^Design$/ }).click();
    // Spot-check coverage: one from each group.
    await expect(page.getByRole("button", { name: /^Violet$/, pressed: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Hornet$/, pressed: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Reset to theme$/i })).toBeVisible();
    await page.waitForTimeout(300);
    // Top of the dialog — visible group labels, status row, light grid.
    await page.screenshot({ path: `${SHOT_DIR}/02a-settings-design-top.png`, fullPage: true });
    // Scroll the dialog content to the bottom so the dark row is in view
    // for the second capture. The Settings dialog scrolls its inner
    // .content div, not the page body.
    await page.evaluate(() => {
      const content = document.querySelector("[role=dialog] [class*=content]") as HTMLElement | null;
      if (content) content.scrollTop = content.scrollHeight;
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOT_DIR}/02b-settings-design-bottom.png`, fullPage: true });
  });

  test("settings → design picking phosphor reskins chrome live", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("button", { name: /^Design$/ }).click();
    await page.getByRole("button", { name: /^Phosphor$/ }).click();
    // Active card now reflects the pick.
    await expect(page.getByRole("button", { name: /^Phosphor$/, pressed: true })).toBeVisible();
    // The dialog itself should reskin since it consumes the same tokens.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIR}/03-settings-design-phosphor-active.png`, fullPage: true });
  });

  for (const designId of ["violet", "vinyl", "phosphor", "hornet"] as const) {
    test(`projects route reskins under ${designId} design`, async ({ page }) => {
      await page.goto(`${BASE_URL}/projects`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("create-project-name")).toBeVisible();
      await page.evaluate((id) => {
        localStorage.setItem("editor.design", id);
        document.documentElement.setAttribute("data-theme", id);
      }, designId);
      await page.waitForTimeout(450);
      await page.screenshot({
        path: `${SHOT_DIR}/04-${designId}.png`,
        fullPage: true,
      });
    });
  }

  test("baseline — no design, theme=light", async ({ page }) => {
    await page.goto(`${BASE_URL}/projects`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("create-project-name")).toBeVisible();
    await page.evaluate(() => {
      localStorage.removeItem("editor.design");
      document.documentElement.removeAttribute("data-theme");
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/05-baseline-light.png`, fullPage: true });
  });
});
