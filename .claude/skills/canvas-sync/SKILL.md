---
name: canvas-sync
description: Keep the canvas surface coherent across its three places — the canonical starter at `mcp/starters/DesignCanvas.jsx`, the byte-identical demo copy at `web/projects/demo/design-canvas.jsx`, and the host-side wiring in `web/src/lib/tweakBridge.ts` plus `mcp/CANVAS_PROTOCOL.md`. Use whenever the diff touches any of those files, or when the user says "fix the canvas", "update DesignCanvas", "tweak the design canvas", "the canvas isn't working in new projects", or anything similar. Without this rule, fixes land in one place and silently miss the other — the demo project tests stale code, or new projects get content that doesn't match what's been verified.
---

# canvas-sync

A contributor workflow for AI Atelie. The DesignCanvas surface (the pannable, zoomable workspace that wraps every project's content) lives in **three places at once**, and a change to one without the others is almost always a bug.

This skill is **dev-time only**. It does not load into adapter sessions spawned by the editor.

## The three places, and what each one is for

| Location | Role | Loaded when |
|---|---|---|
| `mcp/starters/DesignCanvas.jsx` | **Canonical source of truth.** The starter the agent copies via `mcp__starters__copy_starter` and the route `POST /api/projects/create` reads to seed every new project. | An agent calls `copy_starter` in an existing project · A user creates a new project. |
| `web/projects/demo/design-canvas.jsx` | **Demo project's copy.** The "AI Atelie demo" project that ships in the repo and renders on first run. | A user opens the demo from `/projects` (e.g. via `home-shows-demo` journey, or anyone testing locally). |
| `web/src/lib/tweakBridge.ts` + `mcp/CANVAS_PROTOCOL.md` | **Host-side wiring.** The parent's listener for `__page_is_canvas`, the `__dc_set_theme` broadcast, and the documented protocol contract. | The editor mounts an iframe that announces `__page_is_canvas`. |

## The parity rule

**The two `.jsx` files MUST be byte-identical at every commit.** They are not "two copies that drift" — they are two materializations of one source. Verify with:

```sh
md5 mcp/starters/DesignCanvas.jsx web/projects/demo/design-canvas.jsx
# (Linux: md5sum)
```

The two hashes must match. If they don't, **stop and reconcile before committing.**

## The flow direction

Always edit the canonical first, then mirror — never the other way around. The canonical is the file every NEW project copies; the demo is just a testbed.

```sh
# 1. Edit the canonical
$EDITOR mcp/starters/DesignCanvas.jsx

# 2. Mirror to the demo
cp mcp/starters/DesignCanvas.jsx web/projects/demo/design-canvas.jsx

# 3. Verify they match
md5 mcp/starters/DesignCanvas.jsx web/projects/demo/design-canvas.jsx

# 4. Both files go in the same commit
git add mcp/starters/DesignCanvas.jsx web/projects/demo/design-canvas.jsx
```

## Why both, and what breaks if you skip one

- **Canonical only, no demo mirror** — your changes ship to brand-new projects (via `POST /api/projects/create` reading the canonical), but **the demo project that everyone uses to test still runs the old code.** You think you've verified the change; you haven't. The journey suite (which exercises the demo via `home-shows-demo`) exercises stale behavior.
- **Demo only, no canonical mirror** — your changes are visible in the demo but **every new project the user creates gets the OLD canvas.** First-run users see the wrong thing; the demo lies.
- **Both `.jsx` files but no host-side update** — the iframe protocol expects something the host doesn't send (or vice versa). Silent misbehavior — the canvas mounts but the theme isn't pushed, or the viewport doesn't react to the toolbar zoom.
- **Host-side update without protocol doc** — the next contributor adds a third type with no idea the second exists. Documentation drift compounds.

## When the host wiring needs to change too

If your edit adds or changes a postMessage type — anything starting with `__dc_*` or `__page_is_canvas` — you also need to:

1. **Update `web/src/lib/tweakBridge.ts`** with the new send or receive logic. The bridge owns the host side of every iframe-↔-host message pair; new types live there.
2. **Update `mcp/CANVAS_PROTOCOL.md`** with the new type, payload schema, direction, and side-effects. The protocol doc is the canonical contract — third-party starters read it; future contributors read it; it must not lie.
3. **Update both `.jsx` files** as above so the iframe side speaks the new type too.

A diff that touches the iframe's postMessage handlers but leaves `tweakBridge.ts` untouched is suspect. A diff that adds a `__dc_*` type but leaves `CANVAS_PROTOCOL.md` untouched is suspect.

## Hard rules — and what to do INSTEAD

- **Don't edit only one of the two `.jsx` files.** **INSTEAD**: edit the canonical, mirror with `cp`, verify with `md5`, commit both together. The demo copy is not a "live" file — it's a snapshot.
- **Don't edit `web/projects/demo/design-canvas.jsx` first and `cp` back.** **INSTEAD**: canonical first, every time. The demo is downstream. Editing it directly inverts the flow and creates merge confusion when the canonical is later updated by someone else.
- **Don't add a postMessage type without updating `mcp/CANVAS_PROTOCOL.md`.** **INSTEAD**: same commit adds the new type to the protocol doc with a payload schema, a direction, and one sentence on what receipt is supposed to do.
- **Don't assume the agent's `copy_starter` is the only consumer of `mcp/starters/`.** **INSTEAD**: remember that `POST /api/projects/create` (in `api/src/routes/projects.ts`) also reads `mcp/starters/DesignCanvas.jsx` at create time. Two distinct consumers; the canonical must satisfy both.
- **Don't update existing user projects' `design-canvas.jsx`.** **INSTEAD**: only the demo (which ships as part of the repo) is in version control. User projects under `web/projects/p_*/` are user data — gitignored. They keep whatever copy was current at the time they were created. If the user wants the latest canvas in an existing project, the agent re-runs `copy_starter` for them.

## When to invoke

- The diff touches `mcp/starters/DesignCanvas.jsx`, `web/projects/demo/design-canvas.jsx`, `web/src/lib/tweakBridge.ts`, or `mcp/CANVAS_PROTOCOL.md`.
- The diff adds, removes, or renames any postMessage type whose name starts with `__dc_` or `__page_is_canvas`.
- The user says "fix the canvas", "the canvas isn't working in new projects", "update DesignCanvas", "tweak the design canvas", "add a feature to the canvas", or "why does the demo behave differently from new projects".

Skip when:
- The diff is in `mcp/starters/` but for a non-canvas starter (e.g. `Stage16x9.jsx`, `Stage9x16.jsx`, `LowerThird.jsx`) AND those starters have no demo copy. Sister starters can graduate to the same parity rule — see "Future starters" below.
- The diff is in `web/projects/demo/` but in a file that isn't `design-canvas.jsx` (e.g. `Banner.jsx`, the demo's `index.html` content). Those are demo-specific content, not a canonical starter mirror.

## Workflow (paste this into your reply and tick as you go)

- [ ] **Read both files.** Open `mcp/starters/DesignCanvas.jsx` and confirm `md5 mcp/starters/DesignCanvas.jsx web/projects/demo/design-canvas.jsx` already match (sanity baseline).
- [ ] **Edit the canonical only.** All edits land in `mcp/starters/DesignCanvas.jsx`.
- [ ] **Mirror.** `cp mcp/starters/DesignCanvas.jsx web/projects/demo/design-canvas.jsx`
- [ ] **Verify parity.** `md5 mcp/starters/DesignCanvas.jsx web/projects/demo/design-canvas.jsx` — both hashes match.
- [ ] **If postMessage protocol changed** — update `web/src/lib/tweakBridge.ts` (host side) AND `mcp/CANVAS_PROTOCOL.md` (contract).
- [ ] **Stage everything together.** `git add mcp/starters/DesignCanvas.jsx web/projects/demo/design-canvas.jsx` (and the host-side files if they changed).
- [ ] **Commit** via [`.claude/skills/semantic-commit/SKILL.md`](../semantic-commit/SKILL.md) with `scope=mcp` for canvas-only changes, or `scope=repo` if the diff spans starters + host side.
- [ ] **If the change is user-visible** — add a `--task` spec or use `verify-with-playwright` so the journey evidence on the PR shows the new behavior in the canvas, not just in the chrome.

## Future starters

The parity rule generalizes. Today only `DesignCanvas.jsx` has a demo mirror — but as soon as another starter (`Stage9x16.jsx`, `Stage16x9.jsx`, `LowerThird.jsx`, future `animations.jsx`) gets used inside the demo project, the same byte-identical rule kicks in for that file.

Forward-compatible workflow when adopting:
1. Decide whether the demo wants to USE the starter (i.e. the demo's `index.html` references it).
2. If yes, copy `mcp/starters/<Name>.jsx` → `web/projects/demo/<name>.jsx` (note the case difference is the existing convention — kebab-case in the demo, PascalCase in `mcp/starters/`).
3. From that point on, every edit to the canonical mirrors to the demo copy.

When this happens, update the table at the top of this skill and the parity rule below it.

## See also

- [`mcp/CANVAS_PROTOCOL.md`](../../../mcp/CANVAS_PROTOCOL.md) — the postMessage contract between host and canvas iframes.
- [`mcp/starters/DesignCanvas.jsx`](../../../mcp/starters/DesignCanvas.jsx) — canonical canvas source.
- [`web/projects/demo/design-canvas.jsx`](../../../web/projects/demo/design-canvas.jsx) — demo project's mirror.
- [`web/src/lib/tweakBridge.ts`](../../../web/src/lib/tweakBridge.ts) — host bridge owning `__page_is_canvas` receive + `__dc_set_theme` send.
- [`api/src/routes/projects.ts`](../../../api/src/routes/projects.ts) — `POST /api/projects/create` reads `mcp/starters/DesignCanvas.jsx` at create time and writes it into the new project.
- [`.claude/skills/frontend-design/SKILL.md`](../frontend-design/SKILL.md) — the chrome-aesthetic skill that fires for `web/src/` changes, including any `tweakBridge.ts` edit that's user-visible.
- [`.claude/skills/verify-with-playwright/SKILL.md`](../verify-with-playwright/SKILL.md) — capture canvas evidence after a change.
