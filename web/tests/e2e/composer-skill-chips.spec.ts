// Persistent skill chips above the composer (`web/src/components/editor/SkillChips.tsx`).
//
// Five posture chips — Wireframe / High fidelity / Interactive /
// Bold direction / Make tweakable — toggle independently, persist per
// project via localStorage, and inject their prompt as a hidden
// preamble on every send. This spec exercises the UI contract only
// (render, toggle, tooltip, persistence). The preamble-on-send path
// is covered by the `data/skills.test.ts` unit tests.
//
// Driven against the bundled demo project so the file list is stable.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.ATELIE_BASE_URL ?? "";

test.describe("composer skill chips", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // Force Sonnet so any accidental agent call is cheap, not Opus.
    // Wipe chip state — but only on the *first* page load of this
    // test, not on every navigation. addInitScript runs before every
    // load including reloads, so we gate the wipe on a sessionStorage
    // sentinel that survives reloads. Otherwise the reload-persistence
    // test would have its localStorage cleared mid-test by the very
    // wipe that's meant to keep tests independent.
    await page.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
      try {
        if (sessionStorage.getItem("__skill-chip-test-wiped__") === "1") return;
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith("composer-skills:")) localStorage.removeItem(k);
        }
        sessionStorage.setItem("__skill-chip-test-wiped__", "1");
      } catch { /* ignore */ }
    });
    await page.goto(BASE_URL ? `${BASE_URL}/` : "/", { waitUntil: "domcontentloaded" });
    const card = page.getByText("index.html").first();
    await card.waitFor({ timeout: 10_000 });
    await card.click();
    await page.waitForURL(/\/editor/, { timeout: 10_000 });
    await page.waitForSelector("iframe", { timeout: 10_000 });
    await page.waitForTimeout(500);
  });

  test("renders the five chips with stable order + accessible roles", async ({ page }) => {
    const row = page.getByRole("group", { name: "Composer skills" });
    await expect(row).toBeVisible({ timeout: 10_000 });

    const chips = row.getByRole("switch");
    await expect(chips).toHaveCount(5);

    // Order is part of the contract — `data/skills.ts` SKILLS array is
    // the source of truth and the unit test pins the id sequence.
    const labels = await chips.allInnerTexts();
    expect(labels.map((t) => t.trim())).toEqual([
      "Wireframe",
      "High fidelity",
      "Interactive",
      "Bold direction",
      "Make tweakable",
    ]);

    // Every chip starts unchecked (we wiped localStorage in beforeEach).
    for (let i = 0; i < 5; i++) {
      await expect(chips.nth(i)).toHaveAttribute("aria-checked", "false");
    }

    await page.screenshot({ path: "test-results/composer-skill-chips-idle.png", fullPage: false });
  });

  test("clicking toggles aria-checked and persists to localStorage", async ({ page }) => {
    const chips = page.getByRole("group", { name: "Composer skills" }).getByRole("switch");
    const wireframe = chips.nth(0);

    await expect(wireframe).toHaveAttribute("aria-checked", "false");
    await wireframe.click();
    await expect(wireframe).toHaveAttribute("aria-checked", "true");

    // Multi-select: a second chip activates without deactivating the first.
    const hifi = chips.nth(1);
    await hifi.click();
    await expect(wireframe).toHaveAttribute("aria-checked", "true");
    await expect(hifi).toHaveAttribute("aria-checked", "true");

    // localStorage carries both ids, keyed per-project.
    const ls = await page.evaluate(() => {
      const out: Record<string, string | null> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("composer-skills:")) out[k] = localStorage.getItem(k);
      }
      return out;
    });
    const entries = Object.entries(ls);
    expect(entries.length).toBe(1);
    const [, value] = entries[0];
    expect(JSON.parse(value!)).toEqual(["wireframe", "hifi"]);

    // Toggling off removes the key entirely (no dead "[]" rows).
    await wireframe.click();
    await hifi.click();
    const lsAfter = await page.evaluate(() => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("composer-skills:")) keys.push(k);
      }
      return keys;
    });
    expect(lsAfter).toEqual([]);

    await page.screenshot({ path: "test-results/composer-skill-chips-toggled.png", fullPage: false });
  });

  test("hover tooltip + sibling sr-only description preview the full prompt", async ({ page }) => {
    const chips = page.getByRole("group", { name: "Composer skills" }).getByRole("switch");
    const wireframe = chips.nth(0);

    // Native `title` attribute carries the full prompt for sighted
    // mouse users — same convention as the other context pills in
    // this composer (ChatSidebar.tsx uses title= throughout).
    const title = await wireframe.getAttribute("title");
    expect(title).toBeTruthy();
    expect(title!.length).toBeGreaterThan(80);
    expect(title!.toLowerCase()).toContain("wireframe");

    // The button is described by a sibling element (not a descendant)
    // so the accessible name stays = aria-label and the long prompt
    // isn't folded into the chip's announced name.
    const describedBy = await wireframe.getAttribute("aria-describedby");
    expect(describedBy).toBe("skill-desc-wireframe");
    const accessibleName = await wireframe.getAttribute("aria-label");
    expect(accessibleName).toBe("Wireframe");

    const descLocator = page.locator("#skill-desc-wireframe");
    await expect(descLocator).toHaveCount(1);
    const descText = await descLocator.textContent();
    expect(descText).toMatch(/Wireframe: .+wireframe/i);
  });

  test("active chips survive a full reload (per-project persistence)", async ({ page }) => {
    const chips = page.getByRole("group", { name: "Composer skills" }).getByRole("switch");
    await chips.nth(0).click(); // Wireframe
    await chips.nth(3).click(); // Bold direction

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("iframe", { timeout: 10_000 });

    const chipsAfter = page.getByRole("group", { name: "Composer skills" }).getByRole("switch");
    await expect(chipsAfter.nth(0)).toHaveAttribute("aria-checked", "true");
    await expect(chipsAfter.nth(1)).toHaveAttribute("aria-checked", "false");
    await expect(chipsAfter.nth(3)).toHaveAttribute("aria-checked", "true");

    await page.screenshot({ path: "test-results/composer-skill-chips-reloaded.png", fullPage: false });
  });

  test("the renamed 'Bold direction' chip is the posture-frontend-design id", async ({ page }) => {
    // Regression guard: the chip's visible label was deliberately
    // renamed from "Frontend design" to "Bold direction" so it doesn't
    // visually collide with the ActiveSkillsStrip entry of the same
    // name (project manifest skill). The underlying chip id stayed
    // `posture-frontend-design` to dodge the prompt-builder collision.
    const chip = page.locator('[data-skill-id="posture-frontend-design"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-label", "Bold direction");
  });
});
