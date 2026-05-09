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
  `window.parent.postMessage({type: '__edit_mode_available'}, '*')`
  This makes the toolbar toggle appear.
- When the user changes a value, apply it live in the page **and** persist it by calling:
  `window.parent.postMessage({type: '__edit_mode_set_keys', edits: {fontSize: 18}}, '*')`
  You can send partial updates — only the keys you include are merged.

## Persisting state

Wrap your tweakable defaults in comment markers so the host can rewrite them on disk, like this:

```
const TWEAK_DEFAULS = /*EDITMODE-BEGIN*/{
  "primaryColor": "#D97757",
  "fontSize": 16,
  "dark": false
}/*EDITMODE-END*/;
```

The block between the markers **must be valid JSON** (double-quoted keys and strings). There must be exactly one such block in the root HTML file, inside inline `<script>`. When you post `__edit_mode_set_keys`, the host parses the JSON, merges your edits, and writes the file back — so the change survives reload.

## Tips

- Keep the Tweaks surface small — a floating panel in the bottom-right of the screen, or inline handles. Don't overbuild.
- Hide the controls entirely when Tweaks is off; the design should look final.
- If the user asks for multiple variants of a single element within a largher design, use this to allow cycling thru the options.
- If the user does not ask for any tweaks, add a couple anyway by default; be creative and try to expose the user to interesting possibilities.
- Add `data-cc-no-inspect="true"` to the panel root and the FAB so the editor's inspector skips them.
- **Set `window.__editModeOwned = true`** at the top of your panel script so the host's auto-bridge backs off. Without it, the host renders its own typed Tweaks sidebar from your EDITMODE block in addition to your panel — both work, but it's noisy.

## Cheap path: no panel, just an EDITMODE block

If your tweak surface is small (≤6 keys, all primitives) and you don't need bespoke UI, **skip writing a panel entirely**. Just embed the EDITMODE block and wire each key through one of:
- a CSS variable named after the key — `var(--<key>)` — and set values via `--<key>: ...` on `:root`
- a `window.__applyTweaks(edits)` function that re-renders with the new values
- a `data-tweak-text="<key>"` attribute on an element whose text content tracks the key, or `data-tweak-attr="<key>:<attrName>"` for arbitrary attributes

The host's auto-bridge (`/tweaks-bridge.js`, injected into every preview HTML) reads the EDITMODE block, posts `__edit_mode_available` with `{ defaults }` to the parent, and applies any incoming `__edit_mode_set_keys` through those three layers. The host then renders typed controls — color pickers for `#hex` strings, sliders for numbers, toggles for booleans, text inputs for strings — without any panel code on your side.
