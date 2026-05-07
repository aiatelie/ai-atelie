# Color

Universal color rules applied on top of AI Atelie's palette. The token
layer (`web/src/index.css`) supplies the brand orange, ink alpha scale,
surfaces, and semantic colors; this file enforces how to *use* them.

Token quick reference:

| Layer | Tokens |
|---|---|
| Brand (orange) | `--brand`, `--brand-fg`, `--brand-strong-fg`, `--brand-bg`, `--brand-border`, `--brand-hover` |
| Ink (text + overlays) | `--ink`, `--ink-04` … `--ink-92`, `--ink-strong`, `--ink-deep` |
| Surfaces | `--app-bg`, `--surface`, `--surface-2`, `--surface-3`, `--surface-warm` |
| Semantic | `--danger`, `--success`, `--info`, `--warning` (each with `-fg` / `-bg` / `-border` companions) |
| Tool kinds | `--kind-read-*`, `--kind-edit-*`, `--kind-execute-*`, `--kind-fetch-*`, `--kind-search-*`, `--kind-other-*` |

## Palette structure

A coherent palette has four layers. Plan all four before writing CSS.

| Layer | Share of pixels | Tokens |
|---|---|---|
| **Neutrals** | 70–90% | `--app-bg`, `--surface*`, `--ink-*` |
| **Brand** (one) | 5–10% | `--brand` only — never invent a second |
| **Semantic** | 0–5% | `--danger`, `--success`, `--warning`, `--info` |
| **Effect** | <1% | gradients, glows; rarely justified |

If a screenshot of the surface shows brand orange on more than ~10% of
the pixel area, you are in trouble — the eye stops registering it as
the call-to-action and starts reading it as the background.

## Accent discipline

The single biggest readability failure in machine-generated UI is
accent overuse. Hard caps for AI Atelie:

- **At most 2 visible uses of `--brand` per screen.** Typical pair:
  one eyebrow / chip + one primary CTA. Or one brand-bordered card +
  one accent button. Pick a pair, not a flood.
- Hover and focus rings count as accent. If your card already uses
  `--brand` on hover, the page CTA is your second slot — not your
  third.
- Links count as accent unless they are inline body links inside a
  long-form paragraph. Demote inline links to `--ink-92` underline if
  the screen also has a CTA.
- The orange brand mark in the home header counts as one slot; the
  "+ New project" button is the second. We are at the cap before
  any cards render. Audit the page when adding new accent surfaces.

## Ink (text on light surfaces)

The `--ink-XX` family is text *opacity over the warm-black base*, not
arbitrary greys. Always pick by job, not by feel:

| Job | Token |
|---|---|
| Primary body text | `--ink-92` (or `--ink-85`) |
| Secondary text | `--ink-65` to `--ink-70` |
| Tertiary / metadata | `--ink-50` to `--ink-55` |
| Placeholder | `--placeholder` |
| Faint dividers, hairlines | `--ink-08` to `--ink-12` |
| Hover wash | `--ink-04` to `--ink-06` |

Don't mix `--ink-92` and a hardcoded `#222` on the same surface — the
themes will diverge silently when retro or dark is active. Every
hardcoded hex outside `:root` is a bug.

## Contrast minimums

Run these as gates, not goals:

| Pair | Minimum |
|---|---|
| Body text (≤16 px) on background | **4.5:1** |
| Large text (>18 px or 14 px bold) | **3:1** |
| UI components against adjacent surfaces | **3:1** |
| Focus ring against unfocused background | **3:1** |

`--ink-65` on `--app-bg` clears 4.5:1 in default theme; in dark theme
the ink family flips to a bright cream and again clears. Re-check when
proposing new ink stops or re-tinting `--app-bg`.

When the brand color clashes with the surface (low-contrast on a warm
cream), use `--brand-fg` (`#b14a30`) for text instead of `--brand`
(`#d97757`). The brand-bright variant is for fills and hover washes,
not type.

## Themes

We ship three: default (warm cream), retro (cream + navy + orange),
dark (warm black). All three remap the same token names; component
CSS reads tokens, never hex.

- Avoid pure black and pure white. Default uses `#0f0c08` ink, retro
  uses `#1C223A` navy, dark uses `#14110d` for `--app-bg`. Pure
  white / pure black both vibrate against the warm cream and the
  warm black.
- On dark surfaces, prefer **semi-transparent white borders**
  (`var(--on-ink-08)`) over solid darker greys. A 1px `rgba(255,
  255, 255, 0.08)` reads as structure without adding noise.
- Brand orange stays brand orange across themes — only the variants
  shift (default `#d97757`, retro `#F44E1C`, dark `#e88d6f`). That
  consistency is intentional; do not introduce a per-theme accent.

## Semantic naming

Always name new tokens by **purpose**, never by hue:

```css
/* good */
--brand: #d97757;
--success: #34c759;
--kind-read-fg: var(--success-fg);

/* bad — locks us out of theming and re-mapping */
--orange-500: #d97757;
--green-500: #34c759;
```

If you need a new color (a status that isn't covered by danger /
success / warning / info), add it to `:root` and mirror it in
`[data-theme="retro"]` and `[data-theme="dark"]` in the same PR.
A token that exists in only one theme is a bug — the moment a user
toggles, the chrome breaks.

## Anti-defaults

- **Tailwind indigo `#6366f1`** is the most reliable machine-generated
  tell. We use brand orange. If you find yourself reaching for a
  different blue/purple accent, audit the surface — the CTA should be
  `--brand`, the link should be `--ink-92` underline, and that is
  the pair.
- **Two-stop "trust" gradient** (purple → blue, blue → cyan, etc.)
  on a hero is the second most reliable tell. A flat surface +
  intentional type beats it every time. Decorative gradients with
  no functional purpose belong in the trash; use a gradient only to
  separate hierarchies (header → body, primary CTA → secondary).
- **Rounded card with a colored left-border accent.** The canonical
  generated dashboard tile shape. Drop the radius or drop the left
  border, never both together.
- **Per-theme color decisions in component CSS.** If a component reads
  `[data-theme="dark"] .foo { color: white }`, the theming layer
  has been bypassed. Add the token, don't conditional in components.

## Tool-call kind palette

The chat sidebar's tool chips use the `--kind-*` family, composed from
semantic tokens so theming flows through automatically. Read order
when adding a new tool chip:

1. Pick the matching kind for the tool's verb (read / edit /
   execute / fetch / search / other) using the mapping in
   `web/src/lib/toolKind.ts`.
2. Use `var(--kind-<kind>-bg)`, `-border`, `-fg` — never hardcode.
3. If the verb genuinely doesn't fit any of the six, ship it as
   `other` first, then propose a new kind in a follow-up PR (not
   inline). A new kind needs a default-theme value, a retro value,
   and a dark value.
