// chat-reconnect-stop — proves two things the user reported broken:
//   (1) Reloading WHILE a turn is still streaming reconnects to the
//       live backend run (shows "Reconnected — still working" and keeps
//       going) instead of stranding it with "Reply lost on reload".
//   (2) The Stop button aborts an in-flight turn (UI un-pends fast AND
//       the server run disappears from /api/_debug/runs).
//
// Uses a deliberately LONG prompt so the turn stays in-flight long
// enough to reload / stop mid-stream. Runs on a throwaway project that
// is deleted in finally. Sonnet (cheap) via localStorage.

import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:5174";
// A prompt that keeps the model streaming for a good while so we can
// reload / stop while it's genuinely still pending. No tools → no file
// writes → safe on any project.
const LONG_PROMPT =
  "Write a thorough, detailed essay of at least 500 words about the " +
  "history and craft of typography — typefaces, the printing press, " +
  "digital fonts, kerning, hinting. Take your time, be comprehensive, " +
  "write it out fully. Do not use any tools.";

async function createProject(page: import("@playwright/test").Page): Promise<string> {
  await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
  await page.getByTestId("create-project-name").fill(`Verify · Reconnect ${Date.now().toString(36)}`);
  await page.getByTestId("create-project-submit").click();
  await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
  const m = page.url().match(/p=(p_[a-z0-9]+)/);
  const projectId = m?.[1];
  expect(projectId, "project id captured from URL").toBeTruthy();
  await page.waitForSelector("iframe", { timeout: 15_000 });
  await page.waitForTimeout(600);
  return projectId!;
}

async function runCount(request: import("@playwright/test").APIRequestContext): Promise<number> {
  const r = await request.get(`${API_BASE}/api/_debug/runs`).catch(() => null);
  if (!r || !r.ok()) return -1;
  const j = await r.json().catch(() => ({ count: -1 }));
  return typeof j.count === "number" ? j.count : -1;
}

// Runs scoped to one project. Each entry carries `aborted` (=
// run.abort.signal.aborted). NOTE: an aborted/finished run lingers in
// activeRuns for the 60s GC window, so we assert on the `aborted` flag,
// not on the entry disappearing.
async function runsForProject(
  request: import("@playwright/test").APIRequestContext,
  projectId: string,
): Promise<Array<{ aborted: boolean }>> {
  const r = await request.get(`${API_BASE}/api/_debug/runs`).catch(() => null);
  if (!r || !r.ok()) return [];
  const j = await r.json().catch(() => ({ runs: [] }));
  return (j.runs ?? []).filter((x: { projectId?: string }) => x.projectId === projectId);
}

test.describe("chat reconnect + stop", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });
  });

  test("reload mid-stream reconnects to the live run (not 'lost')", async ({ page, request }) => {
    test.setTimeout(200_000);
    let projectId: string | undefined;
    try {
      projectId = await createProject(page);

      await page.getByTestId("chat-composer").fill(LONG_PROMPT);
      await page.getByTestId("chat-send").click();

      // Pending signal: the composer swaps Send (↑) for Stop (■).
      const stopBtn = page.getByRole("button", { name: "Stop" });
      await stopBtn.waitFor({ timeout: 20_000 });

      // Let persistence land (streamId is saved to threads.json with a
      // ~300ms debounce + server PATCH) and ensure the turn is genuinely
      // mid-stream, then capture the in-flight state.
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: "test-results/reconnect-before-reload.png" });
      // Sanity: a run is actually live on the backend right now.
      expect(await runCount(request), "a backend run is in flight before reload").toBeGreaterThanOrEqual(1);

      // THE BUG TRIGGER: hard reload while the turn is still streaming.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("iframe", { timeout: 15_000 });

      // Poll up to 150s. HARD FAIL the instant "Reply lost on reload"
      // appears (the bug). PASS when the reconnected turn streams to
      // completion — pending cleared (Stop gone) AND the reply actually
      // contains the essay topic (proves the rest of the run was
      // delivered after reconnect, not stranded). The transient
      // "Reconnected — still working" hint is a bonus signal (already
      // captured visually) but not required, since a fast turn can
      // finish before the poll observes the pending window.
      const lostRe = /Reply lost on reload/i;
      let sawReconnectedHint = false;
      let completed = false;
      let firstReloadShot = false;
      const start = Date.now();
      while (Date.now() - start < 150_000) {
        const body = (await page.locator("body").textContent().catch(() => "")) ?? "";
        expect(body, "turn must never be stranded as 'Reply lost on reload'").not.toMatch(lostRe);
        if (/Reconnected — still working/i.test(body)) sawReconnectedHint = true;
        if (!firstReloadShot) {
          await page.screenshot({ path: "test-results/reconnect-after-reload.png", fullPage: true });
          firstReloadShot = true;
        }
        const stopVisible = await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false);
        const bubble = page.locator('[class*="bubbleAssistant"]').last();
        const txt = (await bubble.textContent().catch(() => "")) ?? "";
        if (!stopVisible && /typograph/i.test(txt)) { completed = true; break; }
        await page.waitForTimeout(2_000);
      }
      await page.screenshot({ path: "test-results/reconnect-final.png", fullPage: true });

      // eslint-disable-next-line no-console
      console.log(`[reconnect] sawReconnectedHint=${sawReconnectedHint} completed=${completed}`);
      expect(completed, "reconnected turn streamed to completion with real content").toBe(true);
    } finally {
      if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
    }
  });

  test("Stop aborts the in-flight turn (UI un-pends + server run gone)", async ({ page, request }) => {
    test.setTimeout(120_000);
    let projectId: string | undefined;
    try {
      projectId = await createProject(page);

      await page.getByTestId("chat-composer").fill(LONG_PROMPT);
      await page.getByTestId("chat-send").click();

      const stopBtn = page.getByRole("button", { name: "Stop" });
      await stopBtn.waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1_500);
      // A live (not-yet-aborted) backend run exists for this project.
      const liveBefore = (await runsForProject(request, projectId)).some((r) => r.aborted === false);
      expect(liveBefore, "a live backend run exists before Stop").toBe(true);
      await page.screenshot({ path: "test-results/stop-before.png" });

      await stopBtn.click();

      // UI must un-pend quickly: the Send button returns (Stop gone).
      await expect(page.getByTestId("chat-send")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 10_000 });
      // Capture the un-pended state right now (before any further polling).
      await page.screenshot({ path: "test-results/stop-unpended.png" });
      // The latest assistant bubble should no longer show the live
      // "Thinking…" pending indicator.
      const stopped = page.locator('[class*="bubbleAssistant"]').last();
      await expect(stopped).not.toContainText("Thinking", { timeout: 5_000 });

      // Server abort must fire promptly (bypassGrace, not the 120s grace
      // fallback): this project's run flips to aborted (or is already
      // GC'd away). Poll a few seconds.
      let serverAborted = false;
      const start = Date.now();
      while (Date.now() - start < 12_000) {
        const runs = await runsForProject(request, projectId);
        if (runs.length === 0 || runs.every((r) => r.aborted === true)) { serverAborted = true; break; }
        await page.waitForTimeout(1_000);
      }
      await page.screenshot({ path: "test-results/stop-after.png" });
      expect(serverAborted, "server run aborted promptly after Stop (abort flag set)").toBe(true);
    } finally {
      if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
    }
  });
});
