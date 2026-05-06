---
name: animated-video
display: Animated video
description: Timeline-based motion design
body_status: stub
sources: []
---

# Animated video

> ⚠️ **STUB** — this is a working theory of the skill body. Replace as the implementation is refined.

## What it's for

Timeline-based motion design — animated explainer-style HTML artifacts where time advances and elements enter/exit on a schedule. Distinct from interactive prototypes (which are state-driven, not time-driven).

## Setup

Start by calling `mcp__starters__copy_starter` with `kind: "animations.jsx"`. It provides:

- `<Stage>` — auto-scale + scrubber + play/pause
- `<Sprite start end>` — declares when an element is alive
- `useTime()` / `useSprite()` hooks — read the current timeline position
- `Easing` — easing functions
- `interpolate()` — value interpolation between keyframes
- Entry/exit primitives

Build scenes by composing `<Sprite>` inside a `<Stage>`.

## Fallback

Only fall back to Popmotion (`https://unpkg.com/popmotion@11.0.5/dist/popmotion.min.js`) if the starter genuinely can't cover the use case.

## Defaults

- 1920×1080, 16:9 default canvas. Implement JS scaling so it fits any viewport.
- Resist the urge to add a "title" card to the actual page. The motion piece is the artifact.
- Persist the playback position to localStorage so refresh doesn't lose place.
