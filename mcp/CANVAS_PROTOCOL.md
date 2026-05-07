# Canvas postMessage protocol

The host editor (AI Atelie's `web/src/`) and an in-iframe canvas component (a starter from `mcp/starters/`) coordinate via `window.postMessage`. This file is the canonical contract for that protocol — what each message means, who sends it, who receives it, and what side-effects each one is allowed to have.

This protocol is **opt-in by the iframe**. A page becomes a "canvas" by sending `__page_is_canvas` on mount. Pages that don't send it are treated as ordinary content (device-frame mode, tweaks-bridge only).

## Direction overview

| Direction | Trigger | Purpose |
|---|---|---|
| iframe → host | mount | Self-describe (canvas vs. ordinary page; tweaks-availability) |
| iframe → host | user-driven | Persist tweaks; report transient state changes |
| host → iframe | toolbar / picker | Push activation toggles, theme tokens, future zoom/probe |

## iframe → host

### `__page_is_canvas`
Sent **once on mount** by any starter that owns its own viewport. Tells the host editor to suppress device-frame display mode (the page renders edge-to-edge instead of inside a phone bezel) and to start sending canvas-only messages (`__dc_set_theme`, future `__dc_set_zoom`).

```json
{ "type": "__page_is_canvas" }
```

The host responds immediately with `__dc_set_theme` carrying current theme tokens so the canvas's first paint matches the host chrome. No ack needed from the iframe.

### `__edit_mode_available`
Sent on mount by any page that supports the in-page tweaks panel. Enables the toolbar's "Edit live" toggle. See [`skills/make-tweakable/SKILL.md`](../skills/make-tweakable/SKILL.md).

```json
{ "type": "__edit_mode_available" }
```

### `__edit_mode_set_keys`
User moved a tweak knob; iframe asks the host to persist by rewriting the EDITMODE-marked JSON block in the active route's source file.

```json
{
  "type": "__edit_mode_set_keys",
  "edits": { "primaryColor": "#D97757", "fontSize": 16 }
}
```

The host POSTs `/api/projects/:id/tweak` with the active file + edits. Vite HMR reloads the iframe with the new defaults.

### `__edit_mode_dismissed`
The iframe closed its tweaks panel internally (e.g. user pressed Escape). Lets the host clear its toolbar toggle without re-sending `__deactivate_edit_mode`.

```json
{ "type": "__edit_mode_dismissed" }
```

## host → iframe

### `__dc_set_theme`
Push current theme tokens to a canvas-mode iframe. Sent in two cases:

1. **Right after** receiving `__page_is_canvas` (so first paint is themed).
2. **On every change** to the host's `<html data-theme>` attribute (user picked a different theme in Settings → Theme).

```json
{
  "type": "__dc_set_theme",
  "tokens": {
    "bg":       "rgb(250, 249, 245)",
    "grid":     "rgba(15, 12, 8, 0.06)",
    "label":    "rgba(15, 12, 8, 0.65)",
    "title":    "rgba(15, 12, 8, 0.92)",
    "subtitle": "rgba(15, 12, 8, 0.55)",
    "surface":  "rgb(255, 255, 255)",
    "brand":    "#c96442"
  }
}
```

Token mapping (host CSS variable → canvas role):

| Canvas key | Host token | Role on the canvas |
|---|---|---|
| `bg` | `--app-bg` | The viewport background — the empty area the user pans/zooms over |
| `grid` | `--ink-06` | The repeating grid pattern stroke |
| `label` | `--ink-65` | Artboard labels (under each card) |
| `title` | `--ink-92` | Section titles |
| `subtitle` | `--ink-55` | Section subtitles |
| `surface` | `--surface` | (Reserved — for future card backgrounds, callouts) |
| `brand` | `--brand` | Focus ring on inline-edit, selection emphasis |

**Canvas-side behavior** (canonical: [mcp/starters/DesignCanvas.jsx](starters/DesignCanvas.jsx)):

- Filter to non-empty strings — an upstream null doesn't wipe a working default.
- Merge into the local `tokens` state (defaults are the standalone DC palette so the canvas looks right when opened outside the host).
- Mirror to global CSS variables on `document.documentElement` (`--dc-bg`, `--dc-grid`, etc.) so any user-authored content using `var(--dc-*, fallback)` syntax also picks up the theme.

### `__activate_edit_mode` / `__deactivate_edit_mode`
Toolbar toggle for the in-page tweaks panel. The iframe shows or hides its Tweaks UI in response.

```json
{ "type": "__activate_edit_mode" }
{ "type": "__deactivate_edit_mode" }
```

## Reserved / future

These are sketched in existing canvas starter code but not yet wired on the host side. Documented here so they don't drift.

| Type | Direction | Purpose |
|---|---|---|
| `__dc_zoom` | iframe → host | Report current canvas scale (so the host toolbar's % readout stays in sync with pinch/wheel zoom inside the canvas). |
| `__dc_present` | iframe → host | Re-announce after a hard reload (paired with `__dc_probe`). |
| `__dc_probe` | host → iframe | "Are you a canvas?" — fired on iframe `load` to handle reload races. |
| `__dc_set_zoom` | host → iframe | Push a target scale from the host toolbar's zoom-% menu. |

When wiring any of these, update this doc in the same commit.

## Implementation pointers

- **Iframe contract** (canonical): [`mcp/starters/DesignCanvas.jsx`](starters/DesignCanvas.jsx). Sister starters (`Stage9x16.jsx`, `Stage16x9.jsx`, `LowerThird.jsx`, future `animations.jsx`) should adopt the same protocol so the toolbar feels consistent across canvas modes.
- **Host bridge**: [`web/src/lib/tweakBridge.ts`](../web/src/lib/tweakBridge.ts). The `useTweakBridge` hook owns the receive-side handlers and the `__dc_set_theme` broadcast (via the `sendThemeToIframe` helper at the bottom of the file).
- **Theme token source**: [`web/src/index.css`](../web/src/index.css) (`:root` + `[data-theme="…"]` overrides) and [`web/src/lib/theme.ts`](../web/src/lib/theme.ts).

## Stability

The `__edit_mode_*` family is **stable** — third-party starters can rely on it.

The `__dc_*` family is **versioning-by-name**: new types should be additive, never re-purposed. Removing or renaming a type requires migrating every starter in `mcp/starters/` and any user projects that have copied a starter. If that ever becomes painful, introduce a `__dc_capabilities` handshake and gate features on it.
