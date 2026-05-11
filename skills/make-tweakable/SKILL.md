---
name: make-tweakable
display: Make tweakable
description: Add in-design tweak controls
kind: capability
body_status: verbatim
---

# Tweaks

The user can toggle **Tweaks** on/off from the toolbar. When on, show additional in-page controls that let the user tweak aspects of the design — colors, fonts, spacing, copy, layout variants, feature flags, whatever makes sense. **You design the tweaks UI**; it lives inside the prototype. Title your panel/window **"Tweaks"** so the naming matches the toolbar toggle.

## Protocol

- **Order matters: register the listener before you announce availability.** If you post `__edit_mode_available` first, the host's activate message can land before your handler exists and the toggle silently does nothing.

- **First**, register a `message` listener on `window` that handles:
  `{type: '__activate_edit_mode'}` → show your Tweaks panel
  `{type: '__deactivate_edit_mode'}` → hide it
- **Then** — only once that listener is live — call:
  `window.parent.postMessage({type: '__edit_mode_available'}, window.location.origin)`
  This makes the toolbar toggle appear.
- When the user changes a value, apply it live in the page **and** persist it by calling:
  `window.parent.postMessage({type: '__edit_mode_set_keys', edits: {fontSize: 18}}, window.location.origin)`
  You can send partial updates — only the keys you include are merged.

## Persisting state

Wrap your tweakable defaults in comment markers so the host can rewrite them on disk, like this:

```
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "primaryColor": "#D97757",
  "fontSize": 16,
  "dark": false
}/*EDITMODE-END*/;
```

The block between the markers **must be valid JSON** (double-quoted keys and strings, primitive values only — no nested objects except the optional `_meta` sidecar below). There must be exactly one such block in the root HTML file (or in a JSX file loaded via Babel-Standalone). When you post `__edit_mode_set_keys`, the host parses the JSON, merges your edits, and writes the file back — so the change survives reload.

## `_meta` — control hints for the host panel (RECOMMENDED)

When you go with the cheap path (no panel of your own, just an EDITMODE block — see below), the host renders typed controls based on the runtime type of each value: color picker for `#hex`, range slider for numbers, checkbox for booleans, textarea for long strings, text input otherwise. The default heuristics for sliders pick `[0, 2|n|]` around the seed, which works for sizes but **misses on percentages (should be 0–100), opacity (0–1), and other constrained ranges**.

Solve this by adding an optional `_meta` sub-key inside the EDITMODE block. Each entry refines one knob:

```
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "primaryColor": "#D97757",
  "fontSize":     16,
  "opacity":      0.5,
  "tone":         "Confident",
  "_meta": {
    "primaryColor": {
      "label":    "Primary",
      "help":     "Used for buttons, links, the headline rule.",
      "swatches": ["#D97757", "#2657FF", "#10B981", "#0E1116"]
    },
    "fontSize": { "min": 8,  "max": 48, "step": 1, "unit": "px" },
    "opacity":  { "min": 0,  "max": 1,  "step": 0.05 },
    "tone":     { "options": ["Confident", "Playful", "Editorial", "Clinical"] }
  }
}/*EDITMODE-END*/;
```

Supported per-key fields (all optional):

- **`label`** — display label override (else the key is auto-humanized: `primaryColor` → "Primary color").
- **`help`** — one-line caption rendered below the control.
- **`min` / `max` / `step`** — numeric range. Required for percentages and opacity to avoid heuristic flailing. Otherwise the slider picks a sensible range from the seed.
- **`unit`** — suffix on the numeric readout (`"px"`, `"%"`, `"ms"`). Cosmetic only — the underlying value stays bare.
- **`swatches`** — array of hex strings. When present, the panel renders a **curated swatch row instead of a free color picker**. Prefer this over `<input type="color">` for design intent: you picked the palette, the user picks within it. 3–5 swatches is the sweet spot.
- **`options`** — array of allowed string values. Renders as a `<select>` dropdown; works for any string-valued knob. Beats free text when the design has discrete states (variants, tones, presets).

The `_meta` key is treated as **authored-only** — the host bridge strips it before applying edits, the server rejects `_meta` in `/api/projects/:id/tweak` POSTs. Round-trips preserve `_meta` verbatim.

## Opting out of the auto-bridge

When you ship a custom Tweaks panel, the host's auto-bridge (`/tweaks-bridge.js`) is still injected into the page. Without an opt-out it will *also* post `__edit_mode_available` and render a host-side sidebar — both work, but the duplicate UI is noisy.

### `window.__editModeOwned` — the opt-out flag

Set this **synchronously in an inline `<script>` near the top of `<body>`**, *before* any `defer`-ed or `DOMContentLoaded`-fired script runs:

```html
<script>window.__editModeOwned = true;</script>
```

**Timing is critical.** The auto-bridge is injected with `defer` and runs after `DOMContentLoaded`. If you set `__editModeOwned` inside a `DOMContentLoaded` handler or in a `defer`-ed script, you may lose the race and the auto-bridge will already have announced itself. An inline script (no `defer`, no `async`) at the top of `<body>` is always safe.

Any truthy value disables the bridge (`true`, `1`, `"yes"` all work).

## Tips

- Keep the Tweaks surface small — a floating panel in the bottom-right of the screen, or inline handles. Don't overbuild.
- Hide the controls entirely when Tweaks is off; the design should look final.
- If the user asks for multiple variants of a single element within a larger design, use this to allow cycling thru the options.
- If the user does not ask for any tweaks, add a couple anyway by default; be creative and try to expose the user to interesting possibilities.
- Add `data-cc-no-inspect="true"` to the panel root and the FAB so the editor's inspector skips them.
- **Prefer curated swatches over free color pickers.** Free hex pickers give the user too much freedom and produce slop; a 3–5 swatch palette `_meta.<key>.swatches` channels the choice within an intentional range. Same for `_meta.<key>.options` on discrete-state strings (tone, variant, preset) — beats free text.

## Cheap path: no panel, just an EDITMODE block

If your tweak surface is small (≤6 keys, all primitives) and you don't need bespoke UI, **skip writing a panel entirely**. Just embed the EDITMODE block (with `_meta` hints!) and wire each key through one of:
- a CSS variable named after the key — `var(--<key>)` — and set values via `--<key>: ...` on `:root`
- a `window.__applyTweaks(edits)` function that re-renders with the new values
- a `data-tweak-text="<key>"` attribute on an element whose text content tracks the key, or `data-tweak-attr="<key>:<attrName>"` for arbitrary attributes

The host's auto-bridge (`/tweaks-bridge.js`, injected into every preview HTML) reads the EDITMODE block, posts `__edit_mode_available` with `{ defaults, meta }` to the parent, and applies any incoming `__edit_mode_set_keys` through those three layers. The host then renders typed controls — swatches when `_meta.swatches` is set, otherwise color picker for `#hex`, range slider for numbers (honouring `_meta.{min,max,step,unit}`), selects when `_meta.options` is set, toggles for booleans, text/textarea for strings — without any panel code on your side.
