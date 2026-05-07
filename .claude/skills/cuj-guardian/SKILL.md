---
name: cuj-guardian
description: Run and triage AI Atelie's Critical User Journey (CUJ) for every PR — the single end-to-end test that proves a user can open the app, create a project, drive the Claude Code agent, and see the canvas render. Before running, gate by inspecting the PR diff for changes that plausibly affect the journey (routes, onboarding, canvas, chat, selectors). On failure, walk a five-step triage to decide "broken feature" vs "stale test" before touching either. Use whenever the user says "run the CUJ", "validate the canonical flow", "ship-readiness check", or before approving any PR.
---

# cuj-guardian

A contributor workflow for AI Atelie. The CUJ ("Critical User Journey") is now a **suite of focused journeys**, not one big spec — the same contract, split into pieces so a slow agent doesn't kill the cleanup phase or block evidence on the PR.

This skill is **dev-time only**. It does not load into adapter sessions spawned by the editor.

## What the suite proves

Four journeys under `web/tests/e2e/journeys/`. Together they prove the product still does its core job:

1. `home-loads.spec.ts` — home renders, the create-project form is visible + interactive.
2. `create-project.spec.ts` — name + Create lands on `/editor` with a valid `p_*` id; project dir exists on disk; iframe canvas mounts.
3. `agent-edits-canvas.spec.ts` — the load-bearing one. A real Claude Code agent (or whichever adapter is selected) takes a chat prompt, writes to disk, and the iframe paints the requested change.
4. `cleanup-snapshot.spec.ts` — leak guard: any project named `Journey · *` is force-deleted; suite ends with the project list it started with.

If any of these fails, the product is broken in a way users will notice. That's the contract; everything else (`smoke.spec.ts`, type-check, build) is cheap-pre-flight stuff.

## Cleanup safety guarantee

The CUJ creates exactly one test project (under a fresh `p_*` id assigned by the New Project flow), works against it, and deletes it via `DELETE /api/projects/<id>` in a `finally{}` block — even on failure. The test enforces the safety property explicitly:

1. **Snapshot before**: lists `web/projects/` at the start, sorted.
2. **Delta assertion at step 4**: the captured `projectId` must NOT appear in the pre-test snapshot. If it does, we somehow latched onto an existing project's id (serious bug); fail loud.
3. **Cleanup at step 10**: deletes by EXACT id, single-target API call, no wildcards.
4. **Snapshot after at step 11**: post-test `web/projects/` list MUST equal the pre-test list. If anything was leaked OR anything else disappeared, the test fails.

So **any project the contributor had before the test is safe.** The same machine can have arbitrary `p_*` projects of personal work and the CUJ run will only ever touch the one it itself created. If a future change to the CUJ ever violates this property, the snapshot-diff assertion in step 11 fails the test loudly — which is the correct behavior.

The journal of every change to the CUJ lives at `web/tests/e2e/CUJ_JOURNAL.md`. **Touching the spec without touching the journal is a bug.**

## When to invoke

- Before approving any PR — every PR.
- After merging anything to `main`, as a tripwire.
- When the user says "run the CUJ", "ship-readiness check", "validate the canonical flow", "did we break the agent loop?".

Skip when:
- The PR is docs-only with zero `web/`, `api/`, `mcp/`, `skills/`, or `.claude/skills/` changes (cheap to confirm with the pre-flight grep below).
- A previous CUJ run on the same branch SHA already passed (record it once per SHA, don't re-run).

## Hard preconditions

- `bun run dev` is up on `localhost:5173` (do NOT spawn from the skill — leaked dev servers clobber the user's terminal).
- `claude` CLI is on `PATH` and authenticated (`claude --version` succeeds).
- Network access for the agent's API call.
- `web/projects/` snapshot taken (`ls web/projects > /tmp/projects-before.txt`) so cleanup can be diffed afterwards.

If any precondition fails, **STOP** and tell the user what's missing.

## Pre-flight: validate before running (~5 sec)

Before spending 5+ minutes on the CUJ, ask: "does this PR's diff plausibly invalidate the canonical flow, or is the test still valid as written?" Run these two greps:

```bash
# Did the PR touch journey-relevant surface area?
git diff --name-only origin/main...HEAD | grep -E \
  '(^web/src/(routes|pages|app)/|/(onboarding|canvas|chat|editor)/|^web/tests/e2e/cuj|^playwright\.config|^api/src/(routes/projects|services/claude)|^web/package\.json|^web/vite\.config)'

# Did selectors change in journey files?
git diff origin/main...HEAD -- 'web/src/**/*.{ts,tsx}' \
  | grep -E '^\-.*(data-testid|aria-label|role=|getByRole|getByText|placeholder=)'
```

Decision:

| File grep | Selector grep | Action |
|---|---|---|
| empty | empty | Run CUJ as-is. Expect green. On failure, suspect a real product break. |
| hits | empty | Run CUJ. On failure, suspect a real product break first. |
| empty | hits | Run CUJ. On failure, *expect* the test needs a selector update. Reserve time to edit + journal. |
| hits | hits | Run CUJ. Either failure mode is plausible; lean toward "the feature changed the flow on purpose". |

Output a one-paragraph pre-flight report stating which row applies and what you're about to do, then run the test.

## Running the CUJ

```bash
bun run test:journeys
```

Wall time: typically 4–6 minutes. Agent latency dominates; the harness loop itself is deterministic.

While running:
- Watch the terminal for the polling output ("poll #N — files: ...").
- If a poll reports the same file list 30+ times in a row (~4 min) without progress, the agent is likely stuck on a model error or auth issue — abort and surface the dev server log.

Artifacts on success or failure (Playwright auto-captures):
- `test-results/<test>/video.webm`
- `test-results/<test>/trace.zip` (only on failure)
- `test-results/<test>/*.png` (screenshots; only on failure)

## Triage protocol — when CUJ fails

Walk these five steps **in order**, stop at the first match. Do NOT weaken or skip any assertion until the protocol identifies "stale test".

### Step 1 — Re-run once
Failures from the agent or network are common. Re-run `bun run test:journeys` once. If the second run passes and the diff between the two runs is the agent's wording (which it always is), call it **flaky** and file an issue describing the flake — but do not mute the test.

### Step 2 — Locate the failing assertion
Read the failure line + the failure screenshot. Classify the failure surface as one of:
- `routing` — unexpected URL, no navigation
- `selector/aria` — element not found, role mismatch, button renamed
- `network/agent-call` — the agent never produced files / the chat submit never reached the API
- `assertion-content` — the agent produced files but the content doesn't match (wrong color, no "Hello World")
- `timeout` — polling exceeded its deadline

### Step 3 — Diff intersection
Run the pre-flight greps from above. Does the PR's diff touch the file or selector area implicated by the failure surface?

- **No** → likely a **broken feature**. Stop here and surface the regression to the user with the artifact paths. Do not edit the test.
- **Yes** → proceed to Step 4.

### Step 4 — Intent check
Read the PR title, body, and top commit message. Does the change *intend* to alter the journey (e.g., "add onboarding modal", "rename the New project button to + Create")?

- **Yes, intentional** → the test is **stale**. Proceed to Step 5 to update it.
- **Unclear / no explicit intent** → ask the maintainer in the PR comment thread before changing anything. Do not silently update.

### Step 5 — Value check before updating
Before rewriting an assertion, ask: *"After this edit, would the test still fail if the feature regressed?"*

If the proposed new assertion is **weaker** than the old (asserting only that an element *exists* rather than *contains the expected content*), reject the edit and escalate to the maintainer. This is the guardrail against the *Liar* and *Secret Catcher* anti-patterns — see https://blog.codepipes.com/testing/software-testing-antipatterns.html .

If the new assertion is at least as strong, apply it AND record it in `CUJ_JOURNAL.md` in the same commit.

## Updating the test (rules)

When Step 5 says "go":

1. **Selectors**: prefer role+name (`getByRole('button', { name: /create/i })`) or `data-testid` over text-only matches. Update the journal as `repaired-selector` if no semantic change, `evolved` if a real new step.
2. **Assertions**: never weaken without a replacement of equal strength. If a step is genuinely no longer applicable, remove it AND add a new strong assertion that catches the new behaviour the feature introduced.
3. **No `test.skip` or `test.only`.** Ever. If the test is broken in a way you can't fix in this PR, escalate to the maintainer; don't paper over it.
4. **No `expect(true).toBe(true)`** or empty asserts. The agent must refuse this even if the test would otherwise be flagged as broken.
5. **Update journal in the same commit.** A spec change without a journal entry is a bug. The pre-commit ritual: `git diff --staged web/tests/e2e/journeys/ CUJ_JOURNAL.md` — both must be non-empty.

## Anti-patterns the agent must refuse

- **Liar**: a test that runs but asserts nothing meaningful (e.g. only `await page.goto('/')` then exits). Refuse.
- **Secret Catcher**: a test that catches all exceptions silently. Refuse.
- **Dodger**: a test that asserts side effects only (logs, network calls) but never the user-visible outcome. Refuse.
- **Mute-on-flaky**: adding `test.skip` or `--grep-invert <test name>` to make CI green. Refuse.
- **Assertion stuffing / reward hacking**: copying assertion strings from product source into the test (so it always passes by tautology). Refuse and surface — see https://metr.org/blog/2025-06-05-recent-reward-hacking/ .
- **Loosening without replacement**: see Step 5.

## Self-check before commit

Before writing the commit message, the agent must verify:

- [ ] `bun run test:journeys` passed locally on the current SHA (post-edit if any).
- [ ] `web/tests/e2e/CUJ_JOURNAL.md` has a new entry dated today with the PR number.
- [ ] No `.skip`, `.only`, or empty `expect(...)` in the staged diff.
- [ ] If selectors changed: the new selector is role+name or `data-testid`, not text-only.
- [ ] PR body comment summarizes what user-visible behaviour the (possibly new) test now proves.

If any check fails, do NOT commit — fix or escalate.

## Escalation triggers

Stop and ask the maintainer rather than auto-edit when:

- Triage Step 4 returns "intent unclear".
- Triage Step 5 says the proposed edit weakens the assertion.
- Two consecutive runs fail in the same surface area (suggests a deeper issue than a stale selector).
- The agent produced *no files at all* during the chat step (suggests adapter / auth / network issue, not test code).

## See also

- `web/tests/e2e/journeys/` — the test itself.
- `web/tests/e2e/CUJ_JOURNAL.md` — the change log.
- `.claude/skills/verify-with-playwright/SKILL.md` — the smaller per-feature verification skill (writes ad-hoc specs; does not own the journey).
- `.claude/skills/ship-task/SKILL.md` — the orchestrator that runs this skill as part of the PR loop.
- Martin Fowler — *User Journey Test*: https://martinfowler.com/bliki/UserJourneyTest.html
- CloudBees — *Test Impact Analysis*: https://www.cloudbees.com/blog/test-impact-analysis
- Codepipes — *Software Testing Anti-patterns* (Liar, Secret Catcher, Dodger): https://blog.codepipes.com/testing/software-testing-antipatterns.html
- METR — *Recent reward hacking* (assertion stuffing): https://metr.org/blog/2025-06-05-recent-reward-hacking/
