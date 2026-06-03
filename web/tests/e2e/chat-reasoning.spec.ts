// chat-reasoning — proves the model's reasoning is (a) captured into the
// timeline and (b) shown as a visible "💭 Reasoning" block, not dropped.
// Reads the persisted thread file for ground truth (same check used to
// diagnose the missing-thoughts bug). Throwaway project; Sonnet.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const API_BASE = "http://localhost:5174";
const PROJECTS_DIR = path.resolve(import.meta.dirname, "../..", "projects");
const PROMPT =
  "Decide whether a luxury watch banner headline should be a serif or a " +
  "sans-serif. Think it through step by step out loud, then give a " +
  "one-sentence recommendation. Do not use any tools.";

test.describe("chat reasoning capture", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch { /* ignore */ }
    });
  });

  test("reasoning is captured into the timeline and shown as a visible block", async ({ page, request }) => {
    test.setTimeout(160_000);
    let projectId: string | undefined;
    try {
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-project-name").fill(`Verify · Reasoning ${Date.now().toString(36)}`);
      await page.getByTestId("create-project-submit").click();
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      projectId = page.url().match(/p=(p_[a-z0-9]+)/)?.[1];
      expect(projectId, "project id captured").toBeTruthy();
      await page.waitForSelector("iframe", { timeout: 15_000 });
      await page.waitForTimeout(600);

      await page.getByTestId("chat-composer").fill(PROMPT);
      await page.getByTestId("chat-send").click();
      await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 20_000 });

      // LIVE: while the turn streams, the reasoning capsule shows a timed
      // "Thinking… M:SS" header (best-effort — reasoning can be brief).
      let sawThinkingTimer = false;
      let done = false;
      const start = Date.now();
      while (Date.now() - start < 120_000) {
        if (!sawThinkingTimer) {
          sawThinkingTimer = await page.getByText(/Thinking…/).first().isVisible().catch(() => false);
        }
        const stopVisible = await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false);
        if (!stopVisible) { done = true; break; }
        await page.waitForTimeout(1_000);
      }
      expect(done, "turn finished").toBe(true);
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: "test-results/reasoning-done.png", fullPage: true });

      // DONE: the capsule auto-collapsed to its finished header ("Thought
      // for Ns" when timed live, else "Reasoning").
      const reasoningVisible = await page.getByText(/Thought for|Reasoning/).first().isVisible().catch(() => false);

      // Ground truth: the persisted timeline contains a thinking entry.
      const tjson = await readFile(path.join(PROJECTS_DIR, projectId!, ".meta", "threads.json"), "utf8");
      const data = JSON.parse(tjson);
      const threads = data.threads ?? data;
      const kinds: string[] = [];
      let thinkingChars = 0;
      for (const t of threads) {
        for (const msg of (t.messages ?? [])) {
          if (msg.role === "assistant" && Array.isArray(msg.timeline)) {
            for (const e of msg.timeline) {
              kinds.push(e.kind);
              if (e.kind === "thinking") thinkingChars += (e.text || "").length;
            }
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[reasoning] kinds=${JSON.stringify(kinds)} thinkingChars=${thinkingChars} sawThinkingTimer=${sawThinkingTimer} reasoningVisible=${reasoningVisible}`);

      expect(kinds.includes("thinking"), "timeline captured a thinking entry").toBe(true);
      expect(thinkingChars, "thinking entry has real content").toBeGreaterThan(20);
      expect(reasoningVisible, "reasoning capsule visible in the UI").toBe(true);
    } finally {
      if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
    }
  });

  test("Codex turns render in the timeline (reasoning best-effort)", async ({ page, request }) => {
    test.setTimeout(160_000);
    // Override the beforeEach model: use Codex (bare "codex" id).
    await page.addInitScript(() => {
      try { localStorage.setItem("editor-model-id", "codex"); } catch { /* ignore */ }
    });
    let projectId: string | undefined;
    try {
      await page.goto("/projects?journey-mode=1", { waitUntil: "domcontentloaded" });
      await page.getByTestId("create-project-name").fill(`Verify · Codex Reason ${Date.now().toString(36)}`);
      await page.getByTestId("create-project-submit").click();
      await page.waitForURL(/\/editor.*p=p_/, { timeout: 15_000 });
      projectId = page.url().match(/p=(p_[a-z0-9]+)/)?.[1];
      expect(projectId, "project id captured").toBeTruthy();
      await page.waitForSelector("iframe", { timeout: 15_000 });
      await page.waitForTimeout(600);

      await page.getByTestId("chat-composer").fill(
        "Compare three layout strategies for a luxury watch banner — centered, " +
        "asymmetric, and full-bleed. Weigh the trade-offs of each carefully, then " +
        "recommend one with justification. Think it through thoroughly before " +
        "answering. Do not edit files.",
      );
      await page.getByTestId("chat-send").click();
      await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 25_000 });

      let done = false;
      const start = Date.now();
      while (Date.now() - start < 120_000) {
        const stopVisible = await page.getByRole("button", { name: "Stop" }).isVisible().catch(() => false);
        if (!stopVisible) { done = true; break; }
        await page.waitForTimeout(2_000);
      }
      expect(done, "codex turn finished").toBe(true);
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: "test-results/reasoning-codex.png", fullPage: true });

      const tjson = await readFile(path.join(PROJECTS_DIR, projectId!, ".meta", "threads.json"), "utf8");
      const data = JSON.parse(tjson);
      const threads = data.threads ?? data;
      const kinds: string[] = [];
      const eventKinds: string[] = [];
      for (const t of threads) {
        for (const msg of (t.messages ?? [])) {
          if (msg.role !== "assistant") continue;
          if (Array.isArray(msg.timeline)) for (const e of msg.timeline) kinds.push(e.kind);
          // Phase 4: the canonical log is the authoritative turn shape and
          // is where the reasoning capsule / withheld marker live.
          if (Array.isArray(msg.events)) for (const e of msg.events) eventKinds.push(e.kind);
        }
      }
      // The app-server transport streams reasoning summaries (non-
      // deterministically), and when codex spends reasoning tokens WITHOUT
      // a summary the canonical log synthesizes a reasoning-meta{withheld}
      // marker (I7). Either way the reasoning layer should not be silently
      // empty — but codex is non-deterministic, so we LOG presence and only
      // hard-fail on the reply rendering (keeps this spec stable).
      const reasoningStreamed = kinds.includes("thinking") || eventKinds.includes("reasoning-delta");
      const reasoningWithheld = eventKinds.includes("reasoning-meta");
      // eslint-disable-next-line no-console
      console.log(
        `[codex-reasoning] timeline=${JSON.stringify(kinds)} ` +
        `events=${JSON.stringify([...new Set(eventKinds)])} ` +
        `streamed=${reasoningStreamed} withheld=${reasoningWithheld}`,
      );
      // Codex turns must render a reply (canonical text block → bubble).
      expect(
        kinds.includes("text") || eventKinds.includes("text-delta"),
        "codex turn rendered a reply",
      ).toBe(true);
    } finally {
      if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`).catch(() => null);
    }
  });
});
