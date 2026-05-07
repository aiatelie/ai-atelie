# .claude/skills/ — **dev-time contributor workflows**

Markdown playbooks Claude Code auto-loads when you (the contributor) open this repo in Claude Code. NOT shipped to end users — these are the workflows for working ON AI Atelie, not for designing inside it.

> **Looking for end-user product skills?** Those live at `/skills/` and are loaded into adapter-spawned editor sessions via `ENV.SKILLS_DIR`, not into your dev session. See [`/skills/README.md`](../../skills/README.md). The split is documented in `CONTRIBUTING.md#where-does-my-contribution-belong-decision-matrix`.

## What's in here today

- **`ship-task/`** — orchestrator. Take a task → understand → implement → verify → blast-radius regression check → semantic commit → PR with evidence.
- **`verify-with-playwright/`** — drives the dev server with a real browser, captures screenshots/video, hands them to `bun run upload:evidence`.
- **`cuj-guardian/`** — runs and triages the journey suite under `web/tests/e2e/journeys/`. Pre-flight gate by diff inspection; five-step triage protocol on failure.
- **`pr-evidence/`** — wraps `bun run journeys` (8 baseline journeys + optional `--task <spec>`) and rewrites the inline-evidence block in the current PR's body.
- **`semantic-commit/`** — drafts Conventional Commits messages tuned to the workspace scope set (`api | web | mcp | skills | repo | deps`).

## Adding a dev-time skill

Drop a new `.claude/skills/<name>/SKILL.md` with **standard** frontmatter only — no repo-specific fields. This keeps dev skills portable; if Anthropic ever publishes a marketplace, they'll pass validation as-is.

```yaml
---
name: my-skill
description: One-line trigger Claude matches against. State explicit trigger phrases the user might say, since skills under-fire by default. Cap at 1024 chars.
---

# My skill

One paragraph defining what the skill does and when to use it.

## When to invoke
- Trigger phrases…
- Anti-triggers (when NOT to use)…

## Workflow
A literal markdown checklist Claude pastes into its reply and ticks as it goes. Required for any multi-step skill — the checklist is the artifact that makes the steps visible and skippable-with-justification.

## Hard preconditions
What must be true before this skill can run. STOP and tell the user if any precondition fails — don't paper over.

## Anti-patterns
What the skill must REFUSE even if the user asks. (e.g. weakening test assertions, force-pushing main, skipping verification.)

## See also
Cross-links to sibling skills, scripts, or doc files.
```

Skill bodies should:

- **Lead with a checklist.** Claude pastes-and-ticks; that's the lever.
- **Include hard STOP conditions.** Skills can't programmatically invoke each other — Claude coordinates. So if a sibling skill is needed, the body must explicitly say "if X is not loaded, STOP and tell the user."
- **Refuse anti-patterns by name.** Don't trust the model to remember what's off-limits across long sessions.
- **Cite the WHY, not just the WHAT.** Code comments rot; SKILL.md prose rots slower if it explains intent.

After authoring: open Claude Code in the repo and type `/`-something or ask a question that should trigger your skill. If the skill description doesn't fire, pad the description with more trigger phrases — skill discovery in 2026 still under-fires more than it over-fires.

## When to upgrade a skill to a subagent

Skills run inline in the contributor's conversation; subagents
(`.claude/agents/<name>.md`) run in their own context window with
their own tool restrictions and return only a summary. Subagents
earn their place when the work is **isolated, parallelizable, or
context-polluting**.

Today everything fits as a skill. Revisit when **any** of these
triggers fires:

1. **Stdout pollution.** A skill's shelled-out tool dumps so much
   noise (long Playwright runs, verbose CI logs, full agent stream
   replays) that the contributor loses track of the conversation.
   Move it to a subagent so the noise stays in the side process and
   only a clean summary returns.
2. **Parallelism need.** Two skills routinely run together
   independently (e.g. running the journey suite *while* doing a
   `verify-with-playwright` per-task spec). A subagent unlocks
   `Promise.all`-shape concurrency since each gets its own context.
3. **PR review traffic.** Once the repo gets active reviewers,
   triaging review comments needs its own context window —
   classifying nits vs. blockers, drafting follow-ups — without
   contaminating the implementation context. That's the moment for
   a `pr-reviewer` subagent.

Until then: skills + scripts + hooks. Web consensus and Claude
Code's official guidance both say *start with skills, add subagents
when you observe the pain.*

## Cross-references

- **`scripts/`** at the repo root — non-skill helpers a skill body can shell out to (`bun run setup:attach`, `bun run upload:evidence`, `bun run journeys`, `bun run release`). Add scripts here when you need persistent automation; reference them from skill bodies when a skill should call them.
- **`web/tests/e2e/journeys/`** — the journey suite (`home-loads`, `home-shows-demo`, `create-hello-world-banner`, `switch-model`, `agent-edits-canvas`, `canvas-variations`, `comment-translate`, `cleanup-snapshot`). The `cuj-guardian` skill owns the suite's lifecycle.
- **`web/tests/e2e/CUJ_JOURNAL.md`** — append-only journal of every change to a journey. Required reading before modifying any spec.

## Where this should NOT go

- **End-user features** (the agent does X for designers) → `/skills/`, not here. Auto-loading dev skills into end-user sessions would leak contributor workflow into the product.
- **Tool servers** (MCP `tools/call` endpoints) → `/mcp/`, not here. Skills are pure markdown.
- **One-off scripts** (cron, release, port probes) → `/scripts/`, not here. If you're calling Bun/Node directly, it's a script.

## Why the strict split

The repo had a tracked symlink at `.claude/skills -> ../skills` that auto-loaded product skills into contributor dev sessions. Removed in #46 along with `settingSources: []` in `api/src/services/claude.ts` so the adapter never picks up dev-time skills either. The boundary is enforced by code (claude.ts), gitignore (negation rules so `.claude/skills/` tracks but `.claude/settings.local.json` doesn't), and convention (this README).
