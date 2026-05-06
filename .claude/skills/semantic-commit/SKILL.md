---
name: semantic-commit
description: Draft a Conventional Commits 1.0.0 message for the AI Atelie repo. Use whenever the user asks to commit, or after staging changes in this repo. Enforces the closed scope set (api|web|mcp|skills|repo|deps), imperative subjects, and a body that reads well in the auto-generated CHANGELOG.md (changelogen + bumpp pipeline).
---

# semantic-commit

A contributor workflow for AI Atelie. Drafts a [Conventional Commits 1.0.0](https://www.conventionalcommits.org) message tailored to this repo's release pipeline (`bun run release`, powered by `changelogen` reading `changelog.config.ts`).

This skill is **dev-time only**. It does not load into adapter sessions spawned by the editor.

## When to invoke

- Before any `git commit` in this repo.
- After staging changes if the user asks "commit this" / "ship it" / "make a commit".
- When asked to amend the message of the most recent commit.

Do NOT invoke in unrelated repos — the scope set is specific to AI Atelie's workspace layout.

## Workflow (paste this checklist into your reply and tick as you go)

- [ ] Read `git status` and `git diff --staged` (or unstaged if nothing is staged).
- [ ] Classify the change against the type taxonomy below.
- [ ] Pick the correct scope from the closed set.
- [ ] Draft the header (≤72 chars, imperative, lowercase after colon, no period).
- [ ] Draft the body if the change is user-visible or non-obvious. Wrap at 72.
- [ ] Add footers (`Closes #N`, `Refs #N`, `BREAKING CHANGE:`, `Co-Authored-By:`).
- [ ] Show the full message to the user.
- [ ] On confirm, create the commit using a HEREDOC.

## Type taxonomy

The full set in `changelog.config.ts`. The three semver-bumping types come first because they're the ones that move version numbers.

| Type | Use when | Bumps |
|---|---|---|
| `feat` | New user-visible capability or surface | minor |
| `fix` | Corrects broken behaviour | patch |
| `perf` | Faster / lighter without behaviour change | patch |
| `refactor` | Internal restructuring, no behaviour change | patch |
| `docs` | README, CONTRIBUTING, code comments | patch |
| `chore` | Repo plumbing that isn't `build`/`ci`/`docs` | — |
| `test` | Adding or fixing tests | — |
| `build` | Build system or dependency tooling | — |
| `ci` | GitHub Actions, automation | — |
| `style` | Whitespace, formatting only | — |
| `revert` | Reverts a prior commit (include `Refs:`) | — |

## Scope rules

The closed set, mirrored in `changelog.config.ts`:

| Scope | Covers |
|---|---|
| `api` | `api/` workspace |
| `web` | `web/` workspace |
| `mcp` | `mcp/` workspace |
| `skills` | `skills/` (product skills) AND `.claude/skills/` (dev skills) — the diff makes which obvious |
| `repo` | Root configs, workspaces, tsconfig, gitignore, CONTRIBUTING |
| `deps` | Dependency-only commits (lockfile / package.json bumps with no other change) |

If a change touches two scopes, **prefer splitting the commit**. If it's truly atomic across scopes (e.g. a renamed export), omit the scope rather than guess.

## Header rules

`<type>[scope][!]: <subject>`

- `<= 72` characters total.
- Subject is **imperative** ("add live preview", not "added" or "adds").
- Lowercase after the colon, no trailing period.
- `!` before `:` for breaking changes (also requires a `BREAKING CHANGE:` footer with migration recipe).
- No issue refs in the header — they live in footers.

## Body rules

Required when:

- The change is user-visible (a feature, a fix that affects behaviour).
- The change is non-obvious from the diff (architectural, security, perf rationale).

Optional but encouraged when:

- The commit closes an issue — quote the acceptance criteria.
- There's a "before/after" worth showing.

Format:

- Wrap at 72 characters.
- One blank line between header and body, and between paragraphs.
- Lead with **why**, not what (the diff already says what).
- Bullet lists are allowed when listing multiple sub-changes.

## Footer rules

- `Closes #N` for issues this commit fully resolves.
- `Refs #N` for issues this commit relates to but doesn't close.
- `BREAKING CHANGE: <description>` when introducing breaking change. Include a one-paragraph migration recipe.
- `Co-Authored-By: Claude <model> <noreply@anthropic.com>` on every commit Claude writes (required by repo convention). The Claude Code harness auto-injects the current model identifier — don't override it with a frozen version copy-pasted from this skill's examples.

## Examples

### Good — a feature

```
feat(web): inline mid-stream live preview into iframe srcdoc

Streams agent text deltas straight into the iframe's srcdoc as they
arrive, so the user sees the design forming in real time instead of
waiting for the agent to finish writing the file. Best ratio in the
backlog (~30 LOC) for a flagship visible win.

Closes #1

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### Good — a breaking change

```
feat(api)!: drop Node 18 support; require Bun >= 1.2

Bun 1.2 ships native MessageChannel which the SSE bridge now uses.
Node 18 is EOL April 2025 and the workaround code added 80 LOC of
shim that nobody runs in production.

BREAKING CHANGE: Node 18 is no longer supported. Upgrade to Bun >= 1.2
(recommended) or Node >= 20. The standalone-Node code path is removed
from `api/src/services/sseBridge.ts`.

Refs #99

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### Good — a chore

```
chore(repo): separate dev-time .claude from product /skills (#46)

[body explaining motivation in 2-3 paragraphs]

Closes #46

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### Bad — past tense, vague

```
chore: updated some stuff
```

Why bad: past tense, no scope, no body, no detail — produces a
useless changelog line.

### Bad — mixed scopes, no body, header too long

```
feat(api,web): add new feature for previewing designs and also wire it through the API endpoint
```

Why bad: comma-separated scope is invalid; header > 72 chars;
mixing api and web in one commit makes the changelog list ambiguous.

## Common mistakes

- **Past tense subjects.** "added", "fixed", "updated" — always imperative present tense.
- **Vague subjects.** "update stuff", "small fix" — name what changed and why anyone cares.
- **Mixed scopes.** Split the commit instead.
- **Missing body on breaking change.** A `!` or `BREAKING CHANGE:` without a migration recipe is a trap for users.
- **Issue refs in the header.** Move to footers (`Closes #N`).
- **Missing `Co-Authored-By:`.** Required on every Claude-written commit.
- **Skipping `bunx changelogen --no-bump --output CHANGELOG.md` to preview** when the commit is the cap of a release branch and you want to see the entry it produces.

## Tradeoffs (so you can warn the user when relevant)

- Each commit takes ~30s longer to draft.
- "wip" / "fix typo" exploratory commits become friction. Mitigation: use `git commit --fixup` during exploration, then squash before merging.
- The closed scope set will feel restrictive when adding a new workspace. Update `changelog.config.ts` first, then commit.
- This skill is the lint layer — there is no `commitlint` / `husky` enforcing it on push. A tired-Friday commit can still corrupt the next changelog section. Cost of recovery: one manual edit to `CHANGELOG.md` at release time.

## See also

- `changelog.config.ts` at repo root — the canonical type and scope map.
- `CONTRIBUTING.md#commits-and-releases` — the contributor-facing summary.
- `bun run release` — what consumes these commits to produce `CHANGELOG.md` and a GitHub Release.
