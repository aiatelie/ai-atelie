# Changelog

All notable changes to AI Atelie are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project follows
[Conventional Commits](https://www.conventionalcommits.org).

Version policy while in alpha: minor bumps are reserved for user-visible
features or breaking changes; everything else is patch.


## v0.1.1

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.0...v0.1.1)

### Features

- **web:** Canvas-busy pulse + rotating phrase pill while an agent run is in flight, so a user can tell at a glance which canvas is busy and avoid starting a conflicting chat in parallel. Pill rotates through 24 phrases ("AI is cooking", "Magic in progress", "Sprinkling pixels", "Wrangling the DOM", …) every ~5s, never repeats consecutively. Provider-neutral: works for Claude, Kimi, and OpenCode equally because it watches the existing `lastIsPending` state, not provider-specific deltas. Includes the repo's first unit test (`busyPhrases.test.ts`, 3 tests / 203 expects via `bun test`) ([#53](https://github.com/aiatelie/ai-atelie/pull/53))

### Build

- **web:** Exclude `*.test.ts` from tsc compilation so colocated unit tests using `bun:test` don't break the build ([0398330](https://github.com/aiatelie/ai-atelie/commit/0398330))

### Docs

- **skills:** Make "evidence must show post-completion state" an explicit rule in `verify-with-playwright/SKILL.md` — capture the agent's actual output, not just the in-flight UX. Adds polling pattern, valid completion signals, anti-patterns to refuse ([feede31](https://github.com/aiatelie/ai-atelie/commit/feede31))

### ❤️ Contributors

- Kadu-maverickk <kadumaverick1314@gmail.com>

## v0.1.0

First tagged release. AI Atelie is a local-first, MIT-licensed,
open-source design atelier — an open alternative to Anthropic's Claude
Design. Each design lives as a sandboxed folder of HTML, JSX, and CSS
that you and an agent CLI shape together.

### Features

- **web/** React + Vite SPA with iframe canvas, sandboxed `web/projects/<id>/` folders, three edit paths (tweaks, inspector, bake-to-source) and a bundled demo project.
- **api/** Bun + Hono server with adapters for Claude Code, Kimi K2, and OpenCode CLIs.
- **mcp/** MCP servers: `ask-user`, `starters`, `capabilities`.
- **skills/** Nine product skills shipped to end-user sessions (`frontend-design`, `make-tweakable`, `interactive-prototype`, `create-design-system`, `animated-video`, `save-as-standalone-html`, `send-to-canva`, `handoff-to-claude-code`, `export`).

### Chores

- **repo:** Separate dev-time `.claude/` from product `/skills/` ([#46](https://github.com/aiatelie/ai-atelie/issues/46))
