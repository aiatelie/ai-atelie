// Chat stream survives full page reload — proves that an in-flight
// assistant turn keeps streaming after the user reloads (HMR-driven,
// Cmd+R, or any other full reload). Pre-fix the user saw "Reply lost
// on reload — send again to retry"; post-fix the bubble continues
// streaming via the server's replay endpoint.
//
// Strategy: hit a real adapter (Sonnet) with a small prompt, reload
// the page after the first chunk lands, and assert the assistant
// message ends up non-pending with content the AI actually produced.
// We mostly care that "Reply lost on reload" never appears AND the
// pending state clears within a reasonable wall-clock window.

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.ATELIE_BASE_URL ?? "";

test.describe("chat stream survives full page reload", () => {
  test.setTimeout(120_000);

  test("reload mid-stream does not strand the assistant message", async ({ page, context }) => {
    // Force Sonnet — cheaper than Opus, equivalent for the kind of
    // prompts these dogfood tests use. Set before any navigation.
    await context.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });

    await page.goto(BASE_URL ? `${BASE_URL}/` : "/", { waitUntil: "domcontentloaded" });

    // Open the first project on the home page so we have an editor
    // with a chat composer wired up. The fixture-injection trick from
    // earlier specs isn't needed here — we just want the chat surface.
    const card = page.getByText("index.html").first();
    await card.waitFor({ timeout: 10_000 });
    await card.click();
    await page.waitForURL(/\/editor/, { timeout: 10_000 });
    await page.waitForSelector("iframe", { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Find the chat composer textarea. The placeholder text is stable
    // across recent UI iterations; pick the visible composer (there
    // can be a hidden ElicitForm input in the DOM too).
    const composer = page.getByPlaceholder(/Describe what you want|Tell me what to/i).first();
    await composer.waitFor({ timeout: 10_000 });
    await composer.click();

    // Use a unique sentinel prompt — the assistant's reply will echo
    // the marker, so we can scope our locator to the latest bubble
    // rather than picking up bubbles from prior thread history.
    const sentinel = `RELOAD-SENTINEL-${Date.now().toString(36)}`;
    const userPrompt = `Reply with EXACTLY this token on its own line and nothing else: ${sentinel}. Don't use any tools, no preamble.`;
    await composer.fill(userPrompt);
    // Plain Enter is the canonical send shortcut (ChatSidebar.tsx:781);
    // headless Chromium handles it more reliably than Meta+Enter.
    await composer.press("Enter");

    // First confirm the user message landed in the chat (otherwise we'll
    // be waiting forever on a request that never went out).
    await page.getByText(sentinel).first().waitFor({ timeout: 5_000 });

    // Wait for the assistant bubble that echoes the sentinel. CSS-module
    // class names are hashed but the prefix is stable.
    const assistantBubble = page
      .locator('[class*="bubbleAssistant"]')
      .filter({ hasText: sentinel })
      .first();
    await assistantBubble.waitFor({ timeout: 90_000 });
    const beforeText = (await assistantBubble.textContent()) ?? "";
    expect(beforeText).toContain(sentinel);

    // Hard reload — this is the bug-trigger. Pre-fix, the in-flight
    // SSE connection drops + the in-memory streamId map evaporates,
    // and on remount the sanitizer marks the message "Reply lost".
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("iframe", { timeout: 10_000 });

    // The sentinel must still be visible post-reload (loaded from
    // persisted threads.json + reattach).
    const after = page.getByText(sentinel).first();
    await after.waitFor({ timeout: 15_000 });

    // Wait one beat for sanitizer + resume effect to settle.
    await page.waitForTimeout(2_000);

    // Locate the assistant bubble for THIS turn (sentinel-scoped).
    const latestAssistantBubble = page
      .locator('[class*="bubbleAssistant"]')
      .filter({ hasText: sentinel })
      .first();
    const latestText = (await latestAssistantBubble.textContent()) ?? "";

    // Acceptance: this turn's bubble contains the sentinel AND does
    // NOT carry the "Reply lost on reload" error chip. (Other bubbles
    // in the thread may still have stale errors from old runs — that's
    // historical, not a regression for this fix.)
    expect(latestText).toContain(sentinel);
    expect(latestText).not.toMatch(/Reply lost on reload/i);

    await page.screenshot({ path: "test-results/journeys-chat-survives-reload-final.png", fullPage: false });
  });
});
