// PR evidence — Phase 1 home shell refactor.
//
// The /projects route was rewritten into a 3-column shell:
//   • sticky app-chrome bar (brand mark + "AA" avatar slot)
//   • always-visible left sidebar with NewProjectForm (replaces modal)
//   • main pane with tab strip ("Projects") above the project grid
//
// These tests don't assert visual output — they capture full-page
// screenshots in each of the three themes plus the inline form-error
// state, so the PR reviewer can eyeball the result. The tests pass
// if the page loads, the sidebar form renders, and the error UI
// surfaces as expected when the create endpoint fails.

import { test, expect } from "@playwright/test";

const SHOT_DIR = "test-results/pr-home-shell";

test.describe("PR home shell — visual evidence", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    // Sonnet for any agent runs (per verify-with-playwright skill).
    await page.addInitScript(() => {
      localStorage.setItem("editor-model-id", "claude-sonnet-4-6");
    });
  });

  test("home renders in default theme", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("create-project-name")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIR}/01-default.png`, fullPage: true });
  });

  test("home renders in retro theme", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("create-project-name")).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "retro";
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/02-retro.png`, fullPage: true });
  });

  test("home renders in dark theme", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("create-project-name")).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOT_DIR}/03-dark.png`, fullPage: true });
  });

  test("inline form error appears when create POST fails", async ({ page }) => {
    // Mock the create endpoint to a 500 so we can capture the inline
    // role="alert" form error (replaces the old alert() popup).
    await page.route("**/api/projects/create", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic 500 for evidence capture" }),
      }),
    );

    await page.goto("/projects", { waitUntil: "domcontentloaded" });
    await page.getByTestId("create-project-name").fill("Evidence Run");
    await page.getByTestId("create-project-submit").click();

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 5_000 });
    await expect(alert).toContainText(/synthetic|500|fail/i);

    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOT_DIR}/04-form-error.png`, fullPage: true });
  });
});
