---
name: save-as-standalone-html
display: Save as standalone HTML
description: Single self-contained file that works offline
body_status: stub
sources: []
---

# Save as standalone HTML

> ⚠️ **STUB** — this is a working theory of the skill body. The wrapped tool (`super_inline_html`) gives the contract.

## What it does

Bundles an HTML file and all its referenced assets (images, CSS, JS, fonts, `ext-resource-dependency` meta tags) into a single self-contained HTML file that works offline. Runs a deterministic browser-side bundler.

## Required input

The source HTML **must** contain a `<template id="__bundler_thumbnail">` with a simple, colorful, iconographic SVG preview (30% padding on each side). This is shown:

- as a splash while the bundle unpacks, and
- as the no-JS fallback.

A simple icon, glyph, or 1–2 letters is enough.

## Workflow

1. Open the source HTML, confirm it loads cleanly.
2. Inject the `<template id="__bundler_thumbnail">` if it's not there. Keep it minimal.
3. Call `super_inline_html({ input_path, output_path })`.
4. Open the output to verify it renders standalone.
5. Offer the bundled file via `present_fs_item_for_download`.

## Notes

- Don't bundle work that's still actively being iterated on — the standalone is for handoff/share, not for in-progress.
- The bundler is deterministic; same input → same output.

## TODO

- Replace this with the real skill body once captured.
