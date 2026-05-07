---
name: frontend-design
description: Aesthetic and convention guide for editing AI Atelie's own chrome — the editor, canvas frame, toolbars, sidebars, dialogs, settings, projects screen. Use whenever the diff touches `web/src/` (especially `*.module.css`, `index.css`, `styles/themes.css`, `lib/theme.ts`) or any user-facing component on the host app. Grounds the agent in the existing two-axis system (theme × design), the token-only color rule, and the 6-font global stack so chrome edits stay coherent across all 4 themes and 12 designs. NOT for user-generated designs inside the canvas — those use the product skill at `skills/frontend-design/`.
---

# frontend-design (dev-time)

A contributor workflow for AI Atelie. This skill governs how Claude Code edits the **host application's own chrome** — the parts of AI Atelie a user sees regardless of what they're designing inside the canvas. It is dev-time only and does not load into adapter sessions spawned by the editor.

If you're editing the canvas, the chat sidebar, the toolbar, the projects screen, the settings dialog, or any CSS module under `web/src/`, this skill applies. If you're editing a SKILL.md under `skills/<name>/` that governs *user-generated designs*, this skill does NOT apply — that's the product skill, a different surface.

## What's already decided (grounding)

Three things were settled before this skill existed. Don't re-relitigate them per change.

**Two axes drive the chrome.** See [web/src/lib/theme.ts](../../../web/src/lib/theme.ts).
- `theme` — `system | light | dark | retro` — brightness preference.
- `design` — `null | violet | mono | paper | espresso | coral | ember | vinyl | scarlet | glacier | phosphor | hornet | prism` — an opt-in decorative palette overlay. Twelve of them, each tuned in [tools/gen-themes.mjs](../../../tools/gen-themes.mjs).
- Both apply through one `data-theme` attribute on `<html>`. Picking a theme clears the design (so "click → see change" stays honest).

**Token-only color.** Every color in a CSS module must reference a CSS variable from [web/src/index.css](../../../web/src/index.css). The source comments are explicit: *"If you find a hardcoded color in a CSS module, that's a bug — pick the closest token below."* The token vocabulary is rich enough to cover almost every need:
- Surfaces — `--app-bg`, `--surface`, `--surface-2`, `--surface-3` (warm tinted), `--surface-4` (zebra), `--surface-warm`
- Ink (text + alpha overlays on warm bg) — `--ink-02` … `--ink-92` (alpha-percent suffix), plus `--ink-strong`, `--ink-deep`
- Inverse ink (text + alpha overlays on dark bg) — `--on-ink`, `--on-ink-06` … `--on-ink-90`, plus `--on-ink-soft-65/80/90`
- Brand (Claude rust) — `--brand: #c96442`, plus `--brand-fg`, `--brand-strong-fg`, `--brand-bg`, `--brand-border`, `--brand-hover`, `--brand-strong`, `--brand-light`, `--brand-warm`
- Plus semantic tokens further down `index.css` — read the file before guessing.

**Six fonts, loaded globally.** [index.css:11](../../../web/src/index.css:11) imports the full stack from Google Fonts on first paint:
- JetBrains Mono (400/500/600/700) — code, terminal, file paths, monospaced data
- Archivo (400/700/900) — display sans, headings
- Syne (700/800) — wide display, hero/title weight
- Noto Sans JP (900) — heaviest display, dramatic accent
- Antonio (700) — condensed display
- Instrument Serif (italic + roman) — italic accent, editorial flourishes

If a new role genuinely is missing, extend the import in `index.css` and document why in the diff. Don't add a font import inside a single component file.

## When to invoke

- Any diff that adds, modifies, or removes CSS in `web/src/` (modules or globals).
- Any diff that adds or modifies a TSX/JSX component with visible UI.
- Any change to `web/src/lib/theme.ts` or the generated [styles/themes.css](../../../web/src/styles/themes.css).
- Before creating a new component — read the closest neighbour's module to feel the conventions.
- When the user says "make this prettier", "the editor looks broken in Dark", "match the design language", or "ship a UI polish pass".

Skip when:
- The change is api-only, mcp-only, or build-config-only with no UI surface.
- The diff touches only `web/projects/` (user data, not chrome).
- The diff is to `skills/<name>/SKILL.md` — that's the product skill, a different scope.

## Hard rules — and what to do INSTEAD

Each rule below names a failure mode and the move to make instead. Refusing alone is half the work.

- **Don't hardcode colors in CSS modules.** Source comments call this a bug explicitly. **INSTEAD**: read [index.css](../../../web/src/index.css) top to bottom, pick the semantic token that matches the role (`--surface-3` for chat composer–like surfaces, `--surface-warm` for dialogs, `--brand-bg` for tinted brand pills). If no token fits, add one at `:root` AND mirror it in every override block — Light, Dark, Retro at the bottom of `index.css`, plus all 12 designs in `styles/themes.css`. Skipping the mirrors leaves a theme silently broken.
- **Don't bypass the alpha ink scale.** **INSTEAD**: pick the closest `--ink-NN` (or `--on-ink-NN` on dark surfaces). The scale is dense (02, 04, 05, 06, 08, 10, 12, 15, 20, 25, 30, 35, 40, 44, 50, 55, 60, 64, 65, 70, 78, 85, 92) — there is almost certainly a stop within 2% of what you want.
- **Don't write `#fff` / `#000` / `rgba(0,0,0,.X)` literals.** **INSTEAD**: use `--surface` / `--ink-strong` / `--ink-NN`. White and black both shift in Dark and Retro; literals freeze chrome to one theme.
- **Don't add a font import inside a single component file.** **INSTEAD**: check if one of the six existing fonts covers the role. If a new role is genuinely needed, extend the global `@import` in `index.css` and explain why in the commit body. Multiple per-component `@import` calls fragment the load and break offline reproducibility.
- **Don't ship chrome that's only verified in default theme.** **INSTEAD**: after implementing, toggle through Light → Dark → Retro using the theme picker (foot pill or Settings → Appearance). Spot-check at least one design overlay (Violet and Mono are good signal) — if it breaks, the theme tokens you chose are too narrow.
- **Don't pick a "roughly correct" token without checking the comments.** [index.css](../../../web/src/index.css) annotates surfaces and ink scales by *intended use*. **INSTEAD**: skim those comments before picking — `--surface-3` is the warm tinted card (chat composer, dropdown items), `--surface-warm` is the slightly-warmer card surface (dialogs, file rows). They are not interchangeable.
- **Don't introduce a new design or theme axis on a feature PR.** **INSTEAD**: scope additions to `lib/theme.ts` + `tools/gen-themes.mjs` to dedicated PRs (mirror PR [#80](https://github.com/aiatelie/ai-atelie/pull/80) for the prior 12-palette landing). Decoration drift on feature PRs erodes the system.

## Aesthetic posture for AI Atelie's own chrome

The host app's default look is **warm-cream surfaces + Claude rust accent + dense alpha ink**. That's the canonical. The 12 designs are decoration the user opts into.

- **Restraint over flourish.** The chrome's job is to recede so the canvas can carry the design conversation. Maximalism belongs *inside* the canvas (user-generated designs), not in the toolbars surrounding it.
- **Mono + display + serif together, on purpose.** The 6-font stack lets a label use Archivo, a path use JetBrains Mono, and an editorial moment use Instrument Serif italic. Don't collapse to one family because it's "simpler" — the variety is part of the voice.
- **Brand sparingly.** `--brand` (rust) is for primary action / state-change moments. Don't paint surfaces in it. The brand alphas (`--brand-soft`, `--brand-bg`, `--brand-border`) exist precisely so brand can show through without dominating.
- **Ink density is the texture.** The reason the alpha ink scale has 25+ stops is so that borders, dividers, faint hovers, and overlays land precisely. A lazy `--ink-50` border looks wrong everywhere; the right answer is usually `--ink-08` to `--ink-15`.

## Workflow

1. **Read the neighbour first.** Open the closest sibling component's `*.module.css` and see how it composes tokens. Adopt the patterns there before inventing new ones.
2. **Read the relevant section of [index.css](../../../web/src/index.css).** The annotation comments are the design-system documentation.
3. **Implement using only tokens.** No literals, no per-component fonts, no inline color styles.
4. **Run the dev server.** Per repo memory: Vite binds `localhost`/IPv6 (not `127.0.0.1`); the live-preview process auto-restarts on `:5173` if killed, so don't fight it. Just `bun run dev` and let it run.
5. **Verify the canonical theme works** — use [`.claude/skills/verify-with-playwright/SKILL.md`](../verify-with-playwright/SKILL.md) for evidence.
6. **Spot-check the other axes.** In the running browser: open Settings, switch theme through Light → Dark → Retro, then turn on Violet and Mono designs. If anything breaks, the tokens picked were too narrow — fix at the token layer, not the component.
7. **Commit via [`.claude/skills/semantic-commit/SKILL.md`](../semantic-commit/SKILL.md)** with `scope=web` (or `skills` if the change was to a SKILL.md).

## When this skill is wrong

This skill encodes the conventions in place at the time it was written. If the user is intentionally evolving the system — landing a new design overlay, refactoring the token layer, replacing the font stack — the rules above describe the *current* state, not a constraint on the future. Follow the user's lead, then update this skill in the same PR so the next contributor sees the new ground truth.

## See also

- [web/src/index.css](../../../web/src/index.css) — token source of truth.
- [web/src/styles/themes.css](../../../web/src/styles/themes.css) — generated 12-design overrides.
- [web/src/lib/theme.ts](../../../web/src/lib/theme.ts) — theme + design axis definitions.
- [tools/gen-themes.mjs](../../../tools/gen-themes.mjs) — palette generator.
- [.claude/skills/verify-with-playwright/SKILL.md](../verify-with-playwright/SKILL.md) — capture chrome evidence.
- [.claude/skills/cuj-guardian/SKILL.md](../cuj-guardian/SKILL.md) — gate before approving any UI PR.
- [skills/frontend-design/SKILL.md](../../../skills/frontend-design/SKILL.md) — the product skill that governs *user-generated* designs in the canvas; this skill is its mirror for *the host app's chrome*.
