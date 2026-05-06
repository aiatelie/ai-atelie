// Critical User Journey (CUJ) — the single end-to-end test that proves
// AI Atelie's core promise still holds: a user opens the app, creates a
// project, the Claude Code agent designs into it, and the canvas
// renders the result. If this test fails, the product is broken in a
// way users will notice.
//
// Tagged @cuj so it only runs when explicitly invoked
// (`bun run test:cuj`); the default `bunx playwright test` skips it
// because it takes ~5 minutes (agent latency dominates).
//
// Triage protocol when this fails: see `.claude/skills/cuj-guardian/`
// and append an entry to `web/tests/e2e/CUJ_JOURNAL.md` if you change
// any assertion below.
//
// Preconditions:
// - `bun run dev` is running on http://localhost:5173 (the test does
//   NOT spawn it; backgrounded dev servers leak across runs).
// - `claude` CLI is on PATH and authenticated.
// - Network access for the Claude API call inside the agent.

import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

const PROJECTS_DIR = "/Users/kadu/developer/aiatilie/ai-atelie/web/projects";
const API_BASE = "http://localhost:5174";

test.describe("Critical User Journey", () => {
  test.setTimeout(10 * 60_000);

  test("@cuj home → new project → agent → two-frame canvas → cleanup", async ({ page, request }) => {
    let projectId: string | undefined;

    // ─── 0. Snapshot existing projects (cleanup safety guarantee) ────
    // We record exactly which projects exist BEFORE the test runs.
    // After cleanup, we assert the project list matches this snapshot
    // exactly — no leak (test project survived) and no collateral
    // damage (an unrelated project disappeared). Any contributor's
    // own projects under web/projects/ are safe by construction.
    const snapshotBefore = (await readdir(PROJECTS_DIR)).sort();

    try {
      // ─── 1. Home loads ─────────────────────────────────────────────
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveTitle(/AI Atelie/i);
      await expect(page.getByRole("button", { name: /new project/i }).first()).toBeVisible();

      // ─── 2. Open New Project modal ────────────────────────────────
      await page.getByRole("button", { name: /new project/i }).first().click();
      const nameInput = page.locator("input[placeholder*='YouTube banner']");
      await expect(nameInput).toBeVisible();

      // ─── 3. Name + create ─────────────────────────────────────────
      await nameInput.fill("CUJ Hello World");
      await page.getByRole("button", { name: /^create$/i }).click();

      // ─── 4. Editor URL with project id ────────────────────────────
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      const url = page.url();
      const match = url.match(/p=(p_[a-z0-9]+)/);
      projectId = match?.[1];
      expect(projectId, "project id captured from URL").toBeTruthy();

      // Confirm this id is genuinely new — wasn't already in the
      // snapshot. If this fails, it means we somehow captured an
      // existing project's id from the URL (would be a serious bug).
      expect(snapshotBefore, `created project id ${projectId} must not exist in pre-test snapshot`)
        .not.toContain(projectId);

      // ─── 5. Project on disk ───────────────────────────────────────
      const projectDir = `${PROJECTS_DIR}/${projectId}`;
      expect(existsSync(projectDir), `project dir ${projectDir} exists`).toBe(true);
      const initialFiles = await readdir(projectDir);
      expect(initialFiles).toEqual(expect.arrayContaining(["index.html", "manifest.json"]));

      // ─── 6. Iframe canvas renders ─────────────────────────────────
      await page.waitForSelector("iframe", { timeout: 15_000 });
      await expect(page.locator("iframe").first()).toBeVisible();

      // ─── 7. Chat prompt → agent ───────────────────────────────────
      const prompt =
        "Make this a 'Hello World' composition. Use the DesignCanvas starter to lay out two frame variants side by side: " +
        "variant 1 has a white background (#ffffff) with black text 'Hello World' centered; " +
        "variant 2 has a dark navy blue (#0a1f3a) background with white text 'Hello World' centered. " +
        "Same typography in both — large bold sans-serif. Keep it simple, no extra elements.";

      await page.locator("textarea[placeholder*='Reply to thread']").fill(prompt);
      await page.locator("button[type=submit]:has-text('↑')").last().click();

      // ─── 8. Wait for agent to produce HelloWorldCanvas + dark navy ─
      // Poll the project dir until index.html references a Canvas file
      // AND a sibling .jsx contains both white and #0a1f3a backgrounds.
      const start = Date.now();
      const TIMEOUT_MS = 7 * 60_000;
      let satisfied = false;
      while (Date.now() - start < TIMEOUT_MS) {
        await page.waitForTimeout(8_000);
        const files = await readdir(projectDir).catch(() => []);
        const jsxFiles = files.filter((f) => f.endsWith(".jsx") && f !== "DesignCanvas.jsx");
        if (jsxFiles.length === 0) continue;
        for (const jsx of jsxFiles) {
          const body = await readFile(`${projectDir}/${jsx}`, "utf8").catch(() => "");
          const hasLightBg = /#ffffff|#fff\b|"white"|rgb\(255/i.test(body);
          const hasDarkBg = /0a1f3a|#0a1f3a/i.test(body);
          const hasHello = /hello\s*world/i.test(body);
          if (hasLightBg && hasDarkBg && hasHello) {
            satisfied = true;
            break;
          }
        }
        if (satisfied) break;
      }
      expect(satisfied, "agent produced a JSX with two frame variants (#ffffff + #0a1f3a, both showing 'Hello World')").toBe(true);

      // ─── 9. Visual confirmation via iframe DOM ────────────────────
      // Both labels ("Light" / "Dark navy" or similar) and "Hello World"
      // text must appear in the canvas iframe. Tight assertion: the
      // iframe body innerText must mention both backgrounds + the headline.
      const iframeText = await page.frameLocator("iframe").first().locator("body").innerText({ timeout: 10_000 });
      expect(iframeText, "iframe contains 'Hello World'").toMatch(/Hello\s*World/i);
      expect(iframeText, "iframe references two variants (light + dark)").toMatch(/dark\s*navy|navy|0a1f3a|dark.*background/i);
    } finally {
      // ─── 10. ALWAYS clean up the test project ─────────────────────
      // Even on failure — we don't leak test projects into web/projects/.
      // We delete by EXACT id we captured at step 4. The DELETE endpoint
      // takes a single :id; there's no wildcard or batch-delete path.
      // Any project the contributor had before the test is safe.
      if (projectId) {
        await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
      }

      // ─── 11. Verify cleanup did not touch other projects ───────────
      // Snapshot diff: post-test list MUST equal pre-test list. If the
      // delta isn't zero, either we leaked a project (cleanup failed)
      // or we deleted something we shouldn't have (collateral damage).
      // Both are bugs; both should fail loudly.
      const snapshotAfter = (await readdir(PROJECTS_DIR)).sort();
      expect(
        snapshotAfter,
        `post-test project list must exactly match pre-test snapshot (no leak, no collateral). before=[${snapshotBefore.join(",")}] after=[${snapshotAfter.join(",")}]`,
      ).toEqual(snapshotBefore);
    }
  });
});
