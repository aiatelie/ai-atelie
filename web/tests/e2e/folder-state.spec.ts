/* Evidence spec for #40 Phase 1 — folder-collapse state persists per
 * project across reloads.
 *
 * Strategy:
 *   1. Create a fresh project via the home-page UI flow (matches CUJ).
 *   2. Drop a file under uploads/ via the API so a "Folders" section
 *      with an "uploads" row exists in the FileBrowserView.
 *   3. Open Design Files → click the uploads chevron → assert open.
 *   4. Reload → assert the chevron is still ▾ (open).
 *   5. Click again to close → reload → assert ▸ (closed).
 *   6. Cleanup: DELETE the project.
 *
 * The product change is a tiny localStorage shim, so this spec is
 * deliberately small. Folder-state behavior is fully covered by
 * `folderState.test.ts`; this spec proves the React wiring.
 */

import { test, expect, type Page } from "@playwright/test";

test.setTimeout(120_000);

// The folder row markup is
// `<div><span>▸/▾</span><Icon/><span>uploads</span><span>1</span></div>`
// — locate it by the inner spans rather than a regex over concatenated
// text, which is fragile when the FolderIcon's <svg> introduces empty
// text nodes between siblings.
function uploadsRow(page: Page) {
  return page
    .locator("div")
    .filter({ has: page.locator("span", { hasText: /^uploads$/ }) })
    .filter({ has: page.locator("span", { hasText: /^[▸▾]$/ }) })
    .last();
}

test("folder-collapse state survives a reload", async ({ page, request }) => {
  // ─── 1. Create the project via the same UI flow the CUJ uses ───────
  // Going through the New Project modal is the only path that reliably
  // hydrates both layers (server manifest + browser cache + active id),
  // so we mirror it here. Trying to seed via API + addInitScript races
  // the editor's first-render bounce-to-/projects.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /new project/i }).first().click();
  const nameInput = page.getByTestId("create-project-name");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("Folder state evidence");
  await page.getByTestId("create-project-submit").click();
  await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
  const url = page.url();
  const match = url.match(/p=(p_[a-z0-9]+)/);
  const projectId = match?.[1];
  expect(projectId, "project id captured from URL").toBeTruthy();

  try {
    // ─── 2. Stage a file under uploads/ so the folder section appears ─
    // The /file/upload route accepts dataURL; a 1x1 PNG is enough.
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    const upRes = await request.post(
      `/api/projects/${encodeURIComponent(projectId!)}/file/upload`,
      { data: { path: "uploads/pixel.png", dataUrl } },
    );
    expect(upRes.ok(), "upload pixel.png").toBe(true);

    // ─── 3. Open Design Files (the panel that hosts the folder list) ─
    await page.getByText("Design Files", { exact: true }).click();

    const closedRow = uploadsRow(page);
    await expect(closedRow).toBeVisible();
    await expect(closedRow).toContainText("▸"); // closed by default

    // Click to expand. The same row now contains ▾.
    await closedRow.click();
    await expect(uploadsRow(page)).toContainText("▾");

    // ─── 4. Reload — folder must remain open ───────────────────────────
    await page.reload();
    await page.getByText("Design Files", { exact: true }).click();
    await expect(uploadsRow(page)).toContainText("▾");

    // Capture evidence of the persisted-open state.
    await page.screenshot({
      path: "test-results/folder-state-chromium/after-reload-open.png",
      fullPage: true,
    });

    // ─── 5. Click to close → reload → still closed ─────────────────────
    await uploadsRow(page).click();
    await expect(uploadsRow(page)).toContainText("▸");
    await page.reload();
    await page.getByText("Design Files", { exact: true }).click();
    await expect(uploadsRow(page)).toContainText("▸");

    await page.screenshot({
      path: "test-results/folder-state-chromium/after-reload-closed.png",
      fullPage: true,
    });
  } finally {
    // ─── 6. Cleanup ────────────────────────────────────────────────────
    if (projectId) {
      await request.delete(`/api/projects/${encodeURIComponent(projectId)}`);
    }
  }
});
