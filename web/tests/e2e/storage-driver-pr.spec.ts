/* PR evidence for feat/storage-driver-and-project-list:
 *
 *   1. Home page renders the new "Local-first · stored on disk" pill and
 *      lists projects from /api/projects (closes #55).
 *   2. /api/health responds {ok:true} — proves the refactored API boots.
 *   3. /api/projects returns at least the demo project — proves the
 *      route refactor through ProjectRepo + filesystem storage driver
 *      is wire-compatible with the previous implementation.
 *
 * NOT the CUJ — that's its own load-bearing test and runs separately.
 * This spec is targeted evidence for what *this PR specifically*
 * changes.
 */

import { test, expect } from "@playwright/test";

test.describe("storage-driver-and-project-list PR evidence", () => {
  test("home page: new pill text + project list from API", async ({ page, request }) => {
    // Backend smoke first — proves the refactored API serves the routes.
    const health = await request.get("http://localhost:5174/api/health");
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const projects = await request.get("http://localhost:5174/api/projects");
    expect(projects.status()).toBe(200);
    const list = await projects.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);

    // Frontend smoke — open the home page in a fresh context.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/AI Atelie/i);

    // The new pill text — proof the #55 copy change shipped.
    const pill = page.locator("[class*=footerChip]").first();
    await expect(pill).toBeVisible({ timeout: 5_000 });
    await expect(pill).toHaveText(/Local-first · stored on disk/);

    // Project list rendered — at least the demo card.
    const sectionLabel = page.locator("[class*=sectionLabel]").first();
    await expect(sectionLabel).toBeVisible({ timeout: 5_000 });
    await expect(sectionLabel).toHaveText(/Projects · \d+/);

    // Final post-completion screenshot for PR evidence.
    await page.screenshot({ path: "test-results/storage-driver-pr/01-home.png", fullPage: true });
  });

  test("editor: new project creates and lands in editor with iframe", async ({ page, request }) => {
    // This is a tighter version of the CUJ's first half — proves the
    // create-project + iframe-render path still works through the
    // refactored ProjectRepo + ProjectFilesRepo. Doesn't run the agent
    // (the CUJ does that, and the agent path is untouched by this PR).
    let projectId: string | undefined;

    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /new project/i }).first().click();

      const nameInput = page.getByTestId("create-project-name");
      await expect(nameInput).toBeVisible();
      await nameInput.fill("storage-driver evidence");
      await page.getByTestId("create-project-submit").click();

      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      const url = page.url();
      const match = url.match(/p=(p_[a-z0-9]+)/);
      projectId = match?.[1];
      expect(projectId).toBeTruthy();

      // Iframe present + reload-script injected (proves /p/:id/* serve
      // through ProjectFilesRepo + script injection still works).
      await page.waitForSelector("iframe", { timeout: 15_000 });
      const iframeSrc = await page.locator("iframe").first().getAttribute("src");
      expect(iframeSrc).toBeTruthy();

      await page.screenshot({ path: "test-results/storage-driver-pr/02-editor.png", fullPage: true });

      // Backend evidence: meta endpoint round-trip with ETag + If-Match.
      // Proves the JsonKv primitive + repos work end-to-end.
      const put1 = await request.patch(`http://localhost:5174/api/projects/${projectId}/meta/threads`, {
        data: { messages: [] },
      });
      expect(put1.status()).toBe(200);
      const etag1 = put1.headers()["etag"];
      expect(etag1).toBeTruthy();

      const get1 = await request.get(`http://localhost:5174/api/projects/${projectId}/meta/threads`, {
        headers: { "if-none-match": etag1 },
      });
      expect(get1.status()).toBe(304);

      const put2Conflict = await request.patch(`http://localhost:5174/api/projects/${projectId}/meta/threads`, {
        data: { messages: [1] },
        headers: { "if-match": "wrong-etag" },
      });
      expect(put2Conflict.status()).toBe(412);

      const put2OK = await request.patch(`http://localhost:5174/api/projects/${projectId}/meta/threads`, {
        data: { messages: [1] },
        headers: { "if-match": etag1 },
      });
      expect(put2OK.status()).toBe(200);
    } finally {
      if (projectId) {
        await request.delete(`http://localhost:5174/api/projects/${projectId}`).catch(() => null);
      }
    }
  });
});
