// create-hello-world-banner journey
//
// Proves: a contributor can land on the home, type a project name, hit
// Create, and end up inside /editor with a fresh project that owns its
// own iframe canvas. The name they typed survives into the editor
// chrome so it's clear which project they're in.
//
// No agent involvement — this is the structural "create flow works"
// check, separate from the slower "agent edits canvas" journey.
//
// The created project is deleted in the spec's `finally` block via the
// API; the cleanup-snapshot journey enforces the no-leak guarantee
// globally.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Resolve relative to this spec so the journey works from worktrees too:
// <repo>/web/tests/e2e/journeys/<name>.spec.ts → ../../.. = <repo>/web
const PROJECTS_DIR = path.resolve(import.meta.dirname, "../../..", "projects");
const API_BASE = "http://localhost:5174";
const FINAL_SCREENSHOT = "test-results/journeys-create-hello-world-banner-final.png";
const PROJECT_NAME = "Journey · Hello World banner";

test.describe("Journey: create Hello World banner", () => {
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
      await nameInput.fill(PROJECT_NAME);
      await expect(submit).toBeEnabled();
      await submit.click();

      // Editor URL with a fresh project id.
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      const m = page.url().match(/p=(p_[a-z0-9]+)/);
      projectId = m?.[1];
      expect(projectId, "project id captured from URL").toBeTruthy();
      expect(before, `created id ${projectId} must be brand new`).not.toContain(projectId);

      // Project dir exists on disk with starter files.
      const projectDir = `${PROJECTS_DIR}/${projectId}`;
      expect(existsSync(projectDir), `project dir ${projectDir} exists`).toBe(true);
      const initialFiles = await readdir(projectDir);
      expect(initialFiles).toEqual(expect.arrayContaining(["index.html", "manifest.json"]));

      // Project name surfaces in the editor chrome — the name the user
      // typed should be readable somewhere on the page.
      await expect(page.locator(`text=${PROJECT_NAME}`).first(), "project name visible in editor chrome").toBeVisible({ timeout: 8_000 });

      // Iframe canvas renders.
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
