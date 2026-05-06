---
name: interactive-prototype
display: Interactive prototype
description: Working app with real interactions
body_status: stub
sources: []
---

# Interactive prototype

> ⚠️ **STUB** — these notes are reconstructed from publicly observable behavior. Replace as the implementation is refined.

## What it's for

A clickable, hi-fi prototype of a product or flow — not a wireframe, not a static mock. The user can navigate, toggle states, and feel the interaction. Use this when the design has interactions, flows, or many-option situations (vs. purely visual exploration, which goes on a `design_canvas`).

## React + Babel (inline JSX)

When writing React prototypes with inline JSX, use these exact script tags with pinned versions and integrity hashes:

```html
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>
```

Avoid `type="module"` on script imports — it may break things.

**Style-object naming:** never use `const styles = { ... }`. Multiple components with `styles` will collide. Always namespace: `const terminalStyles = { ... }`.

**Cross-file scope:** each `<script type="text/babel">` is its own scope. Share components via window:

```js
Object.assign(window, { Terminal, Line, Spacer /* ... */ });
```

## Design process

1. Ask questions (use `mcp__ask-user__ask_user`) — confirm starting point, design context, variations wanted.
2. Find existing UI kits / codebase / screenshots — don't start from scratch.
3. Begin file with assumptions + reasoning + placeholders, show user early.
4. Build React components, embed in HTML, show user again ASAP.
5. Iterate.

## Starter components to use

- `ios_frame.jsx` / `android_frame.jsx` — device bezels with status bars and keyboards.
- `macos_window.jsx` / `browser_window.jsx` — desktop chrome.
- `design_canvas.jsx` — for laying out 2+ static option side-by-side (use this when comparing variants of a screen).

## Defaults

- Center the prototype in the viewport, or fill viewport with reasonable margins.
- No "title" screen.
- Use CSS transitions or React state for simple animation; reach for `animations.jsx` only for true motion design.
- Add a couple of Tweaks by default (see `make-tweakable`).
