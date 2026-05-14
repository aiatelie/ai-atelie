---
name: make-tweakable
display: Make tweakable
description: Add in-design tweak controls — knobs the user can adjust live to explore variations without re-prompting.
kind: capability
body_status: verbatim
---

# Tweaks

The host editor has a **"Tweak"** toolbar toggle. When the user opens a design that participates in the Tweaks protocol, the toggle activates; clicking it opens a **panel in the editor's right sidebar** with controls — color swatches, sliders, toggles, dropdowns. Each adjustment writes back to source so the artifact persists.

**One protocol, one panel.** The panel is rendered by the host editor — never inside the design. The artifact's only job is to emit a JSON block describing what's tweakable and how each knob should affect the page. Do **not** build a panel inside the artifact; do **not** import any `tweaks_panel` or `useTweaks` library; do **not** set `window.__editModeOwned`. None of those exist in this product. If you've seen them in other Claude environments, ignore that pattern — it doesn't apply here.

When to add tweaks: the user invokes this skill via the **"Add tweaks"** toolbar button (which fires a short message: *"Apply the make-tweakable skill to `<route>`. Focus on: …"*) OR when they ask to "make this tweakable / add knobs / let me adjust." Also add a few tweaks **by default** on every substantive design — exploration is the point.

---

## How to make a design tweakable

Three steps:

### 1. Embed an EDITMODE block

Inside an inline `<script>` (or top of a JSX file), declare your tweakable values wrapped in magic comment markers:

```html
<script>
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "headline":  "Hello",
    "accent":    "#D97757",
    "fontSize":  48,
    "_meta": {
      "headline":  { "label": "Headline", "help": "Big top line." },
      "accent":    { "swatches": ["#D97757", "#2657FF", "#10B981", "#0E1116"] },
      "fontSize":  { "min": 16, "max": 96, "step": 2, "unit": "px" }
    }
  }/*EDITMODE-END*/;
</script>
```

Rules:

- **Exactly one** EDITMODE block per file.
- Block content must be **valid JSON** (double-quoted keys/strings, no trailing commas, primitive values plus the optional `_meta` object).
- Put it in the **root HTML file's inline script**, or in a `.jsx` file loaded via Babel-standalone. The host's auto-bridge scans both.

### 2. Wire each knob into the rendered page

The host applies each edit through three layers automatically — pick whichever fits your design (you can mix them per-knob):

**CSS custom properties** — for every edit `{key: value}` the host sets `--<key>` on `:root`. Reference them from CSS:

```css
h1 { color: var(--accent); font-size: var(--fontSize); }
```

**`data-tweak-text` and `data-tweak-attr` attributes** — elements with these get their text content or an attribute set automatically:

```html
<h1 data-tweak-text="headline">Hello</h1>
<img data-tweak-attr="poster:src" src="poster-a.jpg" />
```

**`window.__applyTweaks(edits)` hook** — define this function and the host calls it on every edit. Use when CSS vars / data attributes aren't enough (re-rendering React, swapping a className, recomputing layout):

```js
window.__applyTweaks = (edits) => {
  if (edits.layoutVariant !== undefined) {
    document.body.dataset.layout = edits.layoutVariant;
  }
};
```

### 3. (Optional) `_meta` — authoring hints

The host renders typed controls by inspecting the value's runtime type — `#hex` → color picker, number → range slider, boolean → checkbox, string → text input. The `_meta` sidecar refines that:

```jsonc
"_meta": {
  "<key>": {
    "label":    "Display name (else auto-humanized)",
    "help":     "One-line caption rendered under the control",
    "min":      8,                              // numbers
    "max":      48,
    "step":     1,
    "unit":     "px",                           // suffix on numeric readouts
    "swatches": ["#a", "#b", "#c", "#d"],       // hex strings — curated picker (ALWAYS prefer over free picker)
    "options":  ["Confident", "Playful", "Editorial"]  // strings — renders a <select>
  }
}
```

`_meta` is **authored-only** — the host strips it before applying edits; the server rejects `_meta` in edit POSTs.

**Strongly recommend** `_meta` for:
- **Color knobs**: `swatches` produces measurably better design than a free hex picker. You picked the palette; the user picks within it. 3–5 swatches is the sweet spot.
- **Numeric knobs**: declare `min/max/step/unit`, otherwise the slider's auto-range guesses and gets it wrong for percentages, opacity, and constrained dimensions.
- **String knobs with closed sets** (variant, tone, preset): `options: ["A", "B", "C"]` renders a dropdown instead of free text.

---

## Minimum viable artifact

```html
<!DOCTYPE html>
<html>
<head><title>Hello</title></head>
<body>
  <h1 id="title" data-tweak-text="headline">Hello</h1>
  <script>
    const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
      "headline":  "Hello",
      "accent":    "#D97757",
      "fontSize":  48,
      "_meta": {
        "accent":   { "swatches": ["#D97757", "#2657FF", "#10B981", "#0E1116"] },
        "fontSize": { "min": 16, "max": 96, "step": 2, "unit": "px" }
      }
    }/*EDITMODE-END*/;
    // Seed the page from defaults on first load.
    document.documentElement.style.setProperty("--accent", TWEAK_DEFAULTS.accent);
    document.documentElement.style.setProperty("--fontSize", TWEAK_DEFAULTS.fontSize + "px");
  </script>
  <style>
    h1 { color: var(--accent); font-size: var(--fontSize); }
  </style>
</body>
</html>
```

That's it. Open this in the editor → the "Tweak" toolbar toggle activates → click it → the sidebar panel renders three controls (headline text input, accent swatch row, headline-size range slider). Adjust them — the page updates live and the source persists.

---

## Tips

- **Add tweaks by default.** Even when the user didn't ask, pick 3–5 high-impact knobs (headline, accent, key dimension, layout variant). Never ship a design without a couple of knobs to play with.
- **Curated > free pickers for color.** A 3–5 hex palette in `_meta.swatches` produces better design than a free hex picker. Always prefer it.
- **Use `_meta.options` for any string with a closed set** (variant, tone, preset). Beats free text every time.
- **Pick high-leverage knobs.** 5–10 is the sweet spot. More than that and the panel becomes a wall of controls; fewer and you've under-exposed the design.

## Wire protocol (reference only — you don't need to think about this)

The host's auto-bridge handles the postMessage handshake — you don't write listener code. Documented for completeness:

| Direction | Message | Payload |
| --- | --- | --- |
| iframe → host | `__edit_mode_available` | `{ defaults, meta }` |
| iframe → host | `__edit_mode_set_keys` | `{ edits: { key: value, … } }` |
| host → iframe | `__edit_mode_set_keys` | `{ edits: { key: value, … } }` (when user moves a knob in the sidebar) |

The bridge applies edits via the three layers (CSS vars → `data-tweak-*` → `__applyTweaks`) in order. The server (`/api/projects/:id/tweak`) persists each edit by merging it into the EDITMODE block on disk; the iframe hot-reloads to pick up the new defaults.
