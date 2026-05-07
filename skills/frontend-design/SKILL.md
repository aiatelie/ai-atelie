---
name: frontend-design
display: Frontend design
description: Aesthetic direction for designs outside an existing brand system
body_status: reconstructed
sources:
  - https://claude.com/blog/improving-frontend-design-through-skills
---

# Frontend design

Build production-grade frontend interfaces with a bold, distinctive point of view. The user provides requirements — a component, a page, an interactive experience — and the job is to design and build something that's not just competent, but striking and memorable.

## When to use this skill

Use this when there's no existing brand or design system to defer to. Without explicit aesthetic direction the model converges on the same look every time: white background, purple gradient, Inter, rounded cards, system-blue accent. Break that default by committing to a clear direction up front and executing it with precision.

If the user has provided a `DESIGN.md` at the project root, follow that direction first. This skill is the fallback when no spec is present.

## Commit before coding

Before writing any code, decide:

- **Purpose** — what problem this interface solves and who uses it.
- **Tone** — pick one direction and commit. Use these as starting points to surpass, not destinations to land on: brutally minimal, maximalist chaos, luxury/refined, lo-fi/zine, dark/moody, soft/pastel, editorial/magazine, brutalist/raw, retro-futuristic, handcrafted/artisanal, organic/natural, art-deco geometric, playful/whimsical, industrial/utilitarian. The final design should feel singular — every detail in service of one cohesive idea.
- **Constraints** — the technical envelope: framework, performance budget, accessibility level.
- **Differentiation** — name the one thing someone will remember about this design.

Bold maximalism and refined minimalism both work. The variable that matters is **intentionality**, not intensity. Pick a direction and execute it vigorously.

## Aesthetic guidelines

**Typography.** Typography carries the design's voice. Choose fonts with personality. Default fonts signal default thinking — skip Arial, Inter, Roboto, Space Grotesk, system stacks. Display type should be expressive, even risky. Body text should be legible and refined. Pair display and body like actors in a scene. Work the full range — size, weight, case, letter-spacing — to establish hierarchy.

**Color and theme.** Take a position. Bold and saturated, moody and restrained, or high-contrast and minimal — pick one. Lead with a dominant color, punctuate with sharp accents. Avoid timid, evenly-distributed palettes that hedge. Use CSS variables so the position stays consistent across the surface.

**Motion.** Use animation for effects and micro-interactions. Prefer CSS-only solutions for HTML; reach for the Motion library when in React. Concentrate effort on high-impact moments — one well-orchestrated page-load with staggered reveals creates more delight than scattered micro-interactions everywhere. Use scroll-triggered and hover states that surprise.

**Spatial composition.** Unexpected layouts. Asymmetry. Overlap and z-depth. Diagonal flow. Grid-breaking elements. Dramatic scale jumps. Full-bleed moments. Generous negative space — or controlled density. Commit to one extreme.

**Backgrounds and visual detail.** Create atmosphere and depth instead of defaulting to solid fills. Layer effects that match the chosen aesthetic: gradient meshes, noise and grain, geometric patterns, layered transparencies and glassmorphism, dramatic or soft shadows and glows, parallax depth, decorative borders, clip-path shapes, print-inspired textures (halftone, duotone, stipple), knockout typography, custom cursors.

## What to avoid — and what to do instead

NEVER use generic AI-generated aesthetics. That means:

- Overused font families (Inter, Roboto, Arial, Space Grotesk, system stacks)
- Clichéd color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter designs that lack context-specific character
- Filler content, dummy stats, decorative iconography that doesn't earn its place
- SVG-drawn imagery for things that should be real assets — use placeholders and ask the user for materials
- Rounded-corner containers with a left-border accent color
- Aggressive saturated gradients used everywhere
- Emoji unless explicitly part of the brand

INSTEAD: distinctive fonts. Bold, committed palettes. Layouts that surprise. Bespoke details. Every choice rooted in the specific context of this design.

## Match the code to the vision

Maximalist designs need elaborate code — extensive animation, layered effects, dense composition. Minimalist or refined designs need restraint, elegance, and precision. Both need careful attention to spacing, typography, and subtle detail. Excellence comes from executing the chosen vision well — not from picking a safe middle.

Build creatively on the user's intent. Make unexpected choices that feel genuinely designed for the context. Actively explore the full range — light and dark themes, unusual font pairings, substantially varied directions. Let the specific context drive choices, not familiar defaults.
