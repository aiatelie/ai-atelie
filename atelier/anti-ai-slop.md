# Anti-slop

Concrete, checkable rules that distinguish "designed by a human who
ships product" from "default machine output." Several rules below are
auto-enforced by lint — failing an enforced rule is a regression, not
a style preference. The rest are guidance for agents and reviewers
and are flagged inline as "(guidance, not auto-checked)" so the
contract with the linter stays honest.

## The seven cardinal sins

These are the patterns the linter blocks at P0 (must-fix):

1. **Default Tailwind indigo as accent** — exactly `#6366f1`,
   `#4f46e5`, `#4338ca`, `#3730a3`, `#8b5cf6`, `#7c3aed`, `#a855f7`.
   We use `var(--brand)` (Anthropic / Claude orange). Indigo is the
   textbook machine tell.

2. **Two-stop "trust" gradient on the hero** — purple→blue,
   blue→cyan, indigo→pink. A flat `var(--app-bg)` surface +
   intentional type beats this every time.

3. **Emoji as feature icons** — `✨`, `🚀`, `🎯`, `⚡`, `🔥`, `💡`
   inside `<h*>`, `<button>`, `<li>`, or `class*="icon"`. Use
   1.4–1.8px-stroke monoline SVG with `currentColor` (matches our
   inline-SVG icon convention).

4. **Sans-serif on display when the surface should use display
   weight.** A page-level hero like Onboard.tsx must use the
   declared display token, not a hardcoded `Inter` / `Roboto` /
   `system-ui`. (Add a `--font-display` token before reaching for
   a webfont in a single component.)

5. **Rounded card with a colored left-border accent.** The canonical
   generated dashboard-tile shape. Drop either the `border-radius`
   or the colored left border; never both together.

6. **Invented metrics** — "10× faster", "99.9% uptime", "3× more
   productive". Either pull from a real source or use a labelled
   placeholder.

7. **Filler copy** — `lorem ipsum`, `feature one / two / three`,
   `placeholder text`, `sample content`. An empty section is a
   design problem to solve with composition, not by inventing words.

## Soft tells (P1 — should fix)

- **`var(--brand)` used 3+ times in one screen** — see
  `color.md`. Cap is 2 visible uses. Hover and focus rings count.
  *(guidance unless promoted to lint)*
- **More than ~12 raw hex values outside `:root`.** Tokens were not
  honoured. Find the closest token, or add a new one in
  `web/src/index.css` and mirror it in retro + dark.
- **Standard "Hero → Features → Pricing → FAQ → CTA" sequence with no
  variation** *(guidance, not auto-checked)*. We don't ship a marketing
  site today — but if we do, introduce at least one unconventional
  section (full-bleed quote, comparison-against-status-quo, embedded
  mini-product-demo).
- **External placeholder image CDNs** (`unsplash.com`, `placehold.co`,
  `picsum.photos`). Fragile and obvious. Use our placeholder
  conventions — for the canvas, the file-system manifest; for chrome,
  a flat surface.
- **Per-theme `[data-theme="dark"] .foo { … }` overrides in component
  CSS** — see `color.md`. Add the token at the root level instead.

## Polish tells (P2 — nice to fix)

- **Decorative blob / wave SVG backgrounds** *(guidance, not
  auto-checked)*. Meaningless geometry.
- **Perfect symmetric layout with no visual tension** *(guidance, not
  auto-checked)*. Alternating density (one tight section, one
  breathing section) reads as intentional.
- **Drop shadow on every card.** Shadow is hierarchy; if everything
  hovers, nothing does. Use `var(--shadow-card)` for cards,
  `var(--shadow-pop)` for elevated controls (popovers, dropdowns),
  `var(--shadow-deep)` for modals.
- **Section labels in body weight.** Labels like "YOUR PROJECTS",
  "ASSETS", "RECENT" should be uppercase + 11–12 px +
  `letter-spacing: 0.06em` + `var(--ink-65)`. See `typography.md`.

## How to add soul without breaking the rules

Aim for **~80% proven patterns + ~20% distinctive choice**. The 20%
should live in:

- One bold visual move — a typography choice (e.g. the brand mark's
  diamond shape), a single color decision, an unexpected proportion.
- Voice and microcopy — a button that says "Start a project" beats
  one that says "Get started". An empty state that says "A project
  is a workspace for one banner system or design exploration" beats
  "No projects yet."
- One micro-interaction the user will remember — a button press that
  moves 2px, a number that counts up on update, a card whose tabs
  list shimmers on rename.
- One detail that could only have been put there by someone who used
  the product — a kbd shortcut hint in the composer footer, a status
  badge that uses our actual tool-kind language ("read · edit ·
  execute · fetch"), the "Local-first · stored on disk" footer chip.

If a reviewer screenshots the surface and someone outside the project
can identify which product it's from — you have soul. If not, you
shipped a template.

## Specific things to check on every PR that touches chrome

- Is `var(--brand)` used twice or fewer in the rendered screenshot?
- Are all hex values inside `:root` (or one of the `[data-theme]`
  blocks)?
- Are ALL CAPS labels at `letter-spacing: 0.06em` or higher?
- Is there a non-populated state (loading, empty, error) for any
  surface that fetches or lists data?
- Does the surface render the same in retro and dark themes (toggle
  via `data-theme` and check)?
- Does any new motion respect `prefers-reduced-motion`?
- Is every interactive control reachable by Tab and operable by
  Enter / Space?
