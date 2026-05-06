# Contributing to AI Atelie

Thanks for your interest. AI Atelie is a small, opinionated project — contributions are welcome but the bar is "does this make the tool better for someone running it locally?"

## Run it locally

```bash
git clone https://github.com/aiatelie/ai-atelie.git
cd ai-atelie
bun install
bun run dev
```

The dev script boots the Bun API on port 5174 and the Vite SPA on port 5173. Open <http://localhost:5173>.

You'll need one agent CLI on your `PATH`:
- [Claude Code](https://claude.com/claude-code) (recommended — subscription OAuth, no API key)
- [Kimi CLI](https://github.com/MoonshotAI/Kimi-CLI) (configured with a session)

## High-leverage contributions

These are the areas where a PR is most likely to land:

- **Add a product skill.** Drop a new `skills/<your-skill>/SKILL.md` with frontmatter + body, and add an entry to `skills/index.json`. End-user-facing playbook the agent can call mid-conversation. See `skills/README.md`.
- **Add an MCP server.** Drop a new `mcp/<your-server>.mjs` and wire it into the adapter spawn block in `api/src/services/claude.ts`. Exposes a tool to the model (e.g. `ask_user`, `copy_starter`). See `mcp/README.md`.
- **Add a starter scaffold.** New `mcp/starters/<Component>.jsx` files become available via `copy_starter`. Keep them small and broadly useful.
- **Add a dev-time skill.** Drop a new `.claude/skills/<your-skill>/SKILL.md`. Contributor workflow that loads when *you* (not end users) open Claude Code in this repo. See `.claude/skills/README.md`.
- **Wire a new agent CLI.** Adapters live under `api/src/agents/<name>/`. The opencode adapter is a good reference.
- **Fix a real bug.** Reproduce locally first; PR with a one-line description of the symptom and the fix.

## Where does my contribution belong? (decision matrix)

The repo deliberately keeps three namespaces separate. Pick the one that matches *who* uses what you're adding:

| If your contribution is for… | It goes under | Loaded by | Auto-loaded in your dev session? |
|---|---|---|---|
| **End users invoking the editor** — a designer-facing playbook | `/skills/<name>/SKILL.md` | Adapters spawn the agent CLI with `additionalDirectories: [ENV.SKILLS_DIR]` (see `api/src/services/claude.ts`) | ❌ No |
| **End users**, but exposes a *tool call* (not just text) — e.g. file ops, "ask the user" prompts, web fetch | `/mcp/<server>.mjs` + wired in `api/src/services/claude.ts` `mcpServers` | The agent CLI loads it as an MCP server, exposed as `mcp__<server>__<tool>` to the model | ❌ No |
| **Contributors working ON the repo** — workflow you want Claude Code to follow when you ask *it* to ship | `/.claude/skills/<name>/SKILL.md` | Claude Code's native skill auto-discovery when you open the repo | ✅ Yes |
| **Contributors**, but a one-off task script (release, evidence upload, dev-server probes) | `/scripts/<name>.mjs` + a `bun run <name>` entry in `package.json` | You run it manually | n/a |

Mixing these up is the most common review-blocker on this repo. End-user features should never auto-load into a dev session (that's why `/skills/` is *not* symlinked into `.claude/skills/` — see #46). Contributor workflows should never reach end-user adapter sessions (the `additionalDirectories` and `settingSources: []` boundary in `claude.ts` enforces this).

## Bar for merging

- One feature / fix per PR.
- TypeScript or JavaScript that runs cleanly under `bun run dev` — no new lint errors in `web/`.
- New skills / starters: include enough body in the file that an agent can actually use them. Stubs welcome with a `body_status: stub` flag, but the description has to be honest.
- README updated if you change observable behavior.

## Commits and releases

Every commit follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org). The header form is:

```
<type>[scope][!]: <subject>
```

The closed scope set is `api | web | mcp | skills | repo | deps`. See `changelog.config.ts` for the full type taxonomy. The `.claude/skills/semantic-commit/` skill drafts these for you when you ask Claude Code to commit.

Releases use `changelogen` + `bumpp`:

```bash
# Generate the next version's CHANGELOG.md, bump versions, tag, push, publish a GitHub Release:
bun run release

# Or run pieces by hand:
bun run release:manual   # interactive bumpp + regenerate CHANGELOG.md, no push
```

`bun run release` needs `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment to publish the GitHub Release. The simplest path is to be logged in to `gh`:

```bash
gh auth login
export GH_TOKEN=$(gh auth token)
```

## Dev-time skills

The repo ships four contributor workflows under `.claude/skills/`. They auto-load when you open Claude Code in this repo:

- **`ship-task`** — orchestrates implement → verify → blast-radius check → commit → PR for any issue or task.
- **`verify-with-playwright`** — drives the dev server with a real browser, captures evidence (`.evidence/<run>/`), attaches it to the PR.
- **`cuj-guardian`** — runs and triages the Critical User Journey (the single end-to-end test that proves the agent loop still works). Gates by inspecting the PR diff first; on failure walks a five-step triage to decide "broken feature" vs "stale test" before touching either.
- **`semantic-commit`** — drafts Conventional Commits messages tuned to the workspace scope set above.

Optional but recommended one-time setup so the verify+PR flow works end-to-end:

```bash
bunx playwright install chromium     # ~80MB, one-time — for the verify-with-playwright skill
bun run setup:attach                 # one-time — opens Chromium so you can log into github.com once
```

`setup:attach` saves your GitHub browser session inside a Chromium persistent profile at `~/.local/state/aiatelie/chromium-profile/` (per-user, outside the repo, never committed). After that, `bun run upload:evidence <owner/repo/pull/N> <file1> [file2] ...` uploads evidence headless to GitHub's `user-attachments` CDN — videos auto-play inline, images embed natively, no `releases/download/...` download links. Re-run `setup:attach` every few weeks (or when uploads start 401-ing) to refresh the session. We do this instead of using `gh-attach` because the user-attachments upload endpoint is cookie-only — no PAT or `gh auth token` works against it as of May 2026.

### Security model — where credentials live

We don't write any plaintext cookie or token file anywhere. Specifically:

- The only sensitive artifact is the **Chromium persistent profile** at `~/.local/state/aiatelie/chromium-profile/` — a mode-`0700` directory containing Chromium's own (binary) cookies DB. Playwright reads it back via `launchPersistentContext` to drive uploads headless.
- Path is in `$HOME`, never inside the repo. `.gitignore` also excludes `chromium-profile/` and `*-cookies.txt` patterns as defense-in-depth in case the helper is ever pointed at a path inside the repo.
- No env var, no `.env.local`, no flat cookie file is required (or written). If a contributor wants their own additional secrets in `.env.local` for unrelated reasons, that's gitignored too (`.env*` rule with `!.env.example` exception), but nothing in this workflow needs it.
- To nuke the session at any time: `rm -rf ~/.local/state/aiatelie/chromium-profile/`. Re-run `bun run setup:attach`.
- `bun run release` does need `GH_TOKEN` in the environment (see "Commits and releases" above), but that token comes from `gh auth token` on demand — it isn't persisted anywhere either.

A rule of thumb: **if you ever see a step in the docs that asks you to copy a cookie value into a file, paste it into a command, or commit it anywhere — it's a regression.** The setup is designed so the cookie value is never visible as text outside of Chromium's own storage.

## The Critical User Journey (CUJ)

`web/tests/e2e/cuj.spec.ts` is the single end-to-end test that proves AI Atelie's core promise: a user opens the app, creates a project, the agent designs into it, the canvas renders. It takes ~5 minutes (agent latency), so it's tagged `@cuj` and gated behind a separate npm script:

```bash
bun run test:e2e   # everything EXCEPT the CUJ — fast, run as often as you like
bun run test:cuj   # ONLY the CUJ — run before approving any PR
```

The change log for the CUJ is `web/tests/e2e/CUJ_JOURNAL.md`. **Touching `cuj.spec.ts` without adding a journal entry is a bug.** The `cuj-guardian` skill enforces this and walks the triage protocol on failure.

## What is not accepted

- Re-architecting major systems without prior discussion (open an issue first).
- Pulling in heavy dependencies for things that fit in 100 lines.
- Cosmetic-only refactors that fight the project's style.

## Local quality of life

- `_internal/` is gitignored — use it for personal notes, backups, design scratch you don't want shipped.
- `web/projects/` is gitignored — your own design projects live here.
- Personal asset folders (`bg/`, `content/`, `pages/`, `editor/`) are gitignored too. Feel free to use them locally; they won't be tracked.

## Questions

Open an issue. The maintainer is solo and replies when they can.
