// canvas-variations journey
//
// Heaviest baseline journey. Proves: starting from a fresh "page mode"
// project (just index.html), the agent can produce a design canvas
// with two side-by-side variations — one green, one purple — both
// showing the same "Hello World" content.
//
// Why this is load-bearing: it's the canonical "I want to compare two
// looks" workflow, which is the reason a design tool exists. If this
// breaks, the product loses its differentiator.
//
// Time budget: 8 min (one Sonnet turn that does more work than the
// green-background journey: read starter, write a structured layout,
// pick two colors, lay them out side-by-side).
//
// Assertions:
//   1. iframe contains the phrase "Hello World" at least twice (one
//      per variation).
//   2. At least one element with a green-ish computed background.
//   3. At least one element with a purple-ish computed background.
//   4. A project file actually changed on disk (not just chat output).

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Resolve relative to this spec so the journey works from worktrees too:
// <repo>/web/tests/e2e/journeys/<name>.spec.ts → ../../.. = <repo>/web
const PROJECTS_DIR = path.resolve(import.meta.dirname, "../../..", "projects");
const API_BASE = "http://localhost:5174";
const FINAL_SCREENSHOT = "test-results/journeys-canvas-variations-final.png";
const PROJECT_NAME = "Journey · Canvas Variations";

const PROMPT =
  "Convert this page into a design canvas with two side-by-side " +
  "variations. Variation A has a solid green background; variation B " +
  "has a solid purple background. Each variation shows the heading " +
  "'Hello World' centered in white. Use a CSS grid or flexbox layout " +
  "in index.html and style.css — keep it simple, don't add new " +
  "component files.";

function parseRgb(css: string): [number, number, number] | null {
  const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function isGreenish(css: string): boolean {
  const rgb = parseRgb(css);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return g > 80 && g > r + 20 && g > b + 20;
}
function isPurplish(css: string): boolean {
  const rgb = parseRgb(css);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  // Purple: red and blue both meaningful, green low.
  return r > 60 && b > 60 && g < Math.min(r, b) - 20;
}

test.describe("Journey: canvas variations", () => {
  test.setTimeout(8 * 60_000);

  test("agent renders two side-by-side variations (green + purple)", async ({ page, request }) => {
    // Use Sonnet for evidence runs (cheaper + faster, same fidelity).
    await page.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });

    let projectId: string | undefined;
    try {
      // ─── Fresh project ────────────────────────────────────────────
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

      // ─── Send the prompt ──────────────────────────────────────────
      await page.getByTestId("chat-composer").fill(PROMPT);
      await page.getByTestId("chat-send").click();

      // ─── Poll iframe + filesystem ─────────────────────────────────
      const POLL_INTERVAL_MS = 8_000;
      const TIMEOUT_MS = 7 * 60_000;
      const start = Date.now();
      let iframeText = "";
      let backgrounds: string[] = [];
      let satisfied = false;
      while (Date.now() - start < TIMEOUT_MS) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
        const frame = page.frameLocator("iframe").first();
        iframeText = await frame.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
        backgrounds = await frame
          .locator("body, body *")
          .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor))
          .catch(() => []);
        const helloCount = (iframeText.match(/hello\s*world/gi) || []).length;
        const indexBody = await readFile(`${projectDir}/index.html`, "utf8").catch(() => "");
        const styleBody = await readFile(`${projectDir}/style.css`, "utf8").catch(() => "");
        const fileChanged =
          !/Empty canvas\. Tell the AI what to build\./i.test(indexBody) ||
          /\S/.test(styleBody);
        const sawGreen = backgrounds.some(isGreenish);
        const sawPurple = backgrounds.some(isPurplish);
        if (helloCount >= 2 && sawGreen && sawPurple && fileChanged) {
          satisfied = true;
          break;
        }
      }
      expect(
        satisfied,
        `iframe should show ≥2 "Hello World" with both green + purple backgrounds ` +
          `(text head: "${iframeText.slice(0, 200)}"; bgs: ${backgrounds.slice(0, 6).join(" / ")})`,
      ).toBe(true);

      // Sanity: agent actually edited a file.
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
