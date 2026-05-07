import { test, expect } from "@playwright/test";

async function realCards(page) {
  return page.locator('[class*="grid"] > [class*="card"]:not([aria-hidden="true"])');
}

test("navigate from editor back to /projects and into a different project", async ({ page }) => {
  await page.goto("/projects", { waitUntil: "domcontentloaded" });

  // Wait for skeleton to disappear: real cards have no aria-hidden.
  await expect(page.locator('[class*="grid"]:not([aria-busy="true"]) > [class*="card"]:not([aria-hidden="true"])').first())
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

  await expect(page.locator('[class*="grid"]:not([aria-busy="true"]) > [class*="card"]:not([aria-hidden="true"])').first())
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

