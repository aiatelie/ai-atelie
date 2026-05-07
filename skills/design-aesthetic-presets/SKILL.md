---
name: design-aesthetic-presets
display: Aesthetic presets
description: Pick one of eleven named aesthetic directions before writing any code, then execute it with discipline. Forces commitment to a specific look so output stops converging on the AI-default white-purple-Inter aesthetic.
body_status: original
sources: []
---

# Aesthetic presets

A menu of eleven named aesthetic directions, each with concrete CSS hooks, font roles, and motion vocabulary. Use this skill when the user asks for "something distinctive" without naming the direction, or when `frontend-design` fired and you need to pin down which direction to execute.

## How to use

1. **Pick one preset** that fits the brief. State the choice in one sentence to the user before writing code. ("Going with brutalist — heavy black borders, cold neutrals, monospace display.")
2. **Don't blend.** Two presets at once dilutes both. If the brief seems to mix, ask which dominant.
3. **Execute the recipe.** Each preset below names the type vocabulary, palette spine, motion register, and detail moves. Apply them — don't shop around.
4. **Add one signature.** The list gives you the floor; pick one detail (a custom cursor, a specific micro-interaction, an unexpected proportion) that's yours.

## The presets

### 1. Swiss / Bauhaus minimalism
- **Essence.** Grid-true, asymmetric, type-led. Information hierarchy via size and space, not decoration.
- **Type.** Display: Helvetica Now Display, Neue Haas Grotesk, Inter Tight (only here, in display weight, with deliberate negative tracking). Body: Helvetica, Neue Haas, system grotesk.
- **Palette spine.** Single accent color (red is canonical, any saturated primary works) on `#fafafa` or `#f5f5f5`. Black and a single grey.
- **Motion.** None or near-none. Hovers shift opacity 4-8% only. No transitions on layout.
- **Detail moves.** Heavy diagonal grid lines, oversized numerals, type that bleeds off the edge, footnote-sized eyebrow labels.

### 2. Neumorphism (use sparingly — easy to ship as slop)
- **Essence.** Soft, plastic, embossed. Two opposing shadows (light + dark) on the same monochrome surface.
- **Type.** SF Pro, Inter, or any rounded grotesque. Mid-weight only — bold reads wrong.
- **Palette spine.** Single hue at low saturation as the surface; no contrast against bg. Add ONE bright accent for primary action.
- **Motion.** Press states are required — invert the shadow direction on click.
- **Detail moves.** All radii ≥ 16px. No hard borders ever. Cards are always elevated or inset, never flat.
- **Failure mode.** Overuse — every component as a neumorphic card looks like the default tutorial. Use neumorphism for primary CTAs only; flat for the rest.

### 3. Glassmorphism
- **Essence.** Frosted blur over a vivid backdrop. Depth via translucency, not shadow.
- **Type.** Crisp grotesque (Inter is forbidden but Söhne, Haffer, Aeonik work). Light-to-medium weight.
- **Palette spine.** Vivid gradient (purple→pink, teal→orange, etc.) as the unblurred backdrop. Frosted layers at 12–18% white opacity with `backdrop-filter: blur(20px) saturate(180%)`.
- **Motion.** Subtle parallax on the backdrop, gentle blur ramp on hover.
- **Detail moves.** 1px white inner border (`box-shadow: inset 0 0 0 1px rgba(255,255,255,0.4)`), minimal outer shadow, no solid fills.

### 4. Brutalism / raw web
- **Essence.** Unconcerned with prettiness. Raw HTML look elevated. Confronts.
- **Type.** Mono display (JetBrains Mono, IBM Plex Mono) or aggressive grotesque (Druk, Migra, Pangram Sans Compact). System-default body is fine — even desirable.
- **Palette spine.** Two colors: black on cold white, or one saturated single (yellow, red, lime) on black. Borders are 2-4px solid black.
- **Motion.** None or instant snap-cuts.
- **Detail moves.** Visible grid lines, naked input fields with thick black borders, monospace tabular data, asymmetric headlines that break the column.

### 5. Claymorphism
- **Essence.** Plastic toys, rendered in CSS. Flat shadows, rounded everything, candy palettes.
- **Type.** Geometric rounded (Quicksand, Nunito, DM Sans). Body weight only — no italics, no thin.
- **Palette spine.** Three high-saturation candy colors (pink + blue + yellow is canonical; try lime + magenta + cyan for variety). Bg is off-white or dust-pink.
- **Motion.** Bouncy springs (`cubic-bezier(.68,-0.55,.27,1.55)`). Cards lift and tilt 2-3 degrees on hover.
- **Detail moves.** Radii ≥ 24px. Soft shadows offset down-right (`box-shadow: 8px 8px 0 rgba(0,0,0,0.08)`). Inline emoji-like SVG icons (custom, never platform emoji).

### 6. Aurora gradients
- **Essence.** Northern-lights mesh gradients, soft glowing edges, midnight surfaces. Premium SaaS energy.
- **Type.** Sleek grotesque (General Sans, GT Walsheim, Söhne). Tight letter-spacing on display.
- **Palette spine.** Mesh of teal, indigo, magenta on a near-black `#0a0a0e` background. Text in soft white (`#f5f5f0`), accents in vivid neon.
- **Motion.** The mesh moves slowly behind content (CSS `@keyframes` rotating a hue or repositioning a gradient stop over 20-40s).
- **Detail moves.** Glow-edge buttons (`filter: drop-shadow(0 0 20px <accent>)`), thin 0.5px borders at low opacity, semi-transparent panels with soft bottom-fade.

### 7. Cyberpunk / neon noir
- **Essence.** Dystopian neon. Sharp angles. Glitch.
- **Type.** Mono display + heavy condensed sans (Druk Wide, Anton, Bebas Neue). Cyrillic or Japanese accents if appropriate.
- **Palette spine.** Black or `#0d0419` purple-black bg. Two neons in tension: cyan + magenta is canonical, lime + pink for variety. NO blue + purple — that's the AI default.
- **Motion.** Glitch transitions (RGB channel split, scanline overlays), abrupt cuts.
- **Detail moves.** Clip-path angles on cards, scanline backgrounds (1px tall lines at 8% opacity), terminal-style cursors that blink, ALL CAPS with high tracking, ASCII art or block characters as decoration.

### 8. 3D hyperrealism
- **Essence.** Photoreal 3D objects (Spline, Rive, or pre-rendered) anchoring otherwise flat layouts.
- **Type.** Clean sans (Inter Tight is fine here, in display weight only). Body: Inter Display.
- **Palette spine.** Off-white bg, single dramatic accent (often the dominant color of the 3D object). Use the 3D render as the visual hero — UI recedes to support it.
- **Motion.** The 3D rotates or floats (Spline embed); UI stays still.
- **Detail moves.** Generous whitespace around the 3D, subtle drop shadows on the object, callout labels in body weight pointing at object features.

### 9. Maximalist / zine
- **Essence.** Everything everywhere all at once. Layered. Loud.
- **Type.** Three or more distinct faces in tension — display serif + display sans + monospace. Italic frequently.
- **Palette spine.** Five+ colors, often clashing. Decorative use of saturated complementaries. NO timid neutrals.
- **Motion.** Every element animates on entry. Hovers add an effect, not just a state change.
- **Detail moves.** Stickers, washi-tape, drop-cap initials, marquee scrollers, polaroid frames, tab dividers, footnote symbols (†, ‡, §) used as ornament.

### 10. OLED luxury (dark luxury)
- **Essence.** Deep black + gold + a single jewel accent. Think haute fashion editorial.
- **Type.** Display serif (Editorial New, Migra, GT Sectra). Body: Söhne, Haffer, or another quiet grotesque.
- **Palette spine.** True `#000` (OLED) or near-black `#0a0a0a`. Soft cream text (`#e8e2d8`), gold accent (`#c8a557`), one jewel tone (deep ruby, emerald, sapphire).
- **Motion.** Slow fades, no bounces. Every transition ≥ 600ms with a generous easing (`cubic-bezier(0.4, 0, 0.2, 1)`).
- **Detail moves.** Hairline 0.5px gold dividers, generous line-height on display serif, type set wide (positive tracking on display), full-bleed product photography.

### 11. Biomorphic / organic
- **Essence.** Soft, irregular, hand-drawn or SVG-organic shapes. Clip-path blobs replace rectangles.
- **Type.** Humanist sans or warm serif (Untitled Sans, Recoleta, GT Alpina). Italics common.
- **Palette spine.** Earthy or botanical — moss + clay + bone, or bloom palette of dusty pinks/greens/yellows. NO pure black, NO pure white.
- **Motion.** Gentle wobble, slow morph between shapes, hand-drawn-feeling springs.
- **Detail moves.** SVG blob backgrounds (real, not the slop-tier wave), squiggly underlines, hand-drawn icons, off-axis layouts.

## When this skill does NOT apply

- The user has a `DESIGN.md` at the project root — follow that.
- The user named a brand to match (Stripe, Linear, Vercel) — pull that brand's specific tokens, not a generic preset.
- The work is operational chrome (toolbar, settings, infrastructure UI) — that wants restraint, not commitment to a maximalist preset.

## Anti-patterns

- **Picking by safety.** "Swiss" because it's hardest to mess up — but the result is sterile. Pick the preset that fits the brief, not the one that minimizes risk.
- **Half-committing.** Brutalist with rounded corners. Maximalist with one font. Pick a preset and execute the floor, not just the surface.
- **Mixing presets.** Glassmorphism + claymorphism in the same view reads as confusion. If you genuinely need two registers (e.g. a maximalist hero and minimalist body), make the transition deliberate, named, and once.
