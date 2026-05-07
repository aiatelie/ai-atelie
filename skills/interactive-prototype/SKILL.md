---
name: interactive-prototype
display: Interactive prototype
description: Build a clickable, hi-fi prototype of a product or flow — not a wireframe, not a static mock. The user can navigate, toggle states, and feel the interaction. Reach for this whenever the design has flows, multi-screen states, or many-option situations.
kind: capability
body_status: reconstructed
sources: []
---

# Interactive prototype

A clickable, hi-fi prototype of a product or flow — not a wireframe, not a static mock. The user can navigate, toggle states, and feel the interaction. Use this whenever the design has flows, multi-screen states, or many-option situations.

## When to use this skill

- The user asks for "an app", "a flow", "a multi-step thing", "let me see it working", "let me click around".
- The design has stateful behavior (toggles, modals, multi-screen navigation, form validation flows).
- There are 3+ screens that connect.
- The user needs to demo interactions to a stakeholder.

## When this skill does NOT apply

- **Single static surface** (a banner, a poster, a thumbnail, a single-screen marketing page) → that's purely visual; use the existing DesignCanvas with one or more `<DCArtboard>` instead.
- **Comparing variations of one element side-by-side** → also DesignCanvas, multiple `<DCArtboard>` children in a single `<DCSection>`.
- **Timeline-based motion** (the page advances on a clock, elements enter/exit on a schedule) → that's [`animated-video`](../animated-video/SKILL.md), not this skill.

## Build with React + Babel (inline JSX)

The project's iframe loads React + ReactDOM + Babel-Standalone from CDN at the top of `index.html`. Use these exact script tags with pinned versions and integrity hashes — newer minor versions sometimes break the inline-JSX flow without notice:

```html
<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" integrity="sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" integrity="sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" integrity="sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y" crossorigin="anonymous"></script>
```

**Don't add `type="module"` on script imports.** Babel-standalone doesn't transpile module imports cleanly in this CDN setup; the iframe will silently fail to mount.

**Style-object naming.** Never declare `const styles = { ... }`. Multiple components in the same file (or multiple `<script type="text/babel">` blocks sharing the iframe window) will collide on the `styles` global. Always namespace: `const terminalStyles = { ... }`, `const composerStyles = { ... }`.

**Cross-file scope.** Each `<script type="text/babel">` block is its own scope. Components defined in one block aren't visible to the next without going through `window`. At the bottom of every component-defining block, write:

```js
Object.assign(window, { Terminal, Line, Spacer /* every component declared here */ });
```

The next block can then read them off `window` directly: `const { Terminal, Line, Spacer } = window;`.

## Starter components to drop in

The host's MCP starters server exposes these via `mcp__starters__copy_starter`. Each is a single `.jsx` file that drops into the project; reference it from the iframe's `<head>` with `<script type="text/babel" src="<name>.jsx">`.

| Starter | Use it for |
|---|---|
| `ios_frame.jsx` | Mobile prototype with iOS status bar, home indicator, keyboard. |
| `android_frame.jsx` | Mobile prototype with Android status bar, navigation bar. |
| `macos_window.jsx` | Desktop window chrome — title bar, traffic-light buttons. |
| `browser_window.jsx` | Web app inside a browser frame — URL bar, tabs. |
| `design_canvas.jsx` (DesignCanvas) | Laying out 2+ static screens side-by-side for comparison. |

The DesignCanvas wrapper is already present in fresh projects (see [skills/frontend-design/SKILL.md](../frontend-design/SKILL.md) and the project's `index.html`). Add additional `<DCArtboard>` children to the existing `<DCSection>` to lay multiple flows side-by-side.

## Build process

1. **Confirm the brief.** Use `mcp__ask-user__ask_user` if anything's vague: how many screens, which device frame, what states matter.
2. **Look for prior art** in the project before generating from scratch — existing components, uploaded screenshots, anything in `uploads/`. Designs are stronger when they riff on something concrete.
3. **Show the user something fast.** Drop in a placeholder version of the first screen with assumptions visible (annotations, a `// TODO` comment block at the top), let them react before going deep on every screen.
4. **Build the React components per screen.** Keep each screen in its own component file (`HomeScreen.jsx`, `ProductDetail.jsx`, etc.), shared primitives in a `Primitives.jsx`. Wire navigation via state.
5. **Add tweaks.** A couple of `make-tweakable` knobs by default (color, copy, layout variant) so the user can riff without re-prompting. See [skills/make-tweakable/SKILL.md](../make-tweakable/SKILL.md).
6. **Iterate.** The user is using the running prototype — every change should be visible in <5 seconds.

## Defaults

- Center the prototype in the viewport (mobile frame) or fill the viewport with reasonable margins (desktop / browser frame).
- **No "title" screen** — the prototype IS the artifact; there's no need for a launcher slide.
- Simple animation: CSS transitions or React state. Reach for `animations.jsx` only when motion is *the design* (timeline-based, choreographed entries, hero animations) — see [animated-video](../animated-video/SKILL.md).
- Real-feeling content: avoid lorem ipsum. If real content isn't available, use plausible-but-fake (names from popular open datasets, real product types, real-shaped numbers).

## Anti-patterns

- **Wireframe-grade detail.** If the prototype is meant to demonstrate interaction, every screen has to be *believable*. A wireframe with grey blocks where photos go, "lorem ipsum" headlines, and unbranded buttons fails as a prototype the user can react to.
- **Modal-everywhere navigation.** Pressing a "next" button shouldn't always pop a modal that hides the previous screen. Use real screen transitions (slide left/right for horizontal flows, slide up for modals/sheets, fade for overlays).
- **State that resets on navigation.** If the user clicks "Back", their form data should still be there. Use a single shared state object at the root component, not per-screen `useState`.
- **`window.alert`** for confirmations or feedback. It feels like a developer artifact, not a designed product. Build the confirm/feedback UI inline.
- **Inline event handlers wired to nothing** — every button should do something visible, even if it's just toggling a piece of mock state. A non-functional button breaks the illusion the prototype is trying to create.
