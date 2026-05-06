// Evidence spec for the "Jump to latest" floating button in ChatBody.
//
// Drives the worktree dev server (Vite on $ATELIE_BASE_URL, default :5175)
// so the screenshots reflect this branch's code, not main's. Seeds the
// demo project's threads/meta blob with a long synthetic conversation,
// opens the editor, and asserts the button appears when scrolled up,
// snaps to bottom on click, and stays hidden when at the bottom.
//
// Run:
//   ATELIE_BASE_URL=http://localhost:5175 \
//   ATELIE_API_URL=http://localhost:5176 \
//   bunx playwright test web/tests/e2e/chat-jump-to-latest.spec.ts

import { test, expect, request as apiRequest } from "@playwright/test";

const BASE_URL = process.env.ATELIE_BASE_URL || "http://localhost:5175";
const API_URL = process.env.ATELIE_API_URL || "http://localhost:5176";
const PROJECT_ID = "demo";

function makeLongThread() {
  // 30-turn synthetic conversation guarantees the chat body overflows
  // the viewport in any reasonable sidebar width. Every turn carries a
  // multi-paragraph assistant content blob so vertical extent is real.
  const messages: unknown[] = [];
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    messages.push({
      role: "user",
      content: `Turn ${i + 1}: Make iteration #${i + 1} of the LinkedIn banner — try a slightly different layout and headline phrasing each time so I can compare them later.`,
      ts: now + i * 2000,
    });
    messages.push({
      role: "assistant",
      content: [
        `Sure — here's iteration ${i + 1}.`,
        "I tried a tighter headline and moved the avatar up a touch so the negative space on the right reads as intentional, not empty.",
        "Let me know which of these directions you want to lean into and I'll push it further.",
      ].join("\n\n"),
      tools: [],
      ts: now + i * 2000 + 1000,
    });
  }
  return {
    threads: [
      {
        id: "t_evidence",
        title: "Long thread for jump-to-latest evidence",
        messages,
        createdAt: now,
      },
    ],
    activeId: "t_evidence",
  };
}

test.describe("Chat jump-to-latest pill", () => {
  let priorThreadsBody: unknown = null;

  test.beforeAll(async () => {
    const ctx = await apiRequest.newContext();
    // Snapshot the existing threads blob (if any) so we can restore it
    // after the run — the demo project should be byte-identical post-test.
    const before = await ctx.get(
      `${API_URL}/api/projects/${PROJECT_ID}/meta/threads`,
    );
    if (before.ok()) {
      try { priorThreadsBody = await before.json(); } catch { priorThreadsBody = null; }
    }

    // Seed the demo project's threads blob with a long thread so the
    // chat body overflows. Direct PATCH; no etag needed for the first
    // write or when overwriting fully.
    const r = await ctx.patch(
      `${API_URL}/api/projects/${PROJECT_ID}/meta/threads`,
      { data: makeLongThread() },
    );
    expect(r.ok()).toBeTruthy();
    await ctx.dispose();
  });

  test.afterAll(async () => {
    // Restore the demo project's prior threads blob (or clear it back to
    // the empty archive shape) so this spec leaves no residue.
    const ctx = await apiRequest.newContext();
    const restored = priorThreadsBody ?? { threads: [], activeId: null };
    await ctx.patch(
      `${API_URL}/api/projects/${PROJECT_ID}/meta/threads`,
      { data: restored },
    );
    await ctx.dispose();
  });

  test("shows when scrolled up, hides when near bottom, snaps on click", async ({ page }) => {
    // Land on the home route first so the projects fetcher populates the
    // localStorage cache from the API. Without this step, /editor would
    // bounce back to /projects (no `activeProject` yet).
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (pid) => {
        try {
          const raw = localStorage.getItem("projects.v1");
          if (!raw) return false;
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed?.projects)
            && parsed.projects.some((p: { id: string }) => p.id === pid);
        } catch { return false; }
      },
      PROJECT_ID,
      { timeout: 10_000 },
    );
    // Pin demo as active in sessionStorage (per-tab) so Editor mounts
    // straight onto it without needing a click.
    await page.evaluate((pid) => {
      sessionStorage.setItem("projects.activeId", pid);
    }, PROJECT_ID);

    await page.goto(`${BASE_URL}/editor?p=${PROJECT_ID}`, {
      waitUntil: "domcontentloaded",
    });

    // Open the Chat tab in the left panel — Files is selected by
    // default. The badge count being non-zero confirms our seeded
    // thread loaded.
    await page.getByRole("button", { name: /^Chat\b/ }).first().click();

    // Wait for the chat body to mount and contain visible bubbles.
    const body = page.locator("[class*='_body_']").first();
    await expect(body).toBeVisible({ timeout: 10_000 });
    // The latest bubble we seeded should appear in the autoscrolled view.
    await expect(page.getByText(/Turn 30:/)).toBeVisible({ timeout: 10_000 });

    // Initial state: at bottom (autoScroll on), so the pill is NOT
    // visible. Wait a beat for the post-mount auto-scroll to settle.
    await page.waitForTimeout(800);
    await expect(page.getByRole("button", { name: /jump to latest/i })).toHaveCount(0);

    // Scroll the chat body to the top, simulating the user navigating
    // back to read older turns.
    await body.evaluate((el) => { el.scrollTop = 0; });

    // The pill should appear within a tick of the scroll handler firing.
    const pill = page.getByRole("button", { name: /jump to latest/i });
    await expect(pill).toBeVisible({ timeout: 2_000 });

    // Capture evidence: scrolled up, pill present.
    await page.screenshot({ path: "test-results/jump-pill-visible.png", fullPage: false });

    // Click it. The body should smooth-scroll back to the bottom and
    // the pill should disappear.
    await pill.click();
    await page.waitForTimeout(800);
    await expect(pill).toBeHidden();

    // Bottom assertion: scrollTop is now within 40px of (scrollHeight - clientHeight).
    const distance = await body.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(distance).toBeLessThan(40);

    // Capture evidence: jumped, pill gone.
    await page.screenshot({ path: "test-results/jump-pill-after-click.png", fullPage: false });
  });
});
