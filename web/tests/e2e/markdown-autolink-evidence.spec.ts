// Regression spec for issue #43 Phase D — bare-URL autolink + safer
// text rendering in chat <Markdown>. Loads a tiny in-source probe
// (__markdown_probe.tsx) so Vite resolves React imports properly, then
// asserts on the rendered DOM:
//   1. plain "https://example.com" → <a href="https://example.com">
//   2. trailing punctuation stays in surrounding text (not in URL)
//   3. anchor has rel="noreferrer noopener" + target="_blank"
//   4. explicit [text](href) markdown link still renders as a single anchor
//   5. text containing "<script>" is rendered as literal characters
//      (proves the dangerouslySetInnerHTML path is gone)
//
// Uses Playwright's configured baseURL (defaults to :5173 — set via
// playwright.config.ts). Run with `bunx playwright test
// web/tests/e2e/markdown-autolink-evidence.spec.ts`.

import { test, expect, type Page } from "@playwright/test";

async function mountWith(page: Page, text: string) {
  await page.goto("/");
  // Use Vite's own module graph by importing the probe source; Vite
  // resolves bare specifiers (react-dom/client) for source modules,
  // unlike inline page.evaluate() code.
  await page.evaluate(async (input) => {
    const probe = document.createElement("div");
    probe.id = "md-probe";
    probe.setAttribute("data-testid", "md-probe");
    document.body.appendChild(probe);
    const m = await import(
      /* @vite-ignore */ "/src/components/editor/__markdown_probe.tsx"
    );
    m.mountProbe(probe, input);
  }, text);
  await page.waitForSelector("#md-probe a, #md-probe p", { timeout: 5_000 });
}

test("bare http(s) URL becomes an anchor with rel=noreferrer noopener", async ({
  page,
}) => {
  await mountWith(page, "Visit https://example.com for details.");
  const link = page.locator("#md-probe a");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", "https://example.com");
  await expect(link).toHaveAttribute("rel", "noreferrer noopener");
  await expect(link).toHaveAttribute("target", "_blank");
  // Trailing period stays in surrounding text, not swallowed by the URL.
  await expect(page.locator("#md-probe")).toContainText("Visit");
  await expect(page.locator("#md-probe")).toContainText(".");
});

test("multiple bare URLs render as separate anchors", async ({ page }) => {
  await mountWith(page, "see https://a.example then https://b.example");
  const links = page.locator("#md-probe a");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("href", "https://a.example");
  await expect(links.nth(1)).toHaveAttribute("href", "https://b.example");
});

test("explicit [text](href) markdown link is preserved", async ({ page }) => {
  await mountWith(page, "see [docs](https://example.com)");
  const links = page.locator("#md-probe a");
  await expect(links).toHaveCount(1);
  await expect(links).toHaveText("docs");
  await expect(links).toHaveAttribute("href", "https://example.com");
});

test("text containing HTML-like characters renders escaped, not as DOM", async ({
  page,
}) => {
  // Proves the dangerouslySetInnerHTML path is gone — if it weren't,
  // "<script>" would still be attempted by innerHTML. The text node now
  // goes through React's normal text-as-text rendering, so the angle
  // brackets are literal characters and no <script> element appears.
  await mountWith(page, "watch out for <script>alert(1)</script> in chat");
  const probe = page.locator("#md-probe");
  await expect(probe).toContainText("<script>alert(1)</script>");
  await expect(probe.locator("script")).toHaveCount(0);
});
