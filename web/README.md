# AI Atelie — editor

A Vite + React editor for design projects. Each project is a sandboxed folder of HTML/JSX/CSS that an agent CLI can edit via chat, the user can tweak via knobs, and the user can edit ad-hoc via an inspector.

## Run

```sh
npm install
npm run dev          # vite on http://localhost:5173 by default
```

For tests + scripts that hit the running server, see [tests/README.md](./tests/README.md).

## Architecture overview

### Per-project sandboxes

Each design project is a directory under `web/projects/<id>/`, scaffolded from a starter template (`server/projects.ts → scaffoldProject`). The project owns its own files: `index.html`, `style.css`, optional `.jsx` components, etc. Files are served raw to the iframe at `/p/<id>/<path>`. There's no build step inside a project — pages are plain HTML + CDN React + Babel-Standalone.

### The editor's three edit paths

| Path | Storage | Speed | Use case |
|---|---|---|---|
| **Tweaks (EDITMODE bridge)** | source file (`/api/projects/:id/tweak`) | instant | predefined knob panels declared via `/*EDITMODE-BEGIN*/{...}/*EDITMODE-END*/` markers |
| **Inspector → Save** | `_inspector_edits.css` (`/api/projects/:id/inspector-css`) | instant, no AI | ad-hoc CSS changes on any element via the right-side panel |
| **Bake to source** | original JSX/CSS via AI | AI roundtrip | when the inspector edit needs to become permanent (shipping) |

These coexist; `_inspector_edits.css` uses `!important` so it always wins the cascade. Triggering "Edit live" warns if there are unsaved inspector edits that would shadow tweak changes.

### Bridges

| File | What it does |
|---|---|
| `src/lib/tweakBridge.ts` | host side of `make-tweakable` postMessage contract — `__edit_mode_available`, `__edit_mode_set_keys`, `__page_is_canvas` |
| `src/lib/dmBridge.ts` | injects `inject-script.js` + `_inspector_edits.css` `<link>` into every iframe load; routes typed commands to/from the iframe DOM |
| `public/inject-script.js` | runs inside the iframe; stamps `data-dm-ref` for selector resolution; applies inline-style commands from the host (with `!important` for cascade parity) |
| `src/lib/editorOverrides.ts` | localStorage for in-flight inspector overrides; `useOverrideCount(route)` drives the toolbar Save badge |
| `src/lib/chatStream.ts` | SSE plumbing for `/api/comment-edit` — text deltas, tool chips, thinking blocks, elicitation events |

### Routes (frontend SPA)

- `/projects` — dashboard / new project dialog
- `/projects/:id/start` — onboarding wizard (full-page chat, structured intake before any edits)
- `/editor` — Figma-like editor (iframe canvas + inspector + chat sidebar + tabs)

### Backend (Vite middleware)

- `server/projects.ts` — project CRUD, manifest, file upload/delete, tweak rewrite, inspector-css writer, static serve at `/p/:id/*`
- `server/commentEdit.ts` — `/api/comment-edit` SSE; spawns Claude via `@anthropic-ai/claude-agent-sdk` (subscription OAuth, no API key); wires elicitation bridge for `mcp__ask-user__ask_user`
- `server/elicitBus.ts` — pending-promise table for elicitation roundtrips

### MCP servers (in `mcp/`)

| Server | Tool | Purpose |
|---|---|---|
| `ask-user-server.mjs` | `ask_user` | structured-form questions in chat using the `questions_v2`-style schema |
| `starters-server.mjs` | `copy_starter`, `list_starters` | drops `Stage16x9.jsx`, `Stage9x16.jsx`, `LowerThird.jsx` etc. into the project |

### Skills

`skills/<name>/SKILL.md` — local skill library (Frontend design, Make tweakable, Interactive prototype, etc.). Loaded into adapter sessions via `ENV.SKILLS_DIR` (see `api/src/services/claude.ts`); not auto-discovered from a `.claude/skills/` symlink.

## Running just the dev server (no test suite, no install of MCP servers)

```sh
npm run dev
```

Opens the editor. From there: New Project → onboarding chat → Open editor → start designing.
