# Contributing to AI Atelie

Thanks for your interest. AI Atelie is a small, opinionated project — contributions are welcome but the bar is "does this make the tool better for someone running it locally?"

## Run it locally

```bash
git clone https://github.com/aiatelie/ai-atelie.git
cd ai-atelie
bun install
bun run dev
```

The dev script boots the Bun API on port 5174 and the Vite SPA on port 5173. Open <http://127.0.0.1:5173>.

You'll need one agent CLI on your `PATH`:
- [Claude Code](https://claude.com/claude-code) (recommended — subscription OAuth, no API key)
- [Kimi CLI](https://github.com/MoonshotAI/Kimi-CLI) (configured with a session)

## High-leverage contributions

These are the areas where a PR is most likely to land:

- **Add a skill.** Drop a new `skills/<your-skill>/SKILL.md` with frontmatter + body, and add an entry to `skills/index.json`. See existing skills for the shape.
- **Add a starter scaffold.** New `mcp/starters/<Component>.jsx` files become available via `copy_starter`. Keep them small and broadly useful.
- **Wire a new agent CLI.** Adapters live under `api/src/agents/<name>/`. The opencode adapter is a good reference.
- **Fix a real bug.** Reproduce locally first; PR with a one-line description of the symptom and the fix.

## Dev-time vs. product-runtime config

The repo intentionally separates two namespaces:

- **`/skills/`** — product skills shipped to end users. Adapters (`api/src/services/claude.ts`, `kimi.ts`, etc.) load them into spawned sessions via `ENV.SKILLS_DIR`. Never auto-loaded into your dev session.
- **`/.claude/`** — dev-time harness config that loads when you open Claude Code in this repo to work *on* AI Atelie. Skills here (`/.claude/skills/`) are contributor workflows, not user features.

If you're adding something for end users, it belongs under `/skills/` with an entry in `skills/index.json`. If you're adding something to make contributing easier, it belongs under `/.claude/skills/`.

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

The repo ships three contributor workflows under `.claude/skills/`. They auto-load when you open Claude Code in this repo:

- **`ship-task`** — orchestrates implement → verify → blast-radius check → commit → PR for any issue or task.
- **`verify-with-playwright`** — drives the dev server with a real browser, captures evidence (`.evidence/<run>/`), attaches it to the PR.
- **`semantic-commit`** — drafts Conventional Commits messages tuned to the workspace scope set above.

Optional but recommended one-time setup so the verify+PR flow works end-to-end:

```bash
bunx playwright install chromium       # ~80MB, one-time
gh extension install Addono/gh-attach  # uploads evidence to PRs
```

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
