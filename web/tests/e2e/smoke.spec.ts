import { test, expect } from "@playwright/test";

// Minimal smoke test — confirms the dev server is reachable and the
// app shell renders. Used by the verify-with-playwright skill as a
// preflight before driving any real scenario.
test("app shell loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/AI Atelie|Atelie|atelie/i);
});
