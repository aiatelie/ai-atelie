---
name: ship-task
description: Take an AI Atelie task — issue, ticket, or ad-hoc ask — all the way from description to merged-ready PR. Use whenever the user says "implement X and ship it", "work on issue #N", "ship this task", or any phrasing that implies the full implement → verify → commit → PR loop, not just a code change. Coordinates the verify-with-playwright and semantic-commit skills, runs a blast-radius regression check, and opens a PR with browser evidence attached.
---

# ship-task

A contributor workflow for AI Atelie. Orchestrates the full end-to-end loop a maintainer follows when shipping a task: understand → implement → verify in browser → blast-radius check → commit with semantic message → open PR with evidence.

This skill is **dev-time only**. It does not load into adapter sessions spawned by the editor.

## When to invoke

- "Ship task / issue #N" — explicit ship request.
- "Implement and PR this" — when a code change must result in a PR, not just a diff.
- "Work on issue #N" when the user expects a finished, reviewable PR rather than a discussion.

Skip when:

- The user is exploring or debugging without a clear acceptance bar.
- The change is a one-line tweak the user wants reviewed verbally before committing.
- The user explicitly says "just edit, don't commit".

## Hard preconditions (STOP if unmet)

This skill **delegates** to two other skills. Skills cannot programmatically invoke each other — Claude must coordinate. Before starting, verify both are loaded:

- [ ] `verify-with-playwright` is in the available skills list.
- [ ] `semantic-commit` is in the available skills list.

If either is missing, **STOP** and tell the user: "ship-task needs both verify-with-playwright and semantic-commit loaded. They live at .claude/skills/. Confirm they're present and retry."

Also verify:

- [ ] `gh` CLI is authenticated (`gh auth status` succeeds).
- [ ] `bun run setup:attach` has been run on this machine at least once (Chromium profile at `~/.local/state/aiatelie/chromium-profile/` exists). Refresh every few weeks. No plaintext cookies/tokens are written anywhere — session data lives in Chromium's own binary store.
- [ ] You're on a branch that isn't `main` (or the user has explicitly OK'd shipping straight to main, which is unusual).
- [ ] `bun run dev` is running on `:5173` (the verify step needs it).

## The loop (paste this checklist into your reply and tick as you go)

- [ ] **Step 1** — Understand the task (re-read issue, read related code, state acceptance criteria back).
- [ ] **Step 2** — Implement (minimum change satisfying acceptance criteria; no drive-by refactors).
- [ ] **Step 3** — Verify in browser (delegate to `verify-with-playwright`).
- [ ] **Step 4** — Blast-radius regression check (write a *named report*, not a vibes summary).
- [ ] **Step 5** — Commit with semantic message (delegate to `semantic-commit`).
- [ ] **Step 6** — Open PR with evidence attached.

## Step 1 — Understand the task

For an issue:

```sh
gh api repos/aiatelie/ai-atelie/issues/<N> --jq '.title, .body'
```

(Note: `gh issue view` currently fails on this repo due to the deprecated Projects-classic API; use `gh api` until cli/cli ships the migration.)

For an ad-hoc ask: the user's message IS the task description.

Then:

1. **Quote the acceptance criteria back** to the user verbatim (or paraphrase tightly if none are explicit).
2. **State the implementation plan** in 2–4 bullets — what files you'll touch and why.
3. **Pause for confirmation** if the criteria are ambiguous. A 30-second clarification beats an hour of wrong direction.

## Step 2 — Implement

Rules:

- **Minimum change** that satisfies the acceptance criteria. No drive-by cleanup, no premature abstractions.
- **One logical change per commit** is the goal even if you split into several commits later.
- **No new dependencies** unless the issue justifies it.
- **Type-check as you go**: `cd web && bun run build` to surface TS errors before the verify step.

## Step 3 — Verify (delegate)

Invoke `verify-with-playwright` with:

- The acceptance criteria from Step 1.
- The route or surface that exercises the change.
- A name for the spec (use the issue slug or a noun for ad-hoc tasks).

Wait for its `VERIFY-RESULT: pass` block. If it returns `fail`, **go back to Step 2** — don't paper over a failed verify with a "skip the test" commit.

If `verify-with-playwright` is genuinely inapplicable (e.g. an `api/` change with no UI surface), say so explicitly in the PR body's test plan — don't fake a verify step.

## Step 4 — Blast-radius regression check

This step is the one that earns this skill's name. "Verify no regressions" without forced artifacts is the #1 handwaving trap.

Produce a **Blast Radius Report** in this exact format:

```
## Blast Radius Report

### Symbols I changed
- `<symbol>` in `<file>:<line>` — purpose: ...
- `<symbol>` in `<file>:<line>` — purpose: ...

### Importers / call sites
- `<file>:<line>` calls `<symbol>` — affected? <yes/no/uncertain> — why?
- `<file>:<line>` imports `<file>` — affected? <yes/no/uncertain> — why?

### Shared user flows that touch this code path
- Flow A: <name>. Affected? <yes/no>. Justification or re-test result.
- Flow B: <name>. Affected? <yes/no>. Justification or re-test result.
- Flow C: <name>. Affected? <yes/no>. Justification or re-test result.

### Verdict
- <No regression risk found> | <Risk found, mitigated by ...> | <Risk found, NOT mitigated, flagging in PR>
```

To produce the importers list, use grep / ripgrep:

```sh
rg -n "<symbol>" --type ts --type tsx
rg -n "from ['\"].*<file-stem>" --type ts --type tsx
```

For each "uncertain" entry, you must either prove non-affectation or re-run `verify-with-playwright` against that flow. **No vibes-based dismissals.**

For changes touching shared modules (anything imported by ≥3 files), the "shared user flows" section must list at least 3 distinct flows.

## Step 5 — Commit (delegate)

Invoke `semantic-commit` with:

- The diff (`git diff --staged` or stage it first).
- A one-line summary of what the change does and why.
- The issue number(s) for `Closes` / `Refs` footers.

Let it draft the message; show it to the user; on confirm, create the commit.

If the work spans multiple logical changes, split into multiple commits — one per change. Never amend a prior commit on this branch unless the user explicitly asks.

## Step 6 — Open PR

Pre-PR checklist:

- [ ] Branch is up to date with `main` (`git fetch origin && git rebase origin/main` if needed).
- [ ] All commits follow Conventional Commits.
- [ ] Evidence is bundled in `.evidence/<run>/`.
- [ ] Blast Radius Report is ready to paste into the PR body.

Upload evidence to GitHub's `user-attachments` CDN with the in-repo helper. Returns a JSON array of `{file, url}` you can plug into the PR body. Videos play inline if you embed the bare URL on its own line; images go in `<img alt="..." src="..." />` tags.

```sh
bun run upload:evidence aiatelie/ai-atelie/pull/<N> \
  .evidence/<run>/before.png \
  .evidence/<run>/after.png \
  .evidence/<run>/video.mp4
```

If the video is a long Playwright recording (typical: 5+ min webm), compress it first so the upload is fast and the inline player loads reasonably:

```sh
ffmpeg -i .evidence/<run>/video.webm \
  -filter:v "setpts=0.125*PTS,scale=1024:-2" \
  -an -c:v libx264 -preset fast -crf 28 -movflags +faststart \
  -y .evidence/<run>/video.mp4
```

That's 8× speed + 1024px width + reasonable compression — typical 19MB/5min input → ~1.5MB/30sec output.

Then create the PR with this body template:

```markdown
## Summary

<1-3 sentence summary>

Closes #<issue-number>

## Acceptance criteria

- [x] <criterion 1>
- [x] <criterion 2>

## Test plan

- [x] `bunx playwright test web/tests/e2e/<slug>.spec.ts` passes
- [x] Manual: <any extra manual checks>

## Evidence

**Before:** <BEFORE_MD>
**After:** <AFTER_MD>

### Run video

<VIDEO_MD>

## Blast Radius

<paste the report from Step 4>

## Notes

<anything reviewers should know — gotchas, follow-ups deferred, etc.>
```

Open with:

```sh
gh pr create --title "<conventional-commit header>" --body "$(cat <<'EOF'
... <body above> ...
EOF
)"
```

After creation, output the PR URL. Then prune `.evidence/` to the last 5 runs.

## Step 7 — Attach evidence to the PR body

Delegate to **`.claude/skills/pr-evidence/SKILL.md`** — that skill
owns the contract for the canonical evidence flow (8 baseline
journeys + optional `--task <spec>` for per-PR feature demos),
including the verification step that confirms the body update
landed.

The short version:

```sh
# Canonical: full suite + body update on the current PR
bun run journeys

# With a per-PR feature demo (write a small Playwright spec, then:)
bun run journeys -- \
  --task path/to/feature-demo.spec.ts \
  --task-title "Feature title" \
  --task-description "What this PR proves visually."
```

When to write a `--task` spec:

- This PR ships a user-visible feature (theme, UI flow, new affordance).
- Skip if the PR is purely API/server/config; baseline alone is enough.

If `bun run journeys` reports a failure, walk the `cuj-guardian`
triage protocol before touching either the spec or the feature.
Don't ship until the suite is green or the failure is documented.

## Anti-patterns

- **"Verified by inspection."** Not allowed. **INSTEAD**: run `verify-with-playwright` against the change, or — if the surface genuinely has no UI (api-only, mcp-only, config) — state that explicitly in the PR body's test plan with a one-line reason.
- **Skipping Step 4.** The Blast Radius Report is the most valuable artifact this skill produces; without it, you're a slightly-better-than-nothing autocommitter. **INSTEAD**: produce the report even when no risk is found — the act of writing it forces the inspection, and "No regression risk found" with the importer list attached is itself the evidence.
- **Amending commits to "fix" something.** History-tells-the-story is load-bearing for the changelog. **INSTEAD**: create a new commit. If the prior commit was wrong, write a `revert` commit. If the prior commit needs a follow-up, write a `fix` commit that references it in the body.
- **`--no-verify` on commits.** Bypassing hooks hides the failure, not the cause. **INSTEAD**: read the hook's error, fix the underlying issue, re-stage, commit again. If the hook itself is broken, fix the hook in its own commit before continuing.
- **Force-pushing to anything that isn't your own branch.** **INSTEAD**: push normally to your branch; if `main` or a shared branch needs to change, open a PR. If your own branch needs history rewrite (e.g. squash before merge), confirm with the maintainer first.

## When the loop should bail out

- **Step 1 ambiguity** the user can't resolve: bail. A wrong implementation is worse than a delayed one.
- **Step 3 fail you can't fix in 2 attempts**: bail, write up what failed, ask the user to look.
- **Step 4 finds a real regression risk you can't mitigate**: bail, document the risk in the PR as draft, flag for review.
- **Step 6 PR creation fails for credentials**: bail, ask user to `gh auth login`, do not retry blindly.

## See also

- `.claude/skills/verify-with-playwright/SKILL.md` — the verify delegate.
- `.claude/skills/semantic-commit/SKILL.md` — the commit delegate.
- `.claude/skills/pr-evidence/SKILL.md` — Step 7 delegate (journey suite + body update).
- `CONTRIBUTING.md` — repo-wide commit/release/skill conventions.
- `playwright.config.ts` — e2e config the verify step uses.
