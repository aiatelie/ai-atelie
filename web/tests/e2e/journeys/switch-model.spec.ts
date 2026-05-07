// switch-model journey
//
// Proves the chat's model picker is reachable, switching the model
// updates the picker button label, and the choice persists across a
// full reload (localStorage-backed).
//
// Default model is Claude Opus 4.7. The journey switches to Claude
// Sonnet 4.6 (or whatever model whose label contains "Sonnet" comes
// first in the menu) — semantically: "user changes model and the
// change sticks."
//
// No agent invoked — UI-only.

import { expect, test } from "@playwright/test";

const PROJECTS_DIR = "/Users/kadu/developer/aiatilie/ai-atelie/web/projects";
const API_BASE = "http://localhost:5174";
const FINAL_SCREENSHOT = "test-results/journeys-switch-model-final.png";
const PROJECT_NAME = "Journey · Switch Model";

test.describe("Journey: switch model", () => {
  test.setTimeout(60_000);

  test("model picker switches from Opus to Sonnet and persists", async ({ page, request }) => {
    let projectId: string | undefined;
    try {
      // Create a project so the editor mounts with a chat composer.
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-project-name").fill(PROJECT_NAME);
      await page.getByTestId("create-project-submit").click();
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      const m = page.url().match(/p=(p_[a-z0-9]+)/);
      projectId = m?.[1];
      expect(projectId).toBeTruthy();

      // Default model: Opus.
      const picker = page.getByTestId("model-selector-button").first();
      await expect(picker, "model picker button visible").toBeVisible({ timeout: 8_000 });
      await expect(picker).toContainText(/Opus/i, { timeout: 5_000 });

      // Open the menu, pick Sonnet.
      await picker.click();
      const sonnetItem = page.getByRole("button", { name: /Claude Sonnet/i }).first();
      await expect(sonnetItem, "Sonnet item visible in picker menu").toBeVisible();
      await sonnetItem.click();

      // Picker label flips.
      await expect(picker).toContainText(/Sonnet/i, { timeout: 3_000 });

      // Reload — selection persists via localStorage.
      await page.reload({ waitUntil: "domcontentloaded" });
      const pickerAfter = page.getByTestId("model-selector-button").first();
      await expect(pickerAfter).toContainText(/Sonnet/i, { timeout: 8_000 });

      await page.screenshot({ path: FINAL_SCREENSHOT, fullPage: false });
    } finally {
      if (projectId) {
        await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
      }
    }
  });
});
