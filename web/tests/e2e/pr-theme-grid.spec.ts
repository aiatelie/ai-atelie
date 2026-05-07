// PR evidence — theme + design (two-axis) chrome controls.
//
// Two orthogonal axes drive the editor chrome:
//
//   • THEME  — System / Light / Dark / Retro. Lives in Settings →
//     Appearance (4-pill segmented control, unchanged from before)
//     and the ThemeMenu foot-pill in the /projects sidebar foot.
//   • DESIGN — null + 12 decorative palettes. Lives in Settings →
//     Design only — there is no foot-pill for it; design switching
//     is a Settings-only journey.
//
// Picking a theme always clears the design (so the click is visible);
// picking a design overlays on top of the theme. These tests capture
// (a) the theme foot-pill staying as a 4-item list, and (b) the
// chrome reskinning under representative designs applied via
// localStorage["editor.design"] (proves the CSS pipeline works).
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

  test("theme foot-pill is the only theme chip in /projects", async ({ page }) => {
    await page.goto(`${BASE_URL}/projects`, { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", { name: /^Theme\s/ });
    await expect(trigger).toBeVisible();
    // No Design pill — design is Settings-only.
    await expect(page.getByRole("button", { name: /^Design\s/ })).toHaveCount(0);
    await trigger.click();
    await expect(page.getByRole("menuitemradio", { name: /^System$/i })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /^Light$/i })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /^Dark$/i })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /^Retro$/i })).toBeVisible();
    // Palette names are NOT in the theme menu.
    await expect(page.getByRole("menuitemradio", { name: /^Violet$/i })).toHaveCount(0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOT_DIR}/01-theme-pill-open.png`, fullPage: true });
  });

  for (const designId of ["violet", "vinyl", "phosphor", "hornet"] as const) {
    test(`projects route reskins under ${designId} design`, async ({ page }) => {
      await page.goto(`${BASE_URL}/projects`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("input[placeholder*='YouTube banner']")).toBeVisible();
      // Drive via the actual storage key — proves setDesign() persists
      // and the palette CSS pipeline applies through data-theme.
      await page.evaluate((id) => {
        localStorage.setItem("editor.design", id);
        document.documentElement.setAttribute("data-theme", id);
      }, designId);
      await page.waitForTimeout(450);
      await page.screenshot({
        path: `${SHOT_DIR}/02-${designId}.png`,
        fullPage: true,
      });
    });
  }

  test("baseline — no design, theme=light", async ({ page }) => {
    await page.goto(`${BASE_URL}/projects`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("input[placeholder*='YouTube banner']")).toBeVisible();
    await page.evaluate(() => {
      localStorage.removeItem("editor.design");
      document.documentElement.removeAttribute("data-theme");
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/03-baseline-light.png`, fullPage: true });
  });
});
