// agent-edits-canvas journey
//
// The load-bearing baseline. Proves the actual product: a user opens
// a fresh project, sends a chat prompt, and the Claude Code agent
// writes to disk → the iframe canvas paints the result.
//
// The prompt asks for a green background — a single well-defined
// visible attribute that's easy to assert on via computed style. Don't
// over-spec; we want this to pass under any reasonable agent
// interpretation (bg color, class, inline style, hex/rgb/named — all
// flow through getComputedStyle to the same RGB triple).
//
// Time budget: 8 min (~480s). Agent latency dominates; the assertions
// themselves run in milliseconds. We poll iframe content on a 6-sec
// cadence rather than racing the chat thread state, because the
// user-truth is what's painted on the canvas, not which message is
// streaming.
//
// Cleanup: the spec deletes its project in finally; the
// cleanup-snapshot journey enforces the no-leak guarantee globally.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

const PROJECTS_DIR = "/Users/kadu/developer/aiatilie/ai-atelie/web/projects";
const API_BASE = "http://localhost:5174";
const FINAL_SCREENSHOT = "test-results/journeys-agent-edits-canvas-final.png";

const PROMPT =
  "Make the page background a simple solid green. Edit index.html or " +
  "style.css. Don't add new component files; keep it minimal.";

/** Parse a CSS color (rgb/rgba/named) into [r, g, b] or null. */
function parseRgb(css: string): [number, number, number] | null {
  const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** A "green-ish" color has the green channel clearly dominant.
 *  Tolerant enough that #00C200, rgb(0,128,0), forestgreen, lime, etc.
 *  all pass; strict enough that white/black/red don't. */
function isGreenish(css: string): boolean {
  const rgb = parseRgb(css);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return g > 80 && g > r + 20 && g > b + 20;
}

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
      //   (a) iframe body computed background is green-ish
      //   (b) index.html or style.css was actually written (the agent
      //       didn't just type)
      const POLL_INTERVAL_MS = 6_000;
      const TIMEOUT_MS = 7 * 60_000;
      const start = Date.now();
      let lastBg = "";
      let satisfied = false;
      while (Date.now() - start < TIMEOUT_MS) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
        lastBg = await page
          .frameLocator("iframe")
          .first()
          .locator("body")
          .evaluate((el) => getComputedStyle(el).backgroundColor)
          .catch(() => "");
        const indexBody = await readFile(`${projectDir}/index.html`, "utf8").catch(() => "");
        const styleBody = await readFile(`${projectDir}/style.css`, "utf8").catch(() => "");
        const indexChanged = !/Empty canvas\. Tell the AI what to build\./i.test(indexBody);
        const styleChanged = /green|#0?[0-9a-f]{0,2}f{2}[0-9a-f]{0,2}|background/i.test(styleBody);
        if (isGreenish(lastBg) && (indexChanged || styleChanged)) {
          satisfied = true;
          break;
        }
      }
      expect(
        satisfied,
        `iframe body background should be green-ish AND a project file should have been edited ` +
          `(last bg: ${lastBg || "(none)"})`,
      ).toBe(true);

      await page.screenshot({ path: FINAL_SCREENSHOT, fullPage: false });
    } finally {
      if (projectId) {
        await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
      }
    }
  });
});
