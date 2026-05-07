---
name: pr-evidence
description: Run AI Atelie's journey suite and inject inline-rendering evidence (per-journey video + screenshot, in a 4-column markdown table) into the current PR's body. Use whenever the user says "post evidence", "run journeys", "update PR with videos", or after `ship-task` opens a PR. Wraps `bun run journeys`; idempotent — re-runs replace the evidence block instead of appending.
---

# pr-evidence

Every AI Atelie PR ships with two evidence tables in the body:

- **Baseline** — the eight canonical journeys (home loads · home shows demo · create banner · switch model · agent edits canvas · canvas variations · comment translate · cleanup snapshot). Always runs.
- **Task evidence** — per-PR feature demo. Runs when the contributor passes a `--task <spec>` to the runner.

This skill is the contract for invoking the `bun run journeys` pipeline so the body update lands consistently across PRs.

## When to invoke

- Right after `gh pr create` lands (immediately after Step 6 of `ship-task`, formalized as Step 7 there).
- When a previous run failed mid-stream and the body is missing the evidence block.
- When the contributor wants to refresh evidence after pushing follow-up commits.
- Trigger phrases: *"post evidence"*, *"run journeys"*, *"update PR with videos"*, *"attach the evidence"*, *"refresh PR evidence"*.

**Skip when:**
- The PR is docs-only (no `web/` or `api/` source change). Evidence is wasted minutes and Anthropic-key cost.
- The dev server isn't up — fix that first; the runner refuses to start.
- A previous run on the same SHA already populated the block and nothing has changed.

## Hard preconditions

- `bun run dev` is running on `:5173` + `:5174`.
- One-time setup done: `bun run setup:attach` (Chromium persistent profile at `~/.local/state/aiatelie/chromium-profile/`).
- `gh` CLI authenticated.
- Network reach to api.anthropic.com (the agent journeys spend Sonnet calls).

If any precondition fails, **STOP** and surface the missing piece. Don't paper over.

## Workflow

```
[ ] 1. Confirm dev server is up: `curl -sf http://localhost:5173/`
[ ] 2. Identify the PR number: auto-detected via `gh pr view --json number`,
       or `--pr <n>` if running from a different branch.
[ ] 3. Decide whether this PR needs `--task` evidence (see "Task spec
       authoring" below). If yes, write a small spec under
       `web/tests/e2e/.task-staging/` (or pass an absolute path).
[ ] 4. Run the suite:
       - bare `bun run journeys` for the canonical case
       - `bun run journeys -- --task <spec> --task-title "X" --task-description "Y"`
         when this PR ships a feature worth demoing
[ ] 5. Watch the per-journey progress lines. A failure prints the spec
       path and exit code; the runner continues with the rest.
[ ] 6. After the runner reports "PR #N body updated", verify:
       `gh pr view <N> --json body --jq .body | grep -c user-attachments`
       must return ≥ 16 (8 baseline × 2 artifacts) and ≥ 18 if `--task`
       was used.
[ ] 7. Confirm the auto-cleanup ran: `gh api repos/aiatelie/ai-atelie/issues/<N>/comments --jq '.|length'`
       must NOT have ballooned (the runner deletes the upload-evidence
       claim-comment after the body update).
```

## CLI reference

```sh
# Canonical: full suite, current PR, body update + auto-comment cleanup
bun run journeys

# Explicit PR
bun run journeys -- --pr 81

# Add per-PR feature evidence
bun run journeys -- \
  --task path/to/feature-demo.spec.ts \
  --task-title "Feature title" \
  --task-description "What this PR proves visually."

# Multiple tasks chain
bun run journeys -- \
  --task a.spec.ts --task-title "A" \
  --task-title --task-description "..." \
  --task b.spec.ts --task-title "B"

# Local-only (no GitHub interaction; bundles into .evidence/)
bun run journeys -- --no-upload

# Run task evidence WITHOUT the baseline (rare; only when iterating
# on a single task spec)
bun run journeys -- --skip-baseline --task path/to/feature-demo.spec.ts

# Single baseline journey (for debugging)
bun run journeys -- --only home-shows-demo
```

## Task spec authoring

Per-PR demos go in `.spec.ts` files the runner stages under `web/tests/e2e/.task-staging/` before invoking Playwright (the staging dir is gitignored). Conventions:

- Save the final screenshot at exactly `test-results/journeys-<basename>-final.png` where `<basename>` is the spec filename minus `.spec.ts`.
- Use `getByTestId(...)` for load-bearing UI nodes — copy/CSS tweaks shouldn't break the spec.
- Navigate to `/projects?journey-mode=1` for clean home screenshots (filters to demo + Journey · *).
- For agent-driven specs, force Sonnet for cost/speed:
  ```ts
  await page.addInitScript(() => {
    try { localStorage.setItem("editor-model-id", "claude-sonnet-4-6"); } catch {}
  });
  ```

Reference: `web/tests/e2e/journeys/home-loads.spec.ts` (UI-only) and `agent-edits-canvas.spec.ts` (agent-driven) are good starting templates.

## Anti-patterns

- **Don't post evidence in a comment.** The runner edits the body. Comments are noise; the upload-evidence claim-comment is auto-deleted post-body-update on purpose.
- **Don't run the suite with Opus.** Sonnet is the convention (set in agent journey specs). Switching to Opus burns cost without raising fidelity.
- **Don't loosen a journey assertion to make it green.** If a journey fails, walk the `cuj-guardian` triage protocol first.
- **Don't run journeys on docs-only PRs.** The agent journeys take real money to execute.

## Why this is a skill, not a subagent

The work is small (one shell command + body-update verification) and the contributor needs full conversation context to (a) decide whether to write a `--task` spec for *this* PR, and (b) phrase the title/description. Isolation would force re-loading that context.

Triggers to revisit (move to a subagent or split):
1. Playwright stdout noise pollutes the main conversation enough that summarization-then-discard becomes worth the context-fork overhead.
2. Journeys + verify-with-playwright start running in parallel routinely (a subagent unlocks parallelism).
3. PR review traffic gets heavy enough that triaging review comments needs its own context window.

See [`.claude/skills/README.md`](../README.md#when-to-upgrade-a-skill-to-a-subagent) for the project-wide deferral policy.

## See also

- [`ship-task/SKILL.md`](../ship-task/SKILL.md) — Step 7 invokes this skill.
- [`verify-with-playwright/SKILL.md`](../verify-with-playwright/SKILL.md) — for per-task evidence that's lighter than a full journey spec.
- [`cuj-guardian/SKILL.md`](../cuj-guardian/SKILL.md) — triage protocol when a journey fails.
- [`scripts/run-journeys.mjs`](../../../scripts/run-journeys.mjs) — implementation.
- [`web/tests/e2e/journeys/README.md`](../../../web/tests/e2e/journeys/README.md) — journey catalog + conventions.
