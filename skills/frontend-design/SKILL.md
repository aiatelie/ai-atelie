---
name: frontend-design
display: Frontend design
description: Aesthetic direction for designs outside an existing brand system
body_status: reconstructed
sources:
  - https://claude.com/blog/improving-frontend-design-through-skills
---

# Frontend design

Use this when designing something **outside of an existing brand or design system**. The job is to commit to a bold aesthetic direction instead of defaulting to generic AI-slop output.

## The problem this skill solves

Without explicit aesthetic guidance the model converges on the same look every time: white background, purple gradient, Inter, rounded cards, system blue accent. This is the "AI slop aesthetic" — recognizable, forgettable, and what users complain about.

The skill exists to break that default. **Make creative, distinctive frontends that surprise and delight.**

## Four design vectors

Pick a deliberate position on each — don't average them.

### 1. Typography
Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics.

### 2. Color & theme
Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.

### 3. Motion
Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available.

### 4. Backgrounds
Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, or add contextual effects.

## Anti-slop rules

Avoid:
- Overused font families: Inter, Roboto, Arial, Fraunces, system fonts
- Clichéd color schemes — particularly purple gradients on white backgrounds
- Predictable layouts and component patterns
- Aggressive use of gradient backgrounds (saturated everywhere)
- Emoji unless explicitly part of the brand
- Rounded-corner containers with a left-border accent color
- SVG-drawn imagery for things that should be real assets — use placeholders and ask for materials
- Filler content, dummy stats, decorative iconography that doesn't earn its place

## Reinforcement

You still tend to converge on common choices even with explicit guidance. **It is critical that you think outside the box.** Commit before writing code: pick the aesthetic, name it, then build to it. Don't iterate yourself back into the average.

## Workflow

1. **Commit to a direction first.** Before any code, state the aesthetic position out loud (typography family, color spine, motion vocabulary, background treatment). One sentence each.
2. **Use CSS variables** for all the chosen tokens so the look is consistent and the user can tweak it.
3. **Layer atmosphere.** Backgrounds, gradients, textures, depth — not flat fills.
4. **Verify against the anti-slop list** before calling done.
