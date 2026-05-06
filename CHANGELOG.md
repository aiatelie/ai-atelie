# Changelog

All notable changes to AI Atelie are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project follows
[Conventional Commits](https://www.conventionalcommits.org).

Version policy while in alpha: minor bumps are reserved for user-visible
features or breaking changes; everything else is patch.


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
