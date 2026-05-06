---
name: verify-with-playwright
description: Drive a real browser against AI Atelie's running dev server to verify a change works, and capture screenshots + video as PR evidence. Use whenever the user asks to "verify in browser", "prove it works", "add PR evidence", or before opening a PR that touches `web/` or any user-facing surface. Assumes `bun run dev` is already running on http://localhost:5173.
---

# verify-with-playwright

A contributor workflow for AI Atelie. Drives the local dev server with `@playwright/test` (runner mode, not MCP), produces a `test-results/<spec>/` folder with video + screenshots + trace, then bundles the relevant files into `.evidence/<run>/` for upload to a PR.

This skill is **dev-time only**. It does not load into adapter sessions spawned by the editor.

## When to invoke

- After implementing any change that touches `web/`, the iframe canvas, the chat surface, the editor toolbar, or any other user-visible behaviour.
- When the `ship-task` orchestrator delegates verification.
- When the user asks "does it actually work in the browser?" or "show me proof".

Skip when:

- The change is API-only with no observable surface (use `web/tests/test-*.mjs` integration tests instead).
- The change is a doc-only or config-only edit.

## Preflight (do this before writing any spec)

1. **Confirm the dev server is up.** Run:
   ```sh
   curl -sSf http://localhost:5173 > /dev/null && echo "up" || echo "down"
   ```
   If down, **STOP** and tell the user: "Run `bun run dev` in another terminal, then retry." Do NOT spawn `bun run dev` from this skill — backgrounded dev servers leak across sessions and will clobber the user's own terminal.
2. **Confirm Playwright is installed.** `bunx playwright --version` should print `Version 1.59.x` or higher. If not, run `bun add -D @playwright/test && bunx playwright install chromium`.
3. **Read `playwright.config.ts`** at repo root to confirm the test dir, baseURL, and artifact policy haven't drifted.

## Workflow (paste this checklist into your reply and tick as you go)

- [ ] **Preflight passed** (dev server up, Playwright installed).
- [ ] **Acceptance criteria identified.** From the issue or the user's task description, list the *user-observable* properties that must hold. Example for #1 (live preview): "agent text deltas appear in iframe srcdoc within 500ms of arrival; full reload not required".
- [ ] **Spec authored.** Write `web/tests/e2e/<slug>.spec.ts`. One scenario per file. Use role-based selectors. Each acceptance criterion → one or more `expect(...)` calls.
- [ ] **Spec runs.** `bunx playwright test web/tests/e2e/<slug>.spec.ts --reporter=list`.
- [ ] **Wait for the agent to FULLY COMPLETE before stopping the recording.** This is the rule reviewers care about most — see "Evidence must show the post-completion state" below. A capture that ends mid-stream proves nothing.
- [ ] **Capture the post-completion state explicitly.** A final screenshot AFTER the busy/loading state clears AND the user-visible result is rendered. The reviewer must be able to see *what the agent actually produced*, not just *that it was working*.
- [ ] **Evidence bundled.** Copy `test-results/<slug>/video.webm` and any `*.png` into `.evidence/<ISO-timestamp>-<slug>/`.
- [ ] **(Optional) headed run for video review.** `--headed` for clearer screen recordings on visual changes.
- [ ] **Cleanup.** Prune `.evidence/` to keep only the last 5 run folders.
- [ ] **Report.** Output the absolute paths of evidence artifacts so `ship-task` (or the user) can attach them to the PR.

## Authoring a spec

Minimal scaffold:

```ts
import { test, expect } from "@playwright/test";

test("live-preview streams text deltas into iframe", async ({ page }) => {
  await page.goto("/");
  // ... drive the surface that exercises the change

  // ... assert acceptance criteria
  await expect(page.frameLocator("iframe").locator("h1")).toHaveText(/Hello/);
});
```

Conventions:

- **Always `await page.goto('/')` first.** The `baseURL` resolves to `http://localhost:5173`.
- **Prefer role-based selectors** (`getByRole('button', { name: 'New project' })`) over CSS selectors. They survive markup churn.
- **One scenario per file**, named `<feature>.spec.ts`.
- **Test the surface, not the agent's output.** The agent is non-deterministic; the surface's behaviour around it should be deterministic.
- **No external network in tests.** Mock the agent stream with `page.route('/api/...', route => route.fulfill({...}))` if needed.

## Running the spec

```sh
# Full run, list reporter (Claude reads this output well)
bunx playwright test web/tests/e2e/<slug>.spec.ts --reporter=list

# Headed mode for better video evidence
bunx playwright test web/tests/e2e/<slug>.spec.ts --headed

# View the HTML report after a failure
bunx playwright show-report
```

## Evidence MUST show the post-completion state

**Rule**: a capture that ends while the agent is still working (or while the loading/busy/streaming UI is still on screen) is incomplete evidence and should never be submitted to a PR.

The point of evidence is to demonstrate two things, in order:

1. **The change still produces the expected user-visible outcome** — the agent finished, the result rendered, the iframe shows the new content, the file was written, whatever the acceptance criteria called for.
2. (Optionally, secondarily) **The in-flight UX is correct** — loading spinner appears, busy pill rotates, progress is visible.

If your video stops at step 2, you have *zero* evidence for step 1. Reviewers can't tell whether the feature actually worked or whether the script bailed before anything happened.

### How to wait for completion correctly

Don't sleep a fixed timeout — poll for the *signal* that completion happened:

```ts
// Wait for the agent's busy state to CLEAR after we know it started.
// (Make sure we saw it busy at least once first — otherwise we'd race
// past a fast turn that finished before we started polling.)
let sawBusy = false;
const start = Date.now();
while (Date.now() - start < 6 * 60_000) {
  const busy = await page.locator("[role=status]").isVisible().catch(() => false);
  if (busy) sawBusy = true;
  else if (sawBusy) break;
  await page.waitForTimeout(2_000);
}
expect(sawBusy, "agent run was observed to be in flight at some point").toBe(true);
```

Then add ONE extra `await page.waitForTimeout(2_000)` after the busy state clears so the iframe re-renders before you screenshot.

### Other valid completion signals

- **Filesystem**: poll `web/projects/<id>/` until a target file is written or modified (use `stat().mtimeMs` against a pre-prompt snapshot — see `cuj.spec.ts` for the pattern).
- **DOM mutation**: `page.waitForFunction(() => document.querySelector("[data-step-count]")?.textContent !== "0")`
- **Chat thread**: wait for an "Undo" / "Restore" button to appear (which only renders post-completion in this codebase).
- **Iframe content**: `await page.frameLocator("iframe").locator("body").innerText()` returns text matching the expected result.

NEVER use `await page.waitForTimeout(60_000)` and assume the agent finished. Some runs are 5 seconds, some are 5 minutes.

## Bundling evidence

After a successful run, the relevant artifacts live at:

- `test-results/<slug>-<browser>/video.webm`
- `test-results/<slug>-<browser>/test-failed-*.png` (if any)
- `playwright-report/data/<hash>.zip` (HTML report bundle)

Copy them into `.evidence/<ISO-timestamp>-<slug>/`:

```sh
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
RUN_DIR=".evidence/${TS}-<slug>"
mkdir -p "$RUN_DIR"
cp test-results/<slug>*/video.webm "$RUN_DIR/" 2>/dev/null || true
cp test-results/<slug>*/*.png      "$RUN_DIR/" 2>/dev/null || true
echo "Evidence bundled at $RUN_DIR"
```

`.evidence/` is gitignored.

## Disk hygiene

After bundling, prune older runs to keep the last 5:

```sh
ls -1t .evidence | tail -n +6 | xargs -I{} rm -rf ".evidence/{}"
```

Once evidence is uploaded to a PR via `bun run upload:evidence` (see `scripts/upload-evidence.mjs`), the canonical copy lives on GitHub's `user-attachments/assets/...` CDN — videos play inline, images embed natively. Local `.evidence/` is just scratch. Note: this requires a one-time `bun run setup:attach` to log into github.com via Chromium; the cookies live in `~/.local/state/aiatelie/` (per-user, never committed).

## Known failure modes

- **`:5173` taken by stale Vite.** Diagnose with `lsof -ti:5173`; surface the PID to the user. Don't auto-kill.
- **Headless vs headed divergence.** Some CSS (`:focus-visible`, scrollbar widths) renders differently. Use `--headed` for visual evidence runs.
- **`localhost` vs `127.0.0.1`.** Vite 8.x binds to `localhost` (which resolves to IPv6 `::1` on macOS), not `127.0.0.1`. Always use `localhost:5173`; `curl 127.0.0.1:5173` will fail.
- **MJS test files masquerading as Playwright specs.** The existing `web/tests/test-*.mjs` are *integration tests*, NOT Playwright specs. Don't put `.spec.ts` files in `web/tests/` root; only under `web/tests/e2e/`.
- **Bun loader edge cases.** Install Playwright with `bun add`, but **run** with `bunx playwright test` — Playwright's runner doesn't fully support Bun's loader at the time of writing.
- **Evidence too large.** A 5-min Playwright recording at native fps is ~20MB. Compress with `ffmpeg -filter:v "setpts=0.25*PTS,scale=1024:-2" -an -c:v libx264 -preset fast -crf 28 -movflags +faststart -y out.mp4` (4× speed, 1024w, no audio, web-tuned). Yields ~300KB / ~13s — small enough that the user-attachments inline player loads fast, fast enough to watch, still shows the entire idle → busy → completion arc.
- **Stopping the recording mid-stream.** The single most common evidence failure mode. See "Evidence MUST show the post-completion state" above.

## Anti-patterns the skill must refuse

- **Submitting evidence that ends while the agent is still working.** No matter how good the in-flight footage looks, if the recording stops before the post-completion state, the evidence is incomplete and the PR review will (correctly) bounce.
- **Aborting / cancelling the run** to save time on the capture. The point of evidence is the full flow; if you cancel, you're not proving anything happened.
- **Sleep-then-screenshot** as a fake completion signal. Use a real signal (busy state cleared, file modified, DOM mutation) — never a fixed timeout.
- **"It worked when I ran it manually"** — without captured evidence, this doesn't appear in the PR. Re-run with capture before submitting.

## Reporting back

When you finish, output a structured block the orchestrator (`ship-task`) can parse:

```
VERIFY-RESULT: pass | fail
EVIDENCE-DIR: .evidence/<ISO-timestamp>-<slug>/
ARTIFACTS:
  - .evidence/<.../video.webm>
  - .evidence/<.../before.png>
  - .evidence/<.../after.png>
ACCEPTANCE-CRITERIA:
  - [✓] Criterion 1 (assertion: ...)
  - [✓] Criterion 2 (assertion: ...)
```

If the run failed, do NOT delete the failure artifacts. Surface them so the user can debug.

## See also

- `playwright.config.ts` — the canonical config (artifact policy, baseURL, webServer).
- `web/tests/e2e/README.md` — contributor-facing e2e overview.
- `.claude/skills/ship-task/SKILL.md` — the orchestrator that calls this skill.
