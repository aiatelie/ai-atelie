// chat-timeline — proves the Hybrid timeline render:
//   • While a turn runs, reasoning + tool steps show inline as a live
//     "steps" strip (expanded).
//   • When the turn finishes, the steps auto-collapse to a "✓ N steps"
//     toggle; clicking it re-expands the tool chips.
//   • The assistant's prose reply is its own bubble, separate from steps.
//
// Throwaway project (deleted in finally). Sonnet via localStorage. The
// prompt forces a Read tool call so there's at least one step.

import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:5174";
const PROMPT =
  "Use the Read tool to read index.html in this project, then reply in " +
  "ONE short sentence describing what the page contains. Keep it brief.";

test.describe("chat Hybrid timeline", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });
  });

  test("steps render live, auto-collapse on done, prose is its own bubble", async ({ page, request }) => {
    test.setTimeout(180_000);
    let projectId: string | undefined;
    try {
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-project-name").fill(`Verify · Timeline ${Date.now().toString(36)}`);
      await page.getByTestId("create-project-submit").click();
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      projectId = page.url().match(/p=(p_[a-z0-9]+)/)?.[1];
      expect(projectId, "project id captured").toBeTruthy();
      await page.waitForSelector("iframe", { timeout: 15_000 });
      await page.waitForTimeout(600);

      await page.getByTestId("chat-composer").fill(PROMPT);
      await page.getByTestId("chat-send").click();

      // Pending → Stop appears.
      await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 20_000 });

      // LIVE: the inline steps body should appear while running (a tool
      // chip and/or dimmed reasoning). Poll up to 90s for the Read step.
      const stepsBody = page.locator('[class*="stepsBody"]');
      let sawLiveSteps = false;
      const liveStart = Date.now();
      while (Date.now() - liveStart < 90_000) {
        if (await stepsBody.first().isVisible().catch(() => false)) { sawLiveSteps = true; break; }
        // Some turns finish fast; stop polling once the turn is done.
        const stopGone = (await page.getByRole("button", { name: "Stop" }).count()) === 0;
        if (stopGone) break;
        await page.waitForTimeout(1_000);
      }
      await page.screenshot({ path: "test-results/timeline-live.png", fullPage: true });

      // Wait for completion: Stop gone + the collapsed steps summary present.
      const stepsToggle = page.getByRole("button", { name: /step/i });
      let done = false;
      const start = Date.now();
      while (Date.now() - start < 120_000) {
        const stopVisible = await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false);
        const toggleVisible = await stepsToggle.first().isVisible().catch(() => false);
        if (!stopVisible && toggleVisible) { done = true; break; }
        await page.waitForTimeout(2_000);
      }
      await page.screenshot({ path: "test-results/timeline-done.png", fullPage: true });

      expect(sawLiveSteps, "steps strip rendered inline while the turn was running").toBe(true);
      expect(done, "turn finished and steps auto-collapsed to a 'N steps' toggle").toBe(true);

      // Auto-collapsed: the steps body is hidden behind the toggle now.
      expect(await stepsBody.first().isVisible().catch(() => false), "steps body collapsed after done").toBe(false);

      // The prose reply is its own bubble (separate from the steps strip).
      const replyBubble = page.locator('[class*="bubbleAssistant"]').last();
      const replyText = (await replyBubble.textContent().catch(() => "")) ?? "";
      expect(replyText.trim().length, "assistant reply rendered in its own bubble").toBeGreaterThan(3);

      // Expanding the toggle reveals the tool step.
      await stepsToggle.first().click();
      await expect(stepsBody.first()).toBeVisible({ timeout: 5_000 });
      await page.screenshot({ path: "test-results/timeline-expanded.png", fullPage: true });
    } finally {
      if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
    }
  });
});
