import { test, expect } from "@playwright/test";

/**
 * Verifies the window.ai.complete() round-trip end-to-end:
 *   artifact (sandboxed iframe) — bridge injected by API on every HTML
 *     → window.ai.complete("…")
 *     → postMessage __ai_complete → window.parent
 *     → host bridge (web/src/lib/tweakBridge.ts)
 *     → POST /api/artifacts/complete with active modelId
 *     → adapter.complete() (claude SDK by default)
 *     → text reply
 *   ◀ postMessage __ai_complete_response → iframe Promise resolves.
 *
 * We don't drive the demo's HTML UI (it isn't the project's entry page,
 * so wiring it up via the editor is brittle). Instead we open the demo
 * project in the editor — which mounts its iframe with index.html and
 * the API-injected bridge — then evaluate window.ai.complete() directly
 * inside the iframe and assert on the awaited result. This exercises
 * the production bridge, the production host listener, and the real
 * adapter dispatch.
 */
test("window.ai.complete() round-trip resolves text in iframe", async ({ page, context }) => {
  await context.addInitScript(() => {
    // Force Sonnet so we don't burn Opus on the dogfood run.
    localStorage.setItem("editor-model-id", "claude-sonnet-4-6");
  });

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  const completeRequests: { url: string; status: number; body?: string }[] = [];
  page.on("response", async (res) => {
    if (res.url().includes("/api/artifacts/")) {
      let body: string | undefined;
      try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      completeRequests.push({ url: res.url(), status: res.status(), body });
    }
  });

  // Land on /projects, find the demo card by name, open it.
  await page.goto("/projects", { waitUntil: "domcontentloaded" });

  const demoCard = page
    .getByRole("link", { name: /AI Atelie demo/i })
    .or(page.getByRole("button", { name: /AI Atelie demo/i }))
    .or(page.getByText(/AI Atelie demo · LinkedIn banner/i))
    .first();
  await expect(demoCard, "demo card visible on /projects").toBeVisible({ timeout: 15_000 });
  await demoCard.click();

  // Wait for the editor URL.
  await page.waitForURL(/\/editor\?p=/, { timeout: 15_000 });

  // The editor mounts a project iframe. Wait for any iframe whose src
  // points at /p/<id>/ — that's the preview surface that gets the
  // bridge injection.
  const previewFrameLocator = page.locator(`iframe[src*="/p/"]`).first();
  await expect(previewFrameLocator, "preview iframe visible").toBeVisible({ timeout: 15_000 });

  // Wait for the iframe document to actually load (load event), then
  // for the bridge to be installed by the inline IIFE.
  const iframe = page.frameLocator(`iframe[src*="/p/"]`).first();
  await expect(
    iframe.locator("body"),
    "iframe body present",
  ).toBeAttached({ timeout: 10_000 });

  // Bridge sanity: window.ai.complete should be defined.
  const bridgeReady = await iframe.locator("body").evaluate(
    () => typeof (window as unknown as { ai?: { complete?: unknown } }).ai?.complete === "function",
  );
  expect(bridgeReady, "window.ai.complete defined in iframe").toBe(true);

  // Drive a real call from inside the iframe and read the resolved
  // value back out via a DOM marker. Using a marker (rather than
  // returning the Promise directly across the bridge) keeps the
  // evaluate boundary simple.
  await iframe.locator("body").evaluate(async () => {
    const w = window as unknown as { ai: { complete: (p: string) => Promise<string> } };
    const out = document.createElement("div");
    out.id = "__test_out";
    out.textContent = "";
    document.body.appendChild(out);
    try {
      const text = await w.ai.complete("Say hi in exactly three words.");
      out.textContent = "OK:" + text;
    } catch (e) {
      out.textContent = "ERR:" + (e instanceof Error ? e.message : String(e));
    }
  });

  // Wait for the marker to populate. 45s budget — claude SDK cold spawn
  // is ~5s in our local tests; padding for slower machines / first hit.
  const marker = iframe.locator("#__test_out");
  await expect(marker, "result marker populates").toContainText(/^(OK:|ERR:)/, { timeout: 45_000 });

  const markerText = (await marker.innerText()).trim();
  console.log(`[window-ai-complete] marker: ${markerText}`);
  console.log(`[window-ai-complete] requests:`, completeRequests);
  if (consoleErrors.length) console.log(`[window-ai-complete] console errors:`, consoleErrors);

  await page.screenshot({ path: "test-results/window-ai-complete-final.png", fullPage: true });

  // Acceptance.
  expect(markerText.startsWith("OK:"), `complete returned text (got: ${markerText.slice(0, 200)})`).toBe(true);
  expect(markerText.length, "result has body").toBeGreaterThan("OK:".length + 2);

  const okComplete = completeRequests.find(
    (r) => r.url.includes("/api/artifacts/complete") && r.status === 200,
  );
  expect(okComplete, "POST /api/artifacts/complete returned 200").toBeTruthy();

  const bridgeErrs = consoleErrors.filter(
    (m) => /tweakBridge|__ai_complete|__claude_complete|window\.ai|window\.claude/i.test(m),
  );
  expect(bridgeErrs, "no bridge-related console errors").toEqual([]);
});
