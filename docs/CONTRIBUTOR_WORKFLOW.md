# Contributor workflow

How to take a task from "I have an idea / issue / ticket" to a merged PR with inline-rendering video evidence in the description, and how reviewers should use that evidence to validate the work. This is the canonical loop in AI Atelie as of `v0.1.7`.

> **TL;DR:** branch → implement → verify in browser → semantic commit → open PR → run `bun run journeys` → reviewer scrubs the table → merge → batch a release with `bun run release`.

---

## 0. Preconditions (one-time)

```sh
bun run setup:attach         # one-time Chromium login for evidence uploads
bun run dev                  # in another terminal — boots :5173 (web) + :5174 (api)
gh auth status               # confirm gh CLI logged in
```

If any of those fail, fix that first. Skills will refuse to run with broken preconditions instead of papering over.

---

## 1. The slash-command surface

Five dev-time skills cover the loop. They live under [`.claude/skills/`](../.claude/skills/) and Claude Code auto-loads them in the contributor session.

| Skill | What it owns | When to invoke |
|---|---|---|
| **`/ship-task`** | End-to-end orchestrator | Starting any task — drives understand → implement → verify → blast-radius → commit → PR → evidence |
| **`/verify-with-playwright`** | Per-task browser verification | Step 4 — proves *this change* works in a real browser, captures video + screenshots into `.evidence/<run>/` |
| **`/semantic-commit`** | Conventional Commits drafter | Step 5 — every commit, with the closed scope set (`api │ web │ mcp │ skills │ repo │ deps`) |
| **`/pr-evidence`** | Journey suite + PR-body update | Step 7 — wraps `bun run journeys`, renders the 4-column inline-video table |
| **`/cuj-guardian`** | Journey suite triage | Step 8 (only on failure) — five-step protocol to decide "broken feature" vs "stale test" |

Type the slash command in a Claude Code session, or describe the task and let Claude match the skill description. The skills coordinate by name; one skill can tell Claude to invoke a sibling.

---

## 2. The task loop — creator's view

### 2.1. Understand

Open `/ship-task`. It pulls the issue body via `gh api repos/aiatelie/ai-atelie/issues/<N>` (or reads chat context if no ticket), quotes the acceptance criteria back, and asks for confirmation before any code lands. Output: a 2-4 bullet implementation plan you sign off on.

If the request is ambiguous and you can't resolve it without guessing, **bail at this step**. A wrong implementation is worse than a delayed one.

### 2.2. Branch off main

```sh
git checkout main && git pull
git checkout -b feat/<scope>-<short-name>      # e.g. feat/web-comments-thread
```

**Branching rule**: one branch, multiple Conventional Commits, one PR. Never split into multiple PRs unless the changes are genuinely independent.

### 2.3. Implement (minimum viable)

- Edit only what the acceptance criteria require.
- Type-check after each meaningful edit: `cd web && bunx tsc -b --noEmit`.
- Run unit tests: `cd web && bun test src && cd ../api && bun test`.
- **Don't** add features beyond the ask, refactor unrelated code, or pad with extra error handling. A bug fix doesn't need surrounding cleanup; a one-shot operation doesn't need a helper.

### 2.4. Verify in browser (per-task evidence)

Use `/verify-with-playwright`. It writes a small spec under `web/tests/e2e/<slug>.spec.ts` that exercises the acceptance criteria, runs Playwright against the local dev server, captures video + final.png into `.evidence/<run>/`, and reports back `VERIFY-RESULT: pass | fail`.

This is **per-task** verification — different from the journey suite (Step 7). It proves *this specific change* works. The evidence ends up in the PR body's "Task evidence" table.

### 2.5. Semantic commits

Use `/semantic-commit` for each logical change. Format:

```
<type>(<scope>): <imperative subject>

<body explaining the why, not the what>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

- **Types**: `feat │ fix │ refactor │ chore │ docs │ style │ test`
- **Scopes** (closed set): `api │ web │ mcp │ skills │ repo │ deps`
- One logical change per commit. The history is the changelog — split coarsely into themes a reviewer can read in one sitting.
- **Never amend** unless the user explicitly asks. Pre-commit hook failure → fix the problem and create a NEW commit.

### 2.6. Open the PR

`/ship-task` Step 6 drives this. Body template:

```md
## Summary
<1-3 sentences>

## Acceptance criteria
- [x] criterion 1
- [x] criterion 2

## Test plan
- [x] `bunx tsc -b` green
- [x] `bun test src` green (web + api)
- [x] `verify-with-playwright` per-task spec passed
- [ ] `bun run journeys` populates body evidence (Step 7)

## Blast Radius Report
<symbols changed → importers/call sites → shared user flows → verdict>

## Notes
<gotchas, follow-ups deferred, related issues>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

The Blast Radius Report is the most valuable artifact `/ship-task` produces. For each symbol you changed, list:
- Who imports it (`rg -n "<symbol>" --type ts --type tsx`)
- Which user flows traverse those importers
- Verdict: *no regression found* / *risk found + mitigated* / *risk found NOT mitigated*

No vibes-based dismissals. Uncertain entries must be re-tested.

### 2.7. Attach evidence (`/pr-evidence`)

Right after the PR opens:

```sh
# Canonical: 8 baseline journeys + body update
bun run journeys

# With per-PR feature demo (recommended for any user-visible change)
bun run journeys -- \
  --task path/to/feature-demo.spec.ts \
  --task-title "Feature title" \
  --task-description "What this PR proves visually."
```

The runner produces a 4-column table inside `<!-- journey-evidence:start -->` markers in the PR body:

| Journey | What it proves | Screenshot | Video |
|---|---|---|---|
| ✅ **Home loads** · 0.7s | App shell paints; create form is interactive | `<img>` | `<video controls>` |
| ✅ **Create Hello World banner** · 0.6s | Name + Create lands in /editor with a fresh `p_*` | `<img>` | `<video controls>` |
| ... | ... | ... | ... |

Two sections: **Baseline** (8 journeys, always) + **Task evidence** (the `--task` specs you passed, optional). Failures sort to the top of each table.

Each video cell is a real `<video controls muted preload="metadata">` tag — reviewers scrub inline without leaving the PR.

**Skip `bun run journeys` for docs-only PRs** — evidence is wasted minutes and Anthropic-key cost.

The runner is idempotent: re-running replaces the marker block, doesn't append. The upload-evidence claim-comment is auto-deleted post-body-update so the conversation tab stays clean.

---

## 3. The task loop — reviewer's view

When a PR lands in your queue:

### 3.1. Read the body top-down

1. **Summary** — one sentence: does the change description match what a user would see?
2. **Acceptance criteria** — checkbox state. Any unchecked box is a discussion item.
3. **Blast Radius Report** — does the verdict match the diff? Verdicts of *risk found NOT mitigated* are blockers.
4. **Test plan** — every box should be checked or have a comment explaining why not.

### 3.2. Scrub the inline videos

The 4-column table is your fastest validation tool:

- **Baseline section**: every row should be ✅. A failed baseline journey on an unrelated PR is suspicious — flag it.
- **Task evidence section**: scrub the per-PR demo video. Does the recording show the feature behaving the way the description claims?
  - Light/dark theme PR → video should show the toggle flipping.
  - New chat affordance PR → video should show the affordance triggering and the canvas updating.
  - Comment workflow PR → video should show comment-leave → promote → agent-act.

The screenshot column is the "where it ended up" snapshot; the video column is the "how it got there" recording. Both are inline — no clicking out, no downloads.

### 3.3. Read the commits in order

Commits in this repo are coarse-grained, themed units. Read them in chronological order:

```sh
gh pr view <N> --json commits --jq '.commits[] | "\(.oid[0:7]) \(.messageHeadline)"'
```

Each commit message body explains the *why*. If a commit's *what* doesn't match its *why*, that's a review comment.

### 3.4. Spot-check the diff

Don't try to read every line. Focus on:
- Files touched outside the PR's stated scope
- New dependencies in `package.json`
- Test files that got *weakened* (assertion removed, `test.skip`, broader regex)
- Anything in `.claude/skills/` or `web/tests/e2e/journeys/` (workflow contracts)

### 3.5. Pull the branch (if needed)

For non-trivial PRs:

```sh
gh pr checkout <N>
bun run dev                  # in another terminal
bun run test:journeys        # journey suite without the upload step
```

Run `bun run test:journeys` (or `bun run journeys -- --no-upload`) locally to reproduce the evidence. If the suite goes red on your machine when the PR body shows it green, surface that — it's a reproducibility issue.

### 3.6. Approve / request changes

A reviewer's job is to approve when the evidence + commits + diff hang together. The pr-evidence pipeline is designed so most validation is **scrubbing the table inline**, not running the suite yourself. Only pull the branch when the inline evidence isn't enough.

---

## 4. When a journey fails — the cuj-guardian protocol

If `bun run journeys` reports a red row, do **not** loosen the assertion. Walk the [`/cuj-guardian`](../.claude/skills/cuj-guardian/SKILL.md) five-step protocol:

1. **Re-run once** — flakes are common; if the second run passes, log it as a flake but don't mute.
2. **Locate the failure surface** — routing / selector / network / assertion-content / timeout.
3. **Diff intersection** — does the PR touch the implicated area? If no, suspect a real product break.
4. **Intent check** — read the PR title + commit messages. Is the change *intentional*? Yes → test is stale. No / unclear → ask the maintainer.
5. **Value check** — if updating the test, the new assertion must be at least as strong as the old. Document the change in [`web/tests/e2e/CUJ_JOURNAL.md`](../web/tests/e2e/CUJ_JOURNAL.md) **in the same commit**.

**Touching a journey spec without a journal entry is a bug.** The journal is what keeps the suite from silently weakening over time.

---

## 5. Release flow

After 1-N PRs merge to main and the batch is releasable:

```sh
GH_TOKEN=$(gh auth token) bun run release
```

This invokes `changelogen --release --push`:

1. Reads commits since the last tag.
2. Picks semver bump: `feat` → minor · `fix` → patch · breaking change → major.
3. Updates [`CHANGELOG.md`](../CHANGELOG.md) and `package.json` version.
4. Creates `chore(release): vX.Y.Z` commit.
5. Tags `vX.Y.Z`, pushes commit + tag.
6. Creates a GitHub release with the changelog excerpt as release notes.

**Hard rule**: only run plain `bun run release`. Don't try to `--help` it; changelogen ignores the flag and proceeds to bump anyway. To inspect the script, read [`package.json`](../package.json) — don't execute.

---

## 6. The journey suite reference

Every PR runs the same 8 baseline journeys (full catalog in [`web/tests/e2e/journeys/README.md`](../web/tests/e2e/journeys/README.md)):

| Journey | Time budget | Agent? |
|---|---|---|
| `home-loads` | ~3s | no |
| `home-shows-demo` | ~5s | no |
| `create-hello-world-banner` | ~10s | no |
| `switch-model` | ~5s | no |
| `agent-edits-canvas` | ~30s | yes (Sonnet) |
| `canvas-variations` | ~60s | yes (Sonnet) |
| `comment-translate` | ~70s | yes (Sonnet ×2 turns) |
| `cleanup-snapshot` | ~3s | no |

Suite total: ~95-200s wall time depending on agent latency. Sonnet is the convention — set in agent specs via `localStorage.setItem("editor-model-id", "claude-sonnet-4-6")`. Don't switch to Opus for evidence runs.

The suite navigates with `?journey-mode=1` so the home grid filters to `demo` + projects whose name starts with `Journey · ` — clean screenshots regardless of contributor's local dev clutter.

---

## 7. When to upgrade a skill to a subagent

We deliberately **don't** have custom subagents in [`.claude/agents/`](../.claude/agents/) yet. Everything fits as a skill + a script. Revisit when **any** of these triggers fires:

1. **Stdout pollution** — a skill's shell command dumps so much noise that the contributor loses the conversation thread.
2. **Parallelism need** — two skills routinely run together independently (e.g. journeys + verify-with-playwright).
3. **PR review traffic** — review-comment triage needs its own context window.

Until then: skills + scripts + hooks. Web consensus and Claude Code's official guidance both say *start with skills, add subagents only when you observe the pain*.

---

## 8. Common gotchas

- **The dev server isn't running** — pre-flight checks fail; start `bun run dev` and retry.
- **Chromium profile expired** — uploads return 401; re-run `bun run setup:attach`.
- **`gh pr edit` fails with "Projects (classic) is being deprecated"** — handled by the runner (uses `gh api -X PATCH /pulls/<N>` directly).
- **Same-stripped-basename URL collision** — handled by the runner (artifacts named `<id>-screenshot.png` / `<id>-video.webm`).
- **Project leak after a journey timeout** — the cleanup-snapshot journey scans for `Journey · *` and force-deletes; cleanup is idempotent.
- **HMR cache stale after a UI change** — touch the file or restart `bun run dev` if a Playwright run sees pre-change source.
- **`bun run release --help` is destructive** — never run it; just call `bun run release` plain.

---

## 9. See also

- [`.claude/skills/README.md`](../.claude/skills/README.md) — skill registry, subagent triggers, project conventions
- [`.claude/skills/ship-task/SKILL.md`](../.claude/skills/ship-task/SKILL.md) — the orchestrator, step by step
- [`.claude/skills/pr-evidence/SKILL.md`](../.claude/skills/pr-evidence/SKILL.md) — runner contract, `--task` authoring
- [`.claude/skills/cuj-guardian/SKILL.md`](../.claude/skills/cuj-guardian/SKILL.md) — triage protocol, anti-patterns
- [`web/tests/e2e/journeys/README.md`](../web/tests/e2e/journeys/README.md) — journey catalog + selector hierarchy
- [`web/tests/e2e/CUJ_JOURNAL.md`](../web/tests/e2e/CUJ_JOURNAL.md) — append-only log of journey assertion changes
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — repo-wide conventions, security model, what's not accepted

---

_Last updated for `v0.1.7`. When the workflow changes (new skill, new step, retired step), update this file in the same PR that ships the change._
