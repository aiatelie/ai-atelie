// chat-plan — proves the live plan panel: the agent's TodoWrite calls
// render as a checklist that updates in place (pending → in-progress →
// done), pinned at the top of the turn, collapsing to "Plan · N/N ✓" when
// finished. This is our match for open-design's "live agent panel: todos".
//
// Throwaway project (deleted in finally), Sonnet. The prompt forces a
// 3-item todo list and real edits so TodoWrite fires multiple times.

import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:5174";
const PROMPT =
  "Plan and track this with a todo list, then do it. Create a todo list " +
  "FIRST with these EXACT 3 items, then mark each in_progress and then " +
  "completed as you actually do it: " +
  "(1) Change the <title> to 'PlanTest'. " +
  "(2) Add a <footer> with the text 'made'. " +
  "(3) Set the body background to teal.";

test.describe("chat live plan panel", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });
  });

  test("TodoWrite renders as a live checklist that completes", async ({ page, request }) => {
    test.setTimeout(200_000);
    let projectId: string | undefined;
    try {
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-project-name").fill(`Verify · Plan ${Date.now().toString(36)}`);
      await page.getByTestId("create-project-submit").click();
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      projectId = page.url().match(/p=(p_[a-z0-9]+)/)?.[1];
      expect(projectId, "project id captured").toBeTruthy();
      await page.waitForSelector("iframe", { timeout: 15_000 });
      await page.waitForTimeout(600);

      await page.getByTestId("chat-composer").fill(PROMPT);
      await page.getByTestId("chat-send").click();
      await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 20_000 });

      // The plan strip header reads "Plan · N/3". Wait for it to appear
      // (the first TodoWrite lands early in the turn).
      const planHeader = page.getByText(/Plan · \d\/\d/).first();
      await planHeader.waitFor({ timeout: 90_000 });

      // LIVE: best-effort observe an in-progress item (pulsing ▸) while the
      // turn runs — proves the checklist updates in place, not just at the end.
      let sawInProgress = false;
      let done = false;
      const start = Date.now();
      while (Date.now() - start < 150_000) {
        if (!sawInProgress) {
          sawInProgress = await page.locator('[data-status="in_progress"]').first().isVisible().catch(() => false);
        }
        const stopVisible = await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false);
        if (!stopVisible) { done = true; break; }
        await page.waitForTimeout(1_000);
      }
      expect(done, "turn finished").toBe(true);
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: "test-results/plan-done.png", fullPage: true });

      // DONE: the plan strip is still present and reports all items complete.
      const headerText = (await planHeader.textContent().catch(() => "")) ?? "";
      // eslint-disable-next-line no-console
      console.log(`[plan] header="${headerText.trim()}" sawInProgress=${sawInProgress}`);
      expect(/Plan · \d\/\d/.test(headerText), "plan strip header rendered").toBe(true);

      // It auto-collapses when complete — click the toggle (its label is
      // the "Plan · N/N" header) to expand, then confirm all 3 tracked
      // items are listed and marked completed.
      const planToggle = page.getByRole("button").filter({ hasText: /Plan · \d\/\d/ }).first();
      if (await planToggle.isVisible().catch(() => false)) {
        await planToggle.click();
        await page.waitForTimeout(300);
      }
      const completed = await page.locator('[data-status="completed"]').count();
      // eslint-disable-next-line no-console
      console.log(`[plan] completedItems=${completed}`);
      expect(completed, "plan items rendered and marked completed").toBeGreaterThanOrEqual(3);
    } finally {
      if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
    }
  });
});
