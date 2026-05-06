---
name: create-design-system
display: Create design system
description: Skill to use if user asks you to create a design system or UI kit
body_status: stub
sources: []
---

# Create design system

> ⚠️ **STUB** — this is a working theory of the skill body. Replace as the implementation is refined.

## What we know about it

- It's the skill to invoke when the user asks for a design system or UI kit.
- The skill pairs with an asset-registration mechanism that groups outputs into: **Type, Colors, Spacing, Components, Brand** — that's the section taxonomy this skill produces against.

## Working theory of the body (to be replaced)

1. Ask questions (typography direction, palette mood, scale, density, what components are in scope).
2. Produce a tokens file (`tokens.css` or similar) with CSS custom properties for: type scale, color ramps, spacing scale, radii, shadows.
3. Produce one HTML preview file per group (Type, Colors, Spacing, Components, Brand), each registered with `register_assets({ asset, group, viewport })`.
4. Build an index page that pulls them all together.
5. Tweakable knobs for the primary token values so the user can riff.

## TODO

- Replace this stub with the real skill body once captured.
