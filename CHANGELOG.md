# Changelog

All notable changes to AI Atelie are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project follows
[Conventional Commits](https://www.conventionalcommits.org).

Version policy while in alpha: minor bumps are reserved for user-visible
features or breaking changes; everything else is patch.


## v0.2.0

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.8...v0.2.0)

### Features

- **web:** Composer polish — /compress, @-file mentions, text-file drops ([#87](https://github.com/aiatelie/ai-atelie/pull/87))
- Design intelligence — per-project skill selection + DESIGN.md ([#88](https://github.com/aiatelie/ai-atelie/pull/88))
- **repo:** Add OpenCode compatibility layer ([#94](https://github.com/aiatelie/ai-atelie/pull/94))
- **api,web:** Fork projects — one-click remix with origin tracking ([374ea8e](https://github.com/aiatelie/ai-atelie/commit/374ea8e))
- **web:** Add project search and sort to home page ([f910185](https://github.com/aiatelie/ai-atelie/commit/f910185))
- Window.ai.complete() — provider-neutral artifact AI calls ([#104](https://github.com/aiatelie/ai-atelie/pull/104))
- ⚠️  Rewrite OGraf export pipeline for DaVinci Resolve 21 ([#108](https://github.com/aiatelie/ai-atelie/pull/108))
- **chat:** Event-sourced canonical log, Codex app-server, live reasoning + plan UX ([fca1e3c](https://github.com/aiatelie/ai-atelie/commit/fca1e3c))

### Bug Fixes

- Harden communication layer, shutdown safety, and storage integrity ([#95](https://github.com/aiatelie/ai-atelie/pull/95))
- **docs:** Restore hero.png image in bilingual README ([493158f](https://github.com/aiatelie/ai-atelie/commit/493158f))
- **web:** Unify chrome on design tokens; fix theme + state gaps ([abd1e36](https://github.com/aiatelie/ai-atelie/commit/abd1e36))
- **web:** Keep dark-pill/brand text legible in dark themes ([ca921cc](https://github.com/aiatelie/ai-atelie/commit/ca921cc))
- **web:** Legible on-brand text on light-brand themes ([2951eaf](https://github.com/aiatelie/ai-atelie/commit/2951eaf))
- **web:** Raise secondary UI to WCAG AA across themes ([8627626](https://github.com/aiatelie/ai-atelie/commit/8627626))

### Docs

- **repo:** Add the canonical contributor workflow doc ([#86](https://github.com/aiatelie/ai-atelie/pull/86))
- **repo:** Add bilingual Chinese/English README and CONTRIBUTING ([#107](https://github.com/aiatelie/ai-atelie/pull/107))

### Chores

- **repo:** Support PLAYWRIGHT_BASE_URL env var in playwright.config ([c2f6925](https://github.com/aiatelie/ai-atelie/commit/c2f6925))

### Style

- **web:** Polish home page search/sort/remix UI to match app aesthetic ([dc0eca5](https://github.com/aiatelie/ai-atelie/commit/dc0eca5))

#### ⚠️ Breaking Changes

- ⚠️  Rewrite OGraf export pipeline for DaVinci Resolve 21 ([#108](https://github.com/aiatelie/ai-atelie/pull/108))

### ❤️ Contributors

- Kadu-maverickk <kadumaverick1314@gmail.com>
- Kadu Maverick ([@whatiskadudoing](https://github.com/whatiskadudoing))
- Ai-atelie-bot

## v0.1.8

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.7...v0.1.8)

### Bug Fixes

- **web:** Smart-label element identity across selection surfaces ([#82](https://github.com/aiatelie/ai-atelie/pull/82))
- **web:** Overlay tracks transform-driven canvas motion ([#83](https://github.com/aiatelie/ai-atelie/pull/83))
- **api,web:** Chat stream survives full page reload ([#84](https://github.com/aiatelie/ai-atelie/pull/84))
- **repo:** Restore playwright-tools/ scripts so export endpoints work ([#85](https://github.com/aiatelie/ai-atelie/pull/85))

### ❤️ Contributors

- Kadu Maverick ([@whatiskadudoing](https://github.com/whatiskadudoing))

## v0.1.7

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.6...v0.1.7)

### Features

- **web:** Polish-pass II — primitives, microinteractions, and reliability ([#79](https://github.com/aiatelie/ai-atelie/pull/79))
- **web:** Theme + design axes with 12 palettes ([#80](https://github.com/aiatelie/ai-atelie/pull/80))
- **repo:** Journey suite — split CUJ + inline-evidence pipeline ([#81](https://github.com/aiatelie/ai-atelie/pull/81))

### ❤️ Contributors

- Kadu Maverick ([@whatiskadudoing](https://github.com/whatiskadudoing))

## v0.1.6

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.5...v0.1.6)

### Features

- **web:** Home redesign — atelier rulebook + 3-column shell + editor polish ([#78](https://github.com/aiatelie/ai-atelie/pull/78))

### Bug Fixes

- **web:** Unclip ProjectSwitcher menu, restore Projects back link, refresh deps ([#68](https://github.com/aiatelie/ai-atelie/pull/68))

### ❤️ Contributors

- Kadu Maverick ([@whatiskadudoing](https://github.com/whatiskadudoing))

## v0.1.5

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.4...v0.1.5)

### Features

- **api:** AppendLog impl + close CUJ race + migrate editor-overrides/drawings to .meta/ ([#66](https://github.com/aiatelie/ai-atelie/pull/66))
- **web:** Iframe runtime-error overlay ([#37](https://github.com/aiatelie/ai-atelie/pull/37), [#60](https://github.com/aiatelie/ai-atelie/pull/60))
- **web:** Tab strip UX — kind icons, dirty mark, wheel scroll, drag-reorder, IDE menu ([#34](https://github.com/aiatelie/ai-atelie/pull/34), [#67](https://github.com/aiatelie/ai-atelie/pull/67))

### ❤️ Contributors

- Kadu Maverick ([@whatiskadudoing](https://github.com/whatiskadudoing))

## v0.1.4

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.3...v0.1.4)

### Features

- **api:** Introduce storage driver + close #11 disk-backed snapshots, #55 fresh-browser project list ([#57](https://github.com/aiatelie/ai-atelie/pull/57), [#11](https://github.com/aiatelie/ai-atelie/issues/11), [#55](https://github.com/aiatelie/ai-atelie/issues/55))
- **web:** Jump-to-latest pill in chat body ([#61](https://github.com/aiatelie/ai-atelie/pull/61))
- **web:** Keyboard shortcuts cheat sheet (Cmd+/) — phase A of #44 ([#62](https://github.com/aiatelie/ai-atelie/pull/62), [#44](https://github.com/aiatelie/ai-atelie/issues/44))
- **web:** Persist folder-collapse state in FileBrowserView per project (#40 Phase 1) ([#63](https://github.com/aiatelie/ai-atelie/pull/63), [#40](https://github.com/aiatelie/ai-atelie/issues/40))

### ❤️ Contributors

- Kadu Maverick ([@whatiskadudoing](https://github.com/whatiskadudoing))

## v0.1.3

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.2...v0.1.3)

### Features

- **web:** QoL bundle v0.1.3 — TS cleanup + Settings dialog + notifications + markdown polish ([#64](https://github.com/aiatelie/ai-atelie/pull/64))

### Refactor

- **web:** Clear pre-existing TS errors so build is green ([#59](https://github.com/aiatelie/ai-atelie/pull/59))

### ❤️ Contributors

- Kadu Maverick ([@whatiskadudoing](https://github.com/whatiskadudoing))

## v0.1.2

[compare changes](https://github.com/aiatelie/ai-atelie/compare/v0.1.1...v0.1.2)

### Features

- **web:** Tool-call kinds — colored chips with isError + DRY shared categorization ([#14](https://github.com/aiatelie/ai-atelie/pull/14))

### Docs

- **repo:** Backfill v0.1.1 release notes with the canvas-pulse feature ([5cd04cc](https://github.com/aiatelie/ai-atelie/commit/5cd04cc))
- **skills:** Evidence must show the canvas/result + use Sonnet for runs (#14 review) ([#14](https://github.com/aiatelie/ai-atelie/issues/14))

### ❤️ Contributors

- Kadu-maverickk <kadumaverick1314@gmail.com>

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
