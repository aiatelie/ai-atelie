// create-project journey
//
// Proves: name + Create lands the user in /editor with a fresh
// p_* project id, the project dir exists on disk, and the iframe
// canvas paints. No agent involvement — this is the structural
// "did the create flow work" check, separate from the much slower
// "did the agent edit the canvas" journey.
//
// The created project is deleted in the spec's `finally` block via
// the API so this journey doesn't leak. The cleanup-snapshot journey
// runs after this one and asserts the global guarantee.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const PROJECTS_DIR = "/Users/kadu/developer/aiatilie/ai-atelie/web/projects";
const API_BASE = "http://localhost:5174";
const FINAL_SCREENSHOT = "test-results/journeys-create-project-final.png";

test.describe("Journey: create project", () => {
  test.setTimeout(90_000);

  test("name + Create lands in editor with a fresh project on disk", async ({ page, request }) => {
    let projectId: string | undefined;
    const before = (await readdir(PROJECTS_DIR)).sort();
    try {
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });

      // Fill the sidebar form. data-testid hooks survive copy changes.
      const nameInput = page.getByTestId("create-project-name");
      const submit = page.getByTestId("create-project-submit");
      await expect(nameInput).toBeVisible();
      await nameInput.fill("Journey · Create Project");
      await expect(submit).toBeEnabled();
      await submit.click();

      // Editor URL with a fresh project id.
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      const m = page.url().match(/p=(p_[a-z0-9]+)/);
      projectId = m?.[1];
      expect(projectId, "project id captured from URL").toBeTruthy();
      expect(before, `created id ${projectId} must be brand new`).not.toContain(projectId);

      // Project dir exists on disk with a starter html.
      const projectDir = `${PROJECTS_DIR}/${projectId}`;
      expect(existsSync(projectDir), `project dir ${projectDir} exists`).toBe(true);
      const initialFiles = await readdir(projectDir);
      expect(initialFiles).toEqual(expect.arrayContaining(["index.html", "manifest.json"]));

      // Iframe canvas renders. We're not waiting on AI here — just on
      // the structural mount.
      await page.waitForSelector("iframe", { timeout: 15_000 });
      await expect(page.locator("iframe").first()).toBeVisible();

      await page.screenshot({ path: FINAL_SCREENSHOT, fullPage: false });
    } finally {
      if (projectId) {
        await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
      }
    }
  });
});
