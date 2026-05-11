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

  // Fidelity chips render as <button role="radio"> (mutually exclusive)
  // and modifier chips as <button role="switch"> (independent toggles).
  // A single data-attribute locator matches both, in catalog order,
  // and ignores the clear-all button at the row's tail.
  const allChips = (page: import("@playwright/test").Page) =>
    page.locator('[aria-label="Composer skills"] [data-skill-id]');

  test("renders the five chips with stable order + accessible roles", async ({ page }) => {
    const row = page.getByRole("group", { name: "Composer skills" });
    await expect(row).toBeVisible({ timeout: 10_000 });

    const chips = allChips(page);
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

    // Fidelity chips are radios; modifiers are switches. Order in the
    // catalog: 3 fidelity, then 2 modifiers.
    for (let i = 0; i < 3; i++) {
      await expect(chips.nth(i)).toHaveAttribute("role", "radio");
    }
    for (let i = 3; i < 5; i++) {
      await expect(chips.nth(i)).toHaveAttribute("role", "switch");
    }

    await page.screenshot({ path: "test-results/composer-skill-chips-idle.png", fullPage: false });
  });

  test("clicking toggles aria-checked and persists to localStorage", async ({ page }) => {
    const wireframe = page.locator('[data-skill-id="wireframe"]');
    const tweakable = page.locator('[data-skill-id="tweakable"]');

    await expect(wireframe).toHaveAttribute("aria-checked", "false");
    await wireframe.click();
    await expect(wireframe).toHaveAttribute("aria-checked", "true");

    // Multi-select across groups: activating a modifier doesn't disturb
    // the fidelity choice. (Within-group exclusivity is covered by the
    // dedicated fidelity-radio test below.)
    await tweakable.click();
    await expect(wireframe).toHaveAttribute("aria-checked", "true");
    await expect(tweakable).toHaveAttribute("aria-checked", "true");

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
    expect(JSON.parse(value!)).toEqual(["wireframe", "tweakable"]);

    // Toggling each off removes the key entirely (no dead "[]" rows).
    await wireframe.click();
    await tweakable.click();
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
    const wireframe = page.locator('[data-skill-id="wireframe"]');

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
    await page.locator('[data-skill-id="wireframe"]').click();
    await page.locator('[data-skill-id="posture-frontend-design"]').click();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("iframe", { timeout: 10_000 });

    await expect(page.locator('[data-skill-id="wireframe"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-skill-id="hifi"]')).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('[data-skill-id="posture-frontend-design"]')).toHaveAttribute("aria-checked", "true");

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

  test("fidelity chips are mutually exclusive; modifiers stay independent", async ({ page }) => {
    // Wireframe / High fidelity / Interactive share the "fidelity"
    // group so activating one deactivates the others. Bold direction
    // and Make tweakable are independent modifiers that compose with
    // any fidelity choice and with each other.
    const wireframe = page.locator('[data-skill-id="wireframe"]');
    const hifi = page.locator('[data-skill-id="hifi"]');
    const interactive = page.locator('[data-skill-id="interactive"]');
    const tweakable = page.locator('[data-skill-id="tweakable"]');

    // Fidelity chips render as radios so screen readers announce the
    // exclusivity, unlike the modifier chips which stay switches.
    await expect(wireframe).toHaveAttribute("role", "radio");
    await expect(tweakable).toHaveAttribute("role", "switch");

    await wireframe.click();
    await expect(wireframe).toHaveAttribute("aria-checked", "true");

    // Activating hifi must replace wireframe, not add to it.
    await hifi.click();
    await expect(wireframe).toHaveAttribute("aria-checked", "false");
    await expect(hifi).toHaveAttribute("aria-checked", "true");

    // Same for the third fidelity chip.
    await interactive.click();
    await expect(hifi).toHaveAttribute("aria-checked", "false");
    await expect(interactive).toHaveAttribute("aria-checked", "true");

    // A modifier toggled on top of a fidelity choice doesn't disturb
    // the fidelity selection.
    await tweakable.click();
    await expect(interactive).toHaveAttribute("aria-checked", "true");
    await expect(tweakable).toHaveAttribute("aria-checked", "true");

    // localStorage carries exactly the surviving set, in
    // first-activated-first order.
    const stored = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("composer-skills:")) return JSON.parse(localStorage.getItem(k)!);
      }
      return null;
    });
    expect(stored).toEqual(["interactive", "tweakable"]);
  });

  test("clear-all button appears when chips are active and resets them", async ({ page }) => {
    const chips = page.getByRole("group", { name: "Composer skills" });
    const clearAll = chips.getByRole("button", { name: "Clear all skill chips" });

    // Hidden at rest — the row stays minimal when there's nothing to clear.
    await expect(clearAll).toHaveCount(0);

    await page.locator('[data-skill-id="wireframe"]').click();
    await page.locator('[data-skill-id="tweakable"]').click();
    await expect(clearAll).toBeVisible();

    await clearAll.click();
    // Every chip back to unchecked + storage row removed.
    const switches = chips.locator('[role="switch"], [role="radio"]');
    const n = await switches.count();
    for (let i = 0; i < n; i++) {
      await expect(switches.nth(i)).toHaveAttribute("aria-checked", "false");
    }
    const lsKeys = await page.evaluate(() => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("composer-skills:")) keys.push(k);
      }
      return keys;
    });
    expect(lsKeys).toEqual([]);
    await expect(clearAll).toHaveCount(0);
  });

  test("ActiveSkillsStrip renders at the TOP of the chat, not in the composer", async ({ page }) => {
    // The strip is project-scope info. It belongs with the thread tabs
    // and above the message list, not stacked between the chip row and
    // the textarea — that was crowding the composer with three rows of
    // metadata.
    //
    // The strip self-hides when:
    //   (a) the project manifest has no aesthetic skills active, OR
    //   (b) /api/skills/catalog isn't reachable.
    // Both are valid states; this test exists to assert structural
    // position WHEN it does render. We stub both endpoints so the
    // strip materializes deterministically — otherwise headless CI
    // without the api running gets a hidden strip and a false skip.
    await page.route("**/api/skills/catalog", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          skills: [
            { name: "frontend-design", display: "Frontend design", description: "", kind: "aesthetic" },
          ],
        }),
      });
    });
    await page.route("**/api/projects/*/manifest", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ design: { active_skills: ["frontend-design"] } }),
      });
    });
    // Reload so the strip's mount-time fetches go through our stubs.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("iframe", { timeout: 10_000 });

    const strip = page.locator('button[title="Edit aesthetic skills (Settings → Skills)"]');
    const chipsRow = page.locator('[aria-label="Composer skills"]');
    await expect(strip).toBeVisible({ timeout: 5_000 });
    const stripBox = await strip.boundingBox();
    const chipsBox = await chipsRow.boundingBox();
    expect(stripBox).toBeTruthy();
    expect(chipsBox).toBeTruthy();
    // The structural contract: strip is ABOVE the chip row (since it
    // was moved out of the composer to the top of the chat panel).
    expect(stripBox!.y).toBeLessThan(chipsBox!.y);
  });

  test("sent message bubble records which chips were active", async ({ page }) => {
    // Toggle a couple of chips on, then exercise the send path. We
    // don't actually need the API to respond — the userMsg bubble
    // is created synchronously by the editor, so the chip pill strip
    // under the typed text is observable before the (broken) stream
    // would have completed.
    await page.locator('[data-skill-id="wireframe"]').click();
    await page.locator('[data-skill-id="tweakable"]').click();

    const composer = page.getByTestId("chat-composer");
    await composer.waitFor({ timeout: 10_000 });
    await composer.click();
    await composer.fill("verify-bubble-chips marker");

    // Submit via Cmd/Ctrl+Enter (Enter alone also submits per the
    // composer contract). We use a key event for portability.
    await composer.press("Enter");

    // The new user bubble shows up immediately. Find the bubble that
    // contains our marker text and assert it carries the chip strip.
    const bubble = page.locator('div', { hasText: "verify-bubble-chips marker" }).first();
    await bubble.waitFor({ state: "visible", timeout: 10_000 });

    // The chip strip is a sibling of the typed text within the user
    // bubble. Two pills: Wireframe + Make tweakable, in toggle order.
    // The dot has --chip-accent inline; the label uses the catalog
    // text. Match by text presence inside the same bubble container.
    const userBubble = page.locator('[class*="bubbleUser"]').filter({ hasText: "verify-bubble-chips marker" }).first();
    await expect(userBubble).toContainText("Wireframe");
    await expect(userBubble).toContainText("Make tweakable");
  });

  test("cross-tab change via storage event updates the chip set", async ({ page }) => {
    // The Composer listens for the `storage` event so a chip toggled
    // in another tab of the same project ripples into this tab
    // without a reload. We simulate the event locally — playwright
    // can't easily open a second tab on the same browser context, and
    // the contract under test is "external mutation of our key
    // triggers a state refresh."
    const wireframe = page.locator('[data-skill-id="wireframe"]');
    const tweakable = page.locator('[data-skill-id="tweakable"]');

    // Click any chip first so the Composer writes its key — gives us
    // the exact storage key without having to thread the projectId
    // out of the React tree.
    await tweakable.click();
    const ourKey = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("composer-skills:")) return k;
      }
      return null;
    });
    expect(ourKey).toBeTruthy();

    // Dispatch a synthetic storage event with a new value containing
    // wireframe (and dropping tweakable) — the listener should pick
    // up the change and update the chip strip.
    await expect(wireframe).toHaveAttribute("aria-checked", "false");
    await page.evaluate((key) => {
      const newValue = JSON.stringify(["wireframe"]);
      localStorage.setItem(key, newValue);
      window.dispatchEvent(new StorageEvent("storage", {
        key,
        newValue,
        oldValue: null,
        storageArea: localStorage,
      }));
    }, ourKey!);

    await expect(wireframe).toHaveAttribute("aria-checked", "true", { timeout: 2000 });
    await expect(tweakable).toHaveAttribute("aria-checked", "false");
  });
});
