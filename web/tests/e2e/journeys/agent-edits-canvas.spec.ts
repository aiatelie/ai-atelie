// agent-edits-canvas journey
//
// The load-bearing baseline. Proves the actual product: a user opens
// a fresh project, sends a chat prompt, and the Claude Code agent
// writes to disk → the iframe canvas paints the result.
//
// Time budget: 8 min (~480s). Agent latency dominates; the assertions
// themselves run in milliseconds. We poll iframe content on a 6-sec
// cadence rather than racing the chat thread state, because the
// user-truth is what's painted on the canvas, not which message is
// streaming. If the agent is consistently slower than 8 min for this
// scope, fix the agent — don't pad the budget.
//
// Cleanup: the spec deletes its project in finally; the
// cleanup-snapshot journey enforces the no-leak guarantee globally.
//
// Migrated from web/tests/e2e/cuj.spec.ts. The old test asked for two
// Hello-World variants and asserted on light/dark color tokens;
// simplified here to one user-visible change ("Hi there") so the
// success criterion is robust to agent interpretation differences.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

const PROJECTS_DIR = "/Users/kadu/developer/aiatilie/ai-atelie/web/projects";
const API_BASE = "http://localhost:5174";
const FINAL_SCREENSHOT = "test-results/journeys-agent-edits-canvas-final.png";

const PROMPT =
  "Make the page show the heading 'Hi there' as the only visible text, " +
  "centered, in a large bold font. Edit index.html and style.css; " +
  "don't add new component files. Keep it simple.";

test.describe("Journey: agent edits canvas", () => {
  test.setTimeout(8 * 60_000);

  test("agent receives a prompt, writes files, canvas paints the result", async ({ page, request }) => {
    // Force the chat to use Sonnet for evidence runs — same convention
    // as the verify-with-playwright skill. Cheaper + faster than Opus
    // with no loss of fidelity for our assertions. Setting it via
    // addInitScript means every page load (incl. iframe sub-frames)
    // sees the value before the editor reads it.
    await page.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });

    let projectId: string | undefined;
    try {
      // ─── Create a project ─────────────────────────────────────────
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-project-name").fill("Journey · Agent Edits");
      await page.getByTestId("create-project-submit").click();
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      const m = page.url().match(/p=(p_[a-z0-9]+)/);
      projectId = m?.[1];
      expect(projectId, "project id captured from URL").toBeTruthy();
      const projectDir = `${PROJECTS_DIR}/${projectId}`;
      expect(existsSync(projectDir), `project dir ${projectDir} exists`).toBe(true);

      // ─── Iframe up ────────────────────────────────────────────────
      await page.waitForSelector("iframe", { timeout: 15_000 });
      await expect(page.locator("iframe").first()).toBeVisible();

      // ─── Send the chat prompt ─────────────────────────────────────
      await page.getByTestId("chat-composer").fill(PROMPT);
      await page.getByTestId("chat-send").click();

      // ─── Poll iframe + filesystem until the agent finishes ────────
      // Two signals, both required:
      //   (a) iframe body text contains "Hi there" (the user-visible
      //       result of the prompt)
      //   (b) index.html no longer contains the empty-canvas starter
      //       string (proves the agent actually wrote, not just typed)
      const POLL_INTERVAL_MS = 6_000;
      const TIMEOUT_MS = 7 * 60_000;
      const start = Date.now();
      let iframeText = "";
      let satisfied = false;
      while (Date.now() - start < TIMEOUT_MS) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
        iframeText = await page
          .frameLocator("iframe")
          .first()
          .locator("body")
          .innerText({ timeout: 5_000 })
          .catch(() => "");
        const indexBody = await readFile(`${projectDir}/index.html`, "utf8").catch(() => "");
        const sawText = /hi\s*there/i.test(iframeText);
        const indexChanged = !/Empty canvas\. Tell the AI what to build\./i.test(indexBody);
        if (sawText && indexChanged) {
          satisfied = true;
          break;
        }
      }
      expect(
        satisfied,
        `iframe should show the requested text and index.html should no longer be the starter ` +
          `(iframe got: ${iframeText.slice(0, 200)})`,
      ).toBe(true);

      // Sanity: the project dir has at least one starter file still.
      const filesNow = await readdir(projectDir);
      expect(filesNow).toEqual(expect.arrayContaining(["index.html"]));

      await page.screenshot({ path: FINAL_SCREENSHOT, fullPage: false });
    } finally {
      if (projectId) {
        await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
      }
    }
  });
});
