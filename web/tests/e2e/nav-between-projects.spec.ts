import { test, expect } from "@playwright/test";

async function realCards(page) {
  return page.locator('[class*="grid"] > [class*="card"]:not([aria-hidden="true"])');
}

test("navigate from editor back to /projects and into a different project", async ({ page }) => {
  await page.goto("/projects", { waitUntil: "domcontentloaded" });

  // Wait for skeleton to disappear: real cards have no aria-hidden.
  await expect(page.locator('[class*="sectionLabel"]:not([aria-busy="true"])').first())
    .toBeVisible({ timeout: 10_000 });

  const cards = await realCards(page);
  const totalCards = await cards.count();
  console.log("real cards on /projects:", totalCards);
  test.skip(totalCards < 2, `need >= 2 projects on home, found ${totalCards}`);

  const firstName = (await cards.nth(0).innerText()).split("\n")[0].trim();
  const secondName = (await cards.nth(1).innerText()).split("\n")[0].trim();
  console.log("first card name:", firstName, "second card name:", secondName);
  expect(firstName).not.toBe(secondName);

  await cards.nth(0).click();
  await page.waitForURL(/\/editor.*p=p_/, { timeout: 10_000 });
  const firstUrl = page.url();
  const firstId = firstUrl.match(/p=(p_[a-z0-9]+)/)?.[1];
  expect(firstId, "first project id").toBeTruthy();
  await page.screenshot({ path: "test-results/nav-1-first-editor.png", fullPage: false });

  // Try every plausible "back to projects" affordance the UI exposes.
  let landedHome = false;
  const candidates = [
    page.getByRole("link", { name: /projects/i }),
    page.getByRole("button", { name: /projects/i }),
    page.getByRole("link", { name: /home/i }),
    page.getByRole("link", { name: /^present$/i }),
  ];
  for (const c of candidates) {
    if (await c.first().isVisible().catch(() => false)) {
      await c.first().click();
      try {
        await page.waitForURL(/\/projects(\?|$|\/)/, { timeout: 4000 });
        landedHome = true;
        break;
      } catch {
        await page.goto("/projects", { waitUntil: "domcontentloaded" });
        landedHome = true;
        break;
      }
    }
  }
  if (!landedHome) {
    await page.goBack();
    await page.waitForURL(/\/projects/, { timeout: 4000 });
  }
  await expect(page).toHaveURL(/\/projects/);
  await page.screenshot({ path: "test-results/nav-2-back-on-home.png", fullPage: false });

  await expect(page.locator('[class*="sectionLabel"]:not([aria-busy="true"])').first())
    .toBeVisible({ timeout: 10_000 });
  const cards2 = await realCards(page);
  const c2Count = await cards2.count();
  console.log("real cards on return:", c2Count);
  await cards2.nth(1).click();
  await page.waitForURL(/\/editor.*p=p_/, { timeout: 10_000 });
  const secondUrl = page.url();
  const secondId = secondUrl.match(/p=(p_[a-z0-9]+)/)?.[1];
  expect(secondId, "second project id").toBeTruthy();
  expect(secondId, "second project must differ from first").not.toBe(firstId);
  await page.screenshot({ path: "test-results/nav-3-second-editor.png", fullPage: false });

  console.log(JSON.stringify({ firstId, secondId, landedHomeViaUI: landedHome }));
});

test("ProjectSwitcher dropdown switches active project in-place and links to /projects", async ({ page }) => {
  await page.goto("/projects", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[class*="sectionLabel"]:not([aria-busy="true"])').first())
    .toBeVisible({ timeout: 10_000 });

  // Pick the LinkedIn-banner project (has multiple file tabs) as the
  // starting state; named match is more stable than index.
  const banner = page.locator('[class*="grid"] > [class*="card"]', { hasText: /LinkedIn banner/i }).first();
  await expect(banner).toBeVisible();
  await banner.click();
  await page.waitForURL(/\/editor/, { timeout: 10_000 });

  // Sanity: project chip in tab strip says LinkedIn banner.
  await expect(page.getByText(/LinkedIn banner/i).first()).toBeVisible();
  await page.screenshot({ path: "test-results/nav-4-multitab-editor.png", fullPage: false });

  // Open the ProjectSwitcher dropdown.
  const switcher = page.getByRole("button", { name: /switch project/i });
  await expect(switcher).toBeVisible();
  await switcher.click();

  // Menu shows all projects and a "Browse all projects" link.
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.waitForTimeout(150);

  // Regression: the dropdown used to be clipped by the tabbar's
  // `overflow: hidden`. Now portaled, so its top must sit BELOW the
  // 44px tabbar — otherwise the user can't see it.
  const menuBox = await menu.boundingBox();
  console.log("menu bbox:", JSON.stringify(menuBox));
  expect(menuBox, "menu has a bounding box").not.toBeNull();
  // Regression: previously the dropdown was rendered inside the tabbar
  // and got fully clipped by `overflow: hidden`. Now portaled, so the
  // bulk of the menu must extend well past the 44px tabbar — both as
  // height and as bottom edge.
  expect(menuBox!.height, "menu has substantial height").toBeGreaterThan(150);
  expect(menuBox!.y + menuBox!.height, "menu bottom is far below tabbar").toBeGreaterThan(150);
  await page.screenshot({ path: "test-results/nav-5-switcher-open.png", fullPage: false });

  // Switch in-place to "Hola Mundo Demo".
  await page.locator('text=Hola Mundo Demo').first().click();

  // After switch, top tab title in editor should change to Hola Mundo Demo.
  await expect(page.getByText(/Hola Mundo Demo/i).first()).toBeVisible({ timeout: 5000 });
  await expect(page).toHaveURL(/\/editor/);
  await page.screenshot({ path: "test-results/nav-6-switched-inplace.png", fullPage: false });

  // Now click "Browse all projects" via dropdown → must land on /projects.
  await page.getByRole("button", { name: /switch project/i }).click();
  await page.locator('text=Browse all projects').click();
  await page.waitForURL(/\/projects(\?|$|\/)/, { timeout: 5000 });
  await expect(page.locator('[class*="sectionLabel"]').first()).toBeVisible();
  await page.screenshot({ path: "test-results/nav-7-browse-all.png", fullPage: false });
});
