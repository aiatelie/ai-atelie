// home-loads journey
//
// Smallest possible baseline check: the app shell renders, the home
// page is reachable, and the "Create project" form is visible. No
// agent, no project state, no iframe — runs in a couple of seconds.
//
// Why it's @baseline: if this fails, every other journey is doomed.
// Run it first and bail loud if it goes red.
//
// Evidence: video.webm (Playwright auto) + final.png (taken explicitly
// at the end so the runner has a deterministic path to upload).

import { expect, test } from "@playwright/test";

const FINAL_SCREENSHOT = "test-results/journeys-home-loads-final.png";

test.describe("Journey: home loads", () => {
  test.setTimeout(30_000);

  test("home page renders with the project create form", async ({ page }) => {
    // Navigate directly to /projects with journey-mode so the home
    // grid is filtered to demo + Journey · *. The bare / redirect
    // strips query strings, so we skip it.
    await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/AI Atelie/i);

    // Sidebar form is the entry affordance for project creation; it's
    // the load-bearing surface this journey proves still works.
    const nameInput = page.getByTestId("create-project-name");
    await expect(nameInput).toBeVisible();
    await expect(page.getByTestId("create-project-submit")).toBeVisible();

    // Confirm the sidebar form input is interactive (not just present).
    await nameInput.click();
    await expect(nameInput).toBeFocused();

    await page.screenshot({ path: FINAL_SCREENSHOT, fullPage: false });
  });
});
