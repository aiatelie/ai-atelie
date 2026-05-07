---
name: design-critique
display: Design critique
description: Run a structured anti-slop audit on the design just produced before declaring done. Catches the recognizable AI-default patterns (Tailwind indigo, two-stop trust gradients, emoji-as-icons, generic display fonts, rounded-card-with-left-border, and 20+ more) so they can be fixed before the user sees them.
kind: aesthetic
body_status: original
sources: []
---

# Design critique

A structured audit pass run AFTER the design is generated, BEFORE declaring the work done. The goal: catch the recognizable AI-default patterns (purple gradients, Tailwind indigo, emoji-as-icons, container soup) before the user has to call them out.

## When to use

Run this skill at the end of any non-trivial design generation:
- After `frontend-design` produces a new page or component
- After applying an aesthetic preset and before showing the result
- When the user says "audit this", "is this slop?", "make it less generic"
- Before any final export from the canvas

Skip when:
- The design is a tiny tweak (single property, copy edit) — not worth the audit overhead
- The user explicitly asked for a generic / template look — they're consciously opting in

## How the audit runs

The critique is a **structured walk** through three buckets, in order:

1. **P0 — cardinal sins.** These are the patterns most-cited by reviewers as "this is AI slop." Any P0 hit fails the audit; fix before declaring done.
2. **P1 — soft tells.** Patterns that aren't fatal alone but compound. Two or more P1 hits should be addressed.
3. **P2 — polish opportunities.** Nice-to-fix; flag in the response without blocking.

For each bucket, list every hit with the specific file/line and a fix. Don't say "looks good" without enumerating what was checked.

## P0 — cardinal sins (must fix)

1. **Tailwind indigo as accent.** Exactly `#6366f1`, `#4f46e5`, `#4338ca`, `#3730a3`, `#8b5cf6`, `#7c3aed`, `#a855f7`. The textbook machine tell. **Fix:** pick a single intentional accent that fits the chosen aesthetic; if no aesthetic was committed, run `design-aesthetic-presets` first.
2. **Two-stop "trust" gradient on the hero.** Purple→blue, blue→cyan, indigo→pink. **Fix:** flat surface + intentional type beats it every time. If a gradient is genuinely required, use a mesh (3+ stops) or a single-hue ramp.
3. **Emoji as feature icons.** `✨`, `🚀`, `🎯`, `⚡`, `🔥`, `💡` inside `<h*>`, `<button>`, `<li>`, or `class*="icon"`. **Fix:** monoline SVG icons (1.4–1.8px stroke) using `currentColor`. Or no icon — labels alone often beat emoji.
4. **Generic display fonts.** A page-level hero in Inter / Roboto / Arial / system-ui / Space Grotesk. **Fix:** pick a display face that fits the aesthetic. The aesthetic-presets skill names canonical pairings.
5. **Rounded card with a colored left-border accent.** The canonical generated dashboard tile. **Fix:** drop the radius OR drop the left border, never both together. Better: replace with a different elevation move (top border, no border, full-tint background, top-left corner cut).
6. **Invented metrics.** "10× faster", "99.9% uptime", "3× more productive" with no source. **Fix:** pull from real data, or use a labelled placeholder (`<span data-placeholder>10×</span>`).
7. **Filler copy.** `lorem ipsum`, `feature one / two / three`, `placeholder text`, `sample content`. **Fix:** an empty section is a design problem, not a copy problem — solve with composition, not invented words. Or ask the user for real copy.

## P1 — soft tells (compounds; fix when ≥2)

8. **Accent overuse.** The chosen brand color appears 3+ times in a single screen. **Fix:** cap at 2 visible uses. Hover and focus rings count.
9. **Container soup.** Pills, cards, and chips stacked everywhere with no hierarchy. **Fix:** demote secondary surfaces to typography-only (no background, no border) and reserve container styling for primary content.
10. **Hardcoded hex outside `:root`.** More than ~12 raw hex values in component CSS. **Fix:** add tokens at `:root`, reference via `var(--token)`.
11. **Per-theme overrides in component CSS.** `[data-theme="dark"] .myComponent { ... }` blocks inside a component. **Fix:** push the variation up to the token layer; the component reads `var(--token)` once.
12. **Standard hero → features → pricing → FAQ → CTA sequence with no variation.** **Fix:** introduce at least one unconventional section (full-bleed quote, comparison, mini-product-demo, founder note).
13. **External placeholder image CDNs.** `unsplash.com`, `placehold.co`, `picsum.photos` URLs. **Fix:** use a flat surface or an SVG placeholder (a colored rectangle with the asset name labelled).
14. **ALL CAPS without letter-spacing.** Section labels, eyebrows, status pills in CAPS at default tracking. **Fix:** `letter-spacing: 0.06em` floor for any CAPS at body or smaller; 0.08–0.1em looks better at micro-sizes.
15. **Drop shadow on every card.** Shadow is hierarchy — if everything hovers, nothing does. **Fix:** reserve elevation for popovers, modals, and primary CTAs; flat for the rest.
16. **Justified body text.** `text-align: justify` creates rivers on the web. **Fix:** left-align body, ragged right.
17. **Mixed serif and slab on the same screen without a role split.** **Fix:** assign roles — serif for editorial accents, slab for code, sans for everything else.
18. **Decorative blob / wave SVG backgrounds.** Meaningless geometry. **Fix:** delete it. If atmosphere is needed, use a real gradient mesh, real noise texture, or real photography.
19. **Perfect symmetric layout with no visual tension.** **Fix:** alternate density — one tight section, one breathing — so the page reads as composed.
20. **Section labels in body weight.** Eyebrow labels rendered in default weight, default tracking. **Fix:** uppercase + 11–12 px + `letter-spacing: 0.06em` + a muted tone (60–70% ink).

## P2 — polish opportunities (mention but don't block)

21. **Body in tabular columns using proportional digits.** **Fix:** `font-variant-numeric: tabular-nums` on numeric columns.
22. **Heading uses `font-family: system-ui` directly.** **Fix:** alias to a token (`var(--font-display)`) so the page doesn't read as machine default on Linux first paint.
23. **More than 3 type sizes visible above the fold.** **Fix:** consolidate to a clear scale — display, body, caption.
24. **Display text without negative tracking.** **Fix:** `letter-spacing: -0.01em` to `-0.03em` on display ≥ 32px.
25. **Body line length > 75 characters.** **Fix:** `max-width: 65ch` on long-form body copy.
26. **Same-weight visual hierarchy** (everything bold or everything regular). **Fix:** apply the three-weight system — read (400) / emphasize (500) / announce (600).
27. **Blinking status dot decorations** that don't actually indicate live state. **Fix:** make the indicator real (hooked up to an actual status) or remove it.

## Reporting format

After running the audit, output a structured block:

```
DESIGN-CRITIQUE-RESULT: pass | fail
P0 hits: 0  (or list each: <name> at <file>:<line> — <fix>)
P1 hits: 0  (or list each)
P2 hits: 0  (or list each)
Verdict: <one sentence — what's strong, what to address>
```

If `P0 hits > 0`: do NOT declare the design done. Apply the fixes (in the same response if possible) and re-run the critique on the result.

If `P0 hits = 0` but `P1 hits ≥ 2`: state the trade-off explicitly to the user. They may consciously opt to ship with soft tells.

## Anti-patterns for this skill

- **"Looks good"** without enumerating the checks. The audit's value is the explicit walk, not the verdict.
- **Hand-waving fixes.** "Make it more distinctive" is not a fix; "swap Inter for Editorial New on display" is.
- **Auditing the agent's process.** Don't critique the prompt or the iteration history — critique the artifact.
- **Re-running on a tiny tweak.** The critique is for whole designs; running it on a single-property change is overhead.
