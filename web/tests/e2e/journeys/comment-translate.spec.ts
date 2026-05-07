// comment-translate journey
//
// Proves the comments-to-chat workflow end-to-end. The agent first
// produces a "Hello World" page; the user enters Comment mode, clicks
// the heading inside the iframe, leaves a note ("translate to
// Spanish"), and hits Send to chat. The agent receives the comment
// payload + the anchored element context, edits the file, and the
// iframe paints "hola mundo".
//
// Two agent turns: ~60-90 seconds with Sonnet on the load-bearing
// path. Per-test timeout 8 minutes — same as the other agent
// journeys, plenty of margin.

import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

const PROJECTS_DIR = "/Users/kadu/developer/aiatilie/ai-atelie/web/projects";
const API_BASE = "http://localhost:5174";
const FINAL_SCREENSHOT = "test-results/journeys-comment-translate-final.png";
const PROJECT_NAME = "Journey · Comment Translate";

const FIRST_PROMPT =
  "Make this page show only the heading 'Hello World' centered, " +
  "in a large bold font. Edit index.html and style.css.";

const COMMENT_TEXT =
  "Translate this heading to Spanish — say 'hola mundo' instead of " +
  "'Hello World'. Keep the same layout and styling.";

test.describe("Journey: comment translate", () => {
  test.setTimeout(8 * 60_000);

  test("comment on heading → agent translates to hola mundo", async ({ page, request }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });

    let projectId: string | undefined;
    try {
      // ─── 1. Create project + first agent turn (Hello World) ──────
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-project-name").fill(PROJECT_NAME);
      await page.getByTestId("create-project-submit").click();
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      const m = page.url().match(/p=(p_[a-z0-9]+)/);
      projectId = m?.[1];
      expect(projectId).toBeTruthy();
      const projectDir = `${PROJECTS_DIR}/${projectId}`;
      expect(existsSync(projectDir)).toBe(true);

      await page.waitForSelector("iframe", { timeout: 15_000 });

      await page.getByTestId("chat-composer").fill(FIRST_PROMPT);
      await page.getByTestId("chat-send").click();

      // Poll until iframe shows "Hello World".
      const POLL_INTERVAL_MS = 6_000;
      const HELLO_TIMEOUT = 5 * 60_000;
      const helloStart = Date.now();
      let iframeText = "";
      while (Date.now() - helloStart < HELLO_TIMEOUT) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
        iframeText = await page
          .frameLocator("iframe")
          .first()
          .locator("body")
          .innerText({ timeout: 5_000 })
          .catch(() => "");
        if (/hello\s*world/i.test(iframeText)) break;
      }
      expect(iframeText, "iframe should contain Hello World after first turn").toMatch(/hello\s*world/i);

      // ─── 2. Switch to Comment mode ────────────────────────────────
      const commentBtn = page.getByRole("button", { name: /^Comment$/i });
      await expect(commentBtn).toBeVisible();
      await commentBtn.click();
      await expect(commentBtn).toHaveAttribute("aria-pressed", "true");

      // ─── 3. Click the Hello World heading inside the iframe ───────
      // The DM bridge intercepts the click and surfaces a comment
      // bubble at that element's anchor. Real DOM click — no
      // simulated coords.
      const headingInFrame = page.frameLocator("iframe").first().locator("text=/hello\\s*world/i").first();
      await expect(headingInFrame, "heading visible inside iframe").toBeVisible();
      await headingInFrame.click();

      // ─── 4. Comment bubble appears; fill + Send to chat ───────────
      const bubbleTextarea = page.locator("textarea[placeholder*='Leave a note']");
      await expect(bubbleTextarea, "comment bubble textarea visible").toBeVisible({ timeout: 8_000 });
      await bubbleTextarea.fill(COMMENT_TEXT);
      const sendBtn = page.getByRole("button", { name: /Send to chat/i });
      await expect(sendBtn).toBeEnabled();
      await sendBtn.click();

      // ─── 5. Poll iframe until it shows "hola mundo" ───────────────
      const TRANSLATE_TIMEOUT = 5 * 60_000;
      const transStart = Date.now();
      let satisfied = false;
      while (Date.now() - transStart < TRANSLATE_TIMEOUT) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
        iframeText = await page
          .frameLocator("iframe")
          .first()
          .locator("body")
          .innerText({ timeout: 5_000 })
          .catch(() => "");
        if (/hola\s*mundo/i.test(iframeText)) {
          satisfied = true;
          break;
        }
      }
      expect(
        satisfied,
        `iframe should show "hola mundo" after the comment is promoted ` +
          `(last seen: "${iframeText.slice(0, 200)}")`,
      ).toBe(true);

      await page.screenshot({ path: FINAL_SCREENSHOT, fullPage: false });
    } finally {
      if (projectId) {
        await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
      }
    }
  });
});
