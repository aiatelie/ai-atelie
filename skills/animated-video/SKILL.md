---
name: animated-video
display: Animated video
description: Timeline-based motion design — animated explainer-style HTML artifacts where time advances and elements enter or exit on a schedule. Reach for this when motion IS the design, not a flourish on a static layout.
kind: capability
body_status: reconstructed
sources: []
---

# Animated video

Timeline-based motion design — animated explainer-style HTML artifacts where time advances and elements enter or exit on a schedule. Distinct from interactive prototypes (which are state-driven, not time-driven) and from CSS micro-interactions (which decorate a static layout instead of carrying it).

## When to use this skill

- The user asks for "an animated explainer", "a video", "an animation", "a sequence", "a kinetic title".
- The design's value is mostly in the *timing* (an idea unfolding over seconds, choreographed entries, scene transitions).
- The output will end up exported as a video clip (often via the `export` skill's video capability — MP4 / WebM / Lottie).
- 1920×1080 hero animations, lower-third graphics for video editing, intro/outro sequences, animated logos.

## When this skill does NOT apply

- **Static layout with hover/scroll micro-interactions** → use CSS transitions inside an interactive prototype (see [`interactive-prototype`](../interactive-prototype/SKILL.md)) or directly in the page's CSS.
- **State-driven flows** (click → next screen → modal → success state) → that's an interactive prototype, not motion design. Even if it animates between states, the animation is decorating the state machine, not driving the experience.
- **Single-frame visuals** (banners, posters, thumbnails) → DesignCanvas with one `<DCArtboard>`.
- **Timeline scrubbing of a UI** (showing a user flow as a sequence of screens advancing on a clock) → still better as `interactive-prototype` with auto-advance state, because the user typically wants to *pause and study* a frame.

## Setup

Drop in the canonical `animations.jsx` starter via the MCP server:

```
mcp__starters__copy_starter({ kind: "animations.jsx" })
```

The starter exposes the timeline primitives via `window`:

| Primitive | Role |
|---|---|
| `<Stage>` | Wraps the whole piece. Provides auto-scale to fit the viewport, a scrubber, play/pause keyboard shortcuts. |
| `<Sprite start end>` | Declares the lifetime of an element on the timeline (in seconds). Renders only between `start` and `end`. |
| `useTime()` | Hook returning current timeline position in seconds. Use inside an animated component to drive transforms / opacity / etc. |
| `useSprite()` | Hook returning the local time within a `<Sprite>` (0 at start, `end - start` at end). |
| `Easing` | Standard easing functions (linear, easeIn, easeOut, easeInOut, cubic curves). |
| `interpolate(t, [tStart, tEnd], [vStart, vEnd], easing?)` | Value interpolation between keyframes; clamps outside the range. |
| Entry / exit primitives | `<FadeIn>`, `<FadeOut>`, `<SlideIn>`, `<SlideOut>` — wrap content; declare duration; the rest is automatic. |

Compose by nesting `<Sprite>` (or the entry/exit primitives) inside `<Stage>`. Each `<Sprite>` is responsible for its own children's animation logic via `useSprite()` + `interpolate()`.

## Fallback

Only fall back to a third-party motion library if the starter genuinely can't express the effect. The acceptable fallback is [Popmotion](https://unpkg.com/popmotion@11.0.5/dist/popmotion.min.js) — small, no dependencies, well-documented spring/keyframe API. Avoid GSAP and Framer Motion in this context — both are large and the licensing story for shipping their bundle inside a downloaded export is awkward.

## Defaults

- **1920×1080, 16:9 canvas.** This matches DaVinci Resolve / Premiere / Final Cut import without resampling. Implement JS scaling so the `<Stage>` fits any viewport but renders at native resolution to the export pipeline.
- **No "title" card on the actual page.** The motion piece IS the artifact — the user opens the iframe to *watch the thing*, not to see a launcher slide. Skip the title screen unless it's literally part of the animation.
- **Persist scrubber position to localStorage** so a refresh during iteration doesn't lose the user's playhead. Key by `location.pathname` so multiple animation files in one project don't collide.
- **Default duration: 6–10 seconds.** Most explainer/title-graphic use cases land here. Shorter (2–4s) for stings/idents; longer (15–30s) only when the user explicitly asks.
- **Frame rate: 30 fps for export.** Smoother feels luxurious but doubles export time; 30 is the right balance for most kinetic graphics. Bump to 60 only if the user calls out smoothness specifically.

## Common patterns

- **Scene transitions** — chain two `<Sprite>` with overlapping `start`/`end` so the outgoing sprite fades while the incoming one slides up. Don't gate on hard cuts unless the design wants jarring contrast.
- **Stagger** — when multiple elements enter together (a list, a grid), use `interpolate(useSprite(), [i * 0.08, i * 0.08 + 0.4], [0, 1])` per item with a small per-index offset. Reads as "each element took its turn" rather than "they all arrived at once."
- **Camera moves** — when the whole scene needs to pan/zoom, transform the `<Stage>`'s root container, not individual `<Sprite>`s. Otherwise per-sprite transforms compound oddly.
- **Looping** — set `<Stage loop>` for ambient pieces (logo idents, background ambience). Reset in-sprite state via the `key={loopIteration}` trick so the second loop starts fresh.

## Anti-patterns

- **Animating layout properties** (width, height, top, left). These trigger reflow on every frame and tank the export pipeline's frame rate. Use `transform: translate3d(...)` and `opacity` exclusively.
- **More than 60 simultaneous sprites.** The starter's render loop assumes a manageable scene graph; past ~60 sprites the scrubber stutters and exports get expensive. Compose hierarchically: parent `<Sprite>` containing children, not 60 siblings.
- **Custom easing without intent.** "Bounce" and "elastic" are loud signatures; default to `easeOutCubic` for entries and `easeInQuad` for exits unless the design specifically wants the bounce.
- **Inline JSX with `style={{}}`** computed every frame from `useTime()`. React reconciles these on every tick; allocate the style object outside the JSX or use `useMemo` keyed on the relevant time slice.
- **Hardcoded time values in seconds scattered through component code.** Pull them up to a `TIMELINE` constant at the top of the file (`const TIMELINE = { introStart: 0, introEnd: 1.2, headlineStart: 0.8, … }`) so editing the timing is one place to change, not twenty.

## Pairs naturally with

- [`export`](../export/SKILL.md) — when the user wants the animation as an MP4 / WebM / Lottie file. The export capability runs the timeline through headless Chromium and rasterizes at native resolution.
- [`make-tweakable`](../make-tweakable/SKILL.md) — expose duration, color, copy as tweak knobs so the user can riff on the same animation without re-prompting the agent.
