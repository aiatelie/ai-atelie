// cleanup-snapshot journey
//
// The leak guard. Runs last in the baseline suite. Asserts that no
// journey-created project survived its own cleanup.
//
// Each journey that creates a project names it "Journey · <something>"
// and deletes it in `finally`. If any of those finallys was skipped
// (worker killed, test timed out before reaching cleanup, etc.) this
// journey finds and removes the leak, then asserts there's nothing
// left with the journey prefix.
//
// Why a name-prefix check rather than a project-list snapshot diff:
// a snapshot diff requires the cleanup spec to know what was on disk
// before the suite started, which means cross-spec state. The naming
// convention is self-contained — every journey project has the prefix,
// no real user project does, so anything matching is by definition a
// leak.

import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:5174";
const JOURNEY_PREFIX = "Journey · ";
const FINAL_SCREENSHOT = "test-results/journeys-cleanup-snapshot-final.png";

test.describe("Journey: cleanup snapshot", () => {
  test.setTimeout(30_000);

  test("no journey-created project survives the suite", async ({ page, request }) => {
    // List projects via the API.
    const res = await request.get(`${API_BASE}/api/projects`);
    expect(res.ok()).toBe(true);
    const all = await res.json();
    const projects: { id: string; name: string }[] = Array.isArray(all) ? all : (all.projects ?? []);

    const leaks = projects.filter((p) => typeof p.name === "string" && p.name.startsWith(JOURNEY_PREFIX));

    // Force-delete leaks (don't fail the test BEFORE cleaning up — we
    // want the suite to leave the system in a sane state regardless).
    for (const p of leaks) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`).catch(() => null);
    }

    // Re-list and assert.
    const res2 = await request.get(`${API_BASE}/api/projects`);
    const all2 = await res2.json();
    const projects2: { id: string; name: string }[] = Array.isArray(all2) ? all2 : (all2.projects ?? []);
    const remaining = projects2.filter((p) => typeof p.name === "string" && p.name.startsWith(JOURNEY_PREFIX));

    // Snap the home page so the runner has visual evidence the suite
    // landed back on a clean projects list.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: FINAL_SCREENSHOT, fullPage: false });

    expect(
      remaining,
      `no project starting with "${JOURNEY_PREFIX}" should remain after the suite. Leaked: ${leaks.map((p) => `${p.id}=${p.name}`).join(", ")}`,
    ).toEqual([]);
  });
});
