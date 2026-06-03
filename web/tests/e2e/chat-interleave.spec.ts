// chat-interleave — proves the canonical event log preserves true
// chronological interleave: text → tool → text renders as
// bubble → steps-strip → bubble, NOT the old "all prose then all tools"
// flatten that produced the 9-tools/6-entries drift.
//
// The turn is driven through the Phase 4 canonical pipeline end-to-end
// (server `canon` channel → ring buffer → wire → frontend fold →
// project() → render). A forceful, ordered prompt makes the model emit a
// sentence, THEN call a tool, THEN emit another sentence — an ordering the
// old reducer literally could not render, so a green run is meaningful.
//
// Throwaway project (deleted in finally). Sonnet via localStorage.

import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:5174";
const PROMPT =
  "Do these steps in this EXACT order, and do not skip or reorder them: " +
  "(1) In one short sentence, tell me you are about to inspect the project. " +
  "(2) Then use the Read tool to read index.html. " +
  "(3) Then in one short sentence, confirm you finished reading it. " +
  "It is important that the first sentence comes BEFORE the Read tool call.";

test.describe("chat canonical interleave", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });
  });

  test("text → tool → text renders in true order (interleave preserved)", async ({ page, request }) => {
    test.setTimeout(180_000);
    let projectId: string | undefined;
    try {
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-project-name").fill(`Verify · Interleave ${Date.now().toString(36)}`);
      await page.getByTestId("create-project-submit").click();
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      projectId = page.url().match(/p=(p_[a-z0-9]+)/)?.[1];
      expect(projectId, "project id captured").toBeTruthy();
      await page.waitForSelector("iframe", { timeout: 15_000 });
      await page.waitForTimeout(600);

      await page.getByTestId("chat-composer").fill(PROMPT);
      await page.getByTestId("chat-send").click();
      await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 20_000 });

      // Wait for completion: Stop gone + a collapsed steps toggle present.
      const stepsToggle = page.getByRole("button", { name: /step/i });
      let done = false;
      const start = Date.now();
      while (Date.now() - start < 150_000) {
        const stopVisible = await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false);
        const toggleVisible = await stepsToggle.first().isVisible().catch(() => false);
        if (!stopVisible && toggleVisible) { done = true; break; }
        await page.waitForTimeout(2_000);
      }
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: "test-results/interleave-done.png", fullPage: true });
      expect(done, "turn finished with at least one tools strip").toBe(true);

      // Walk the assistant turn's render units IN DOM ORDER and classify
      // each as a prose bubble or a tools strip. We only need the relative
      // order, so reasoning blocks/other chrome are ignored.
      const turn = page.locator('[class*="assistantTurn"]').last();
      const kinds: string[] = await turn
        .locator('[class*="stepsStrip"], [class*="bubbleAssistant"]')
        .evaluateAll((els) =>
          els.map((el) => {
            const cls = el.getAttribute("class") || "";
            if (/stepsStrip/.test(cls)) return "tools";
            // A bubble with visible prose (ignore empty/live-status shells).
            return (el.textContent || "").trim().length > 2 ? "text" : "other";
          }),
        );

      const firstTools = kinds.indexOf("tools");
      const textBefore = kinds.slice(0, firstTools).includes("text");
      const textAfter = kinds.slice(firstTools + 1).includes("text");

      expect(firstTools, "a tools strip was rendered").toBeGreaterThanOrEqual(0);
      // The headline assertion: prose exists BOTH before and after the tool
      // strip → the canonical projection kept the true interleave order.
      expect(textBefore, "prose bubble rendered BEFORE the tool strip").toBe(true);
      expect(textAfter, "prose bubble rendered AFTER the tool strip").toBe(true);
    } finally {
      if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
    }
  });
});
