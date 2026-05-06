// Iframe runtime-error overlay (#37) — proves the host UI surfaces JS
// throws + unhandled rejections that happen inside the canvas iframe.
//
// Strategy: open an existing project (the bundled `demo` always has a
// rendered iframe), then trigger errors directly inside the iframe's
// window via page.evaluate. The inject-script's window.onerror listener
// forwards them; IframeErrorOverlay renders the overlay.
//
// Acceptance criteria covered (from issue #37):
//   ✓ throw inside iframe → overlay appears
//   ✓ stack expandable
//   ✓ "Send to chat" prefills the composer
//   ✓ throttle dedupes identical messages within 1s
//   ✓ dismiss × removes the card
//
// Auto-dismiss after 30s is asserted via the THROTTLE/AUTO_DISMISS
// constants in the source rather than a 30s wall clock here, since
// every spec timeout is a tax on PR turnaround.

import { test, expect } from "@playwright/test";

// Optional override: set ATELIE_BASE_URL=http://localhost:5175 to drive
// a worktree-isolated dev server (different port than the user's main
// `bun run dev`). Defaults to "/" against the configured baseURL when
// not set, so this spec runs unmodified in the standard contributor flow.
const BASE_URL = process.env.ATELIE_BASE_URL ?? "";

test.describe("IframeErrorOverlay", () => {
  test.setTimeout(60_000);

  // Helpers ────────────────────────────────────────────────────────
  async function openDemoProject(page: import("@playwright/test").Page) {
    await page.goto(BASE_URL ? `${BASE_URL}/` : "/", { waitUntil: "domcontentloaded" });
    // The demo project always ships with the repo. Project cards are
    // rendered as `<div role="button">`-style click targets — Projects.tsx
    // wires onClick at the wrapper level rather than using a real button.
    // Match by visible heading text and click.
    await page.getByText(/AI Atelie demo|demo/i).first().click();
    await page.waitForURL(/\/editor/, { timeout: 10_000 });
    await page.waitForSelector("iframe", { timeout: 10_000 });
    // Wait for inject-script.js to load + announce ready inside the
    // iframe. Its presence is the precondition for the runtime-error
    // listener to be wired.
    const iframe = page.frameLocator("iframe").first();
    await iframe.locator("body").waitFor({ timeout: 10_000 });
    // A small extra beat so the inject-script's `ready` event has fired.
    await page.waitForTimeout(800);
  }

  async function throwInIframe(
    page: import("@playwright/test").Page,
    message: string,
  ) {
    // Run inside the iframe context. The thrown Error bubbles to
    // window.onerror, which the inject-script forwards to parent.
    await page.frameLocator("iframe").first().locator("body").evaluate(
      (_body, msg) => {
        // setTimeout with 0ms makes the throw happen on the macrotask
        // queue, which routes through window.onerror reliably (synchronous
        // throws inside an evaluate callback get caught by the Playwright
        // bridge and never reach the listener).
        setTimeout(() => { throw new Error(msg); }, 0);
      },
      message,
    );
    // Give the postMessage round-trip a beat to land on the host.
    await page.waitForTimeout(300);
  }

  // Tests ──────────────────────────────────────────────────────────

  test("throw inside iframe → overlay surfaces the message", async ({ page }) => {
    await openDemoProject(page);

    await throwInIframe(page, "Boom from the artifact");

    const overlay = page.getByTestId("iframe-error-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Boom from the artifact");
  });

  test("identical errors within 1s collapse into a count badge (throttle)", async ({ page }) => {
    await openDemoProject(page);

    // Fire three identical throws in quick succession.
    await throwInIframe(page, "Same error message");
    await throwInIframe(page, "Same error message");
    await throwInIframe(page, "Same error message");

    const overlay = page.getByTestId("iframe-error-overlay");
    await expect(overlay).toBeVisible();
    // Only one card; the count chip reads ×3.
    await expect(overlay).toContainText(/×3|x3/);
  });

  test("expand reveals the stack trace", async ({ page }) => {
    await openDemoProject(page);
    await throwInIframe(page, "Error with a stack");

    const overlay = page.getByTestId("iframe-error-overlay");
    await expect(overlay).toBeVisible();

    // The message is itself a button — clicking toggles expansion.
    await overlay.getByRole("button", { name: /Error with a stack/ }).click();

    // The stack-trace <pre> shows up after expansion. We don't assert on
    // its exact content (V8 stack format varies by minor version); just
    // that some non-empty stack-shaped block is present.
    const stack = overlay.locator("pre").first();
    await expect(stack).toBeVisible();
    const text = await stack.innerText();
    expect(text.length).toBeGreaterThan(0);
  });

  test("Send to chat prefills the composer", async ({ page }) => {
    await openDemoProject(page);
    // The left panel boots on Files; reveal the chat composer first.
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    await throwInIframe(page, "Send-me-to-chat error");

    const overlay = page.getByTestId("iframe-error-overlay");
    await overlay.getByRole("button", { name: /Send-me-to-chat error/ }).click();
    await overlay.getByRole("button", { name: /Send to chat/ }).click();

    // The composer textarea should now contain the formatted error block.
    const composer = page.locator("textarea[placeholder*='Reply to thread']").first();
    await expect(composer).toHaveValue(/Iframe runtime error/);
    await expect(composer).toHaveValue(/Send-me-to-chat error/);

    // The card itself should be dismissed after sending.
    await expect(overlay.getByRole("alert")).toHaveCount(0);
  });

  test("dismiss × removes the card", async ({ page }) => {
    await openDemoProject(page);
    // Pick an error name that doesn't share a substring with "Dismiss" so
    // the role-based selector below stays unambiguous.
    await throwInIframe(page, "Banana split exploded");

    const overlay = page.getByTestId("iframe-error-overlay");
    await expect(overlay).toContainText("Banana split exploded");

    // Exact name match — the message button uses the error message as its
    // accessible name and would shadow this otherwise.
    await overlay.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(overlay.getByRole("alert")).toHaveCount(0);
  });

  test("unhandledrejection is also surfaced", async ({ page }) => {
    await openDemoProject(page);

    await page.frameLocator("iframe").first().locator("body").evaluate(() => {
      // Eagerly-rejected promise with no .catch — fires unhandledrejection.
      Promise.reject(new Error("Async boom"));
    });
    await page.waitForTimeout(300);

    const overlay = page.getByTestId("iframe-error-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText(/Unhandled promise rejection/);
    await expect(overlay).toContainText(/Async boom/);
  });
});
