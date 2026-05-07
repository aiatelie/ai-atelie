# Accessibility baseline

The legal floor of accessibility plus the craft commitments that go
beyond it. Tokens decide brand appearance; this file decides which
rules an artifact has to clear before it ships.

> Grounded in primary sources: WCAG 2.2 Understanding pages,
> ISO/IEC 40500:2025, ADA Title II 2024 + 2026 IFR, EN 301 549 v3.2.1,
> WAI-ARIA 1.3 + AccName 1.2 + Core AAM 1.2, WebAIM Million 2026
> (February 2026 crawl), APCA W3C silver branch.

## The legal floor changes by jurisdiction

- **EU (EAA, enforcement live 2025-06-28):** EN 301 549 v3.2.1 is
  the OJ-cited harmonised standard; it references **WCAG 2.1 AA**.
  EN 301 549 v4.1.1 (incorporates WCAG 2.2's nine new SCs) is
  OJ-citation-targeted late 2026 / 2027.
- **US public sector — ADA Title II 2024 final rule:** **WCAG 2.1
  AA**. The 2026-04-20 IFR slipped deadlines: 2027-04-26 for
  jurisdictions with population ≥ 50,000; 2028-04-26 for sub-50,000
  and special districts.
- **US federal procurement — Section 508:** harmonised with EN 301
  549 → references **WCAG 2.0 AA** in the current published rev.
- **US private sector — ADA Title III:** no federal regulation
  specifies a technical standard. Settlements and DOJ guidance
  routinely cite **WCAG 2.1 AA** as the de-facto target.
- **ISO/IEC 40500:2025** ratified WCAG 2.2 verbatim in October 2025.

**Practical rule for AI Atelie:** target **WCAG 2.2 AA** as the
working ceiling. It clears the WCAG 2.1 AA legal floor in both
jurisdictions and prepares for v4.1.1. Anything below 2.2 AA is
craft debt.

## Color contrast

| Pair | WCAG 2.x AA minimum |
|---|---|
| Normal text below 18 pt regular / 14 pt bold | 4.5:1 |
| Large text (≥18 pt regular ≈24 px, or ≥14 pt bold ≈18.5 px) | 3:1 |
| Non-text UI components and graphical objects | 3:1 |
| Focus indicator vs adjacent and unfocused state | 3:1 |

Thresholds are **inclusive** — exactly 4.5:1 or 3:1 passes. Don't
round up: 2.999:1 fails.

"Large text" means **18 pt** regular, not 18 px. 18 px regular needs
4.5:1; 14 pt bold (≈18.5 px) qualifies for 3:1, 14 px bold does not.

**Our tokens to audit:**

- `--ink-65` on `--app-bg` (default theme) — passes 4.5:1 ✅
- `--ink-50` on `--app-bg` — fails 4.5:1; restrict to large text or
  iconography
- `--brand-fg` (`#b14a30`) on `--app-bg` — passes 4.5:1 ✅; use this
  for accent text, not `--brand`
- `--brand` on `--app-bg` for text — borderline; reserve for fills
  and large headings

**APCA as a parallel design check.** APCA's Lc value catches
font-weight effects that WCAG 2.x luminance ratios miss. Body copy at
Lc ≥60 is a reasonable parallel pass. APCA is not part of WCAG, EN
301 549, ADA, or Section 508 compliance as of 2026-05 — keep WCAG 2.2
AA as the compliance floor and treat APCA as design-review only.

## Touch targets

| Bar | SC | Size |
|---|---|---|
| AA (legal floor) | 2.5.8 Target Size (Minimum) | **24×24 CSS px** |
| AAA (craft commitment) | 2.5.5 Target Size (Enhanced) | 44×44 CSS px |
| iOS HIG | — | 44×44 pt |
| Material 3 | — | 48×48 dp |

WCAG 2.5.8 lists five exceptions where the 24×24 minimum doesn't
apply: **Spacing**, **Equivalent**, **Inline**, **User agent
control**, **Essential**. The Spacing exception is the one icon-button
toolbars rely on; the others are narrower than they read and shouldn't
be used to justify undersized primary actions.

The card-action buttons on `ProjectCard` (✎ rename, × delete) need to
be at least 24×24 with adequate spacing between them. Audit any new
icon-only button against the 24-CSS-px rule.

## Focus visibility

Removing the focus outline via CSS is a **triple failure**: 1.4.11
Non-text Contrast, 2.4.7 Focus Visible, and 2.4.13 Focus Appearance
(AAA). Use `:focus-visible` for keyboard users; suppress the outline
for mouse clicks only when an alternative non-color affordance exists.

For AAA (2.4.13): indicator area must equal at least a 2 CSS px
perimeter of the component, contrast ≥3:1 between focused and
unfocused states. A 1-px outline at 3:1 doesn't qualify.

Concrete rule for our chrome: every button, link, input, and card
must show a visible `:focus-visible` ring. Use `outline: 2px solid
var(--brand); outline-offset: 2px;` as the default. If the surface
is brand-tinted, switch to `outline-color: var(--ink-92)` to
preserve contrast.

## Form input labels

WebAIM Million 2026: **51% of top 1M home pages have at least one
missing form-input label; 33.1% of all 6.9M inputs are unlabeled.**
The page-level rate moved from 48.2% (2025) to 51% (2026) — missing
labels is one of the few categories rising YoY against an overall
errors-per-page count of 56.1.

Default form-error wiring (WCAG 2.2 + ARIA APG):

```html
<label for="project-name">Project name</label>
<input id="project-name" type="text" required
       aria-describedby="name-hint name-error"
       aria-invalid="true">
<span id="name-hint">Pick something memorable.</span>
<span id="name-error" role="alert">Name must be at least 1 character.</span>
```

`aria-describedby` is the production default; `aria-errormessage` has
incomplete screen-reader support as of 2026-05 — treat as progressive
enhancement.

WCAG 3.3.7 Redundant Entry is **Level A** (legal floor). Re-asking
for data the user already entered "in the same process" fails unless
the surface auto-populates or offers a selectable shortcut. Browser
autofill does not satisfy it.

## Keyboard operability and semantic structure

Visual contrast and labelled inputs don't matter if a keyboard or
screen-reader user can't reach the control or parse the page.

- **Tab reachability** (2.1.1 Keyboard, Level A): every interactive
  element must be reachable and operable via keyboard. `tabindex="-1"`
  removes from the tab order; `tabindex` values >0 break document
  order and should not be used.
- **Activation keys** (2.1.1, Level A): `<button>` activates on
  Enter and Space; `<a href="…">` activates on Enter. A bare `<a>`
  without `href` is not a link, not focusable, and not
  keyboard-operable — use `<a href="…">` for navigation or
  `<button>` for actions, never a placeholder anchor. Custom
  controls must implement the matching key handlers and `role`.
- **No keyboard trap** (2.1.2, Level A): focus must be able to leave
  any component via the same standard keys it entered with. Modal
  dialogs are a focus-trap *by design*, not a violation — they trap
  until dismissed by Escape or the close button. Our
  `NewProjectDialog` and `ConfirmDialog` already support Escape;
  preserve that on every new dialog.
- **Focus order** (2.4.3, Level A): tab order must follow the
  meaningful reading order. Don't rely on positive `tabindex` to fix
  DOM that's out of order; fix the DOM.
- **Native control first**: a `<button>` is keyboard-operable,
  focusable, name-resolvable, and announced as a button by every AT
  for free. `<div role="button" tabindex="0">` requires re-implementing
  all of that and most reimplementations miss `aria-pressed`,
  disabled state, or Space-on-keyup. Reach for ARIA only when no
  native element fits. The `ProjectCard` is a `<div>` with
  `onClick` — it should be promoted to `<button>` or wired with full
  keyboard semantics (Enter / Space, role, focus styling).
- **Document language** (3.1.1, Level A): `<html lang="en">` is
  required. Sub-tree language switches use `lang` on the inner
  element.
- **Heading hierarchy** (1.3.1 / 2.4.6): prefer one `<h1>` per page
  and don't skip levels. Visual size and heading level are
  independent — style the level you mean.
- **Landmarks** (1.3.1, 2.4.1): use `<header>`, `<nav>`, `<main>`,
  `<aside>`, `<footer>` rather than `<div role="banner">` etc. AT
  users navigate by landmark; a page with no landmarks is a wall of
  divs.
- **Text alternatives** (1.1.1): `<img alt="…">` for content images,
  `alt=""` for decorative; `aria-label` on icon-only buttons.

## ARIA discipline

WebAIM Million 2026 shows ARIA pages average **59.1 errors** vs **42**
on non-ARIA pages — about 17 extra errors on the ARIA side. ARIA
deployment outpaces ARIA correctness.

Decision order, per ARIA APG:

1. Native HTML element with the right semantics.
2. Native element under custom visuals if restyling is required.
3. APG pattern verbatim if neither fits.
4. Closest APG pattern + documented deviation. Last resort.

Never invent ARIA.

## Reduced motion and flashing

See `animation-discipline.md` for the full rule set. The
non-negotiable that anchors here: WCAG 2.3.1 (Level A) — flashing more
than three times per one-second period is non-conformant unless the
flash area stays below the general and red flash thresholds.
Photosensitive epilepsy is the protected concern.

## Common mistakes

- "Target Size 44×44" cited as the AA bar. 44×44 is **AAA** (2.5.5).
  AA is **24×24** (2.5.8).
- "18 px = large text" — wrong. Threshold is 18 *pt* regular (~24
  px) or 14 pt bold (~18.5 px).
- "EAA = WCAG 2.2 AA" — wrong. EN 301 549 v3.2.1 is anchored to
  WCAG 2.1.
- "Tabindex fixes focus order" — `tabindex` >0 reorders against DOM
  and almost always makes it worse. Fix the DOM.
- "Modal traps focus → keyboard trap" — confusing 2.1.2. A modal
  trapping focus until Escape / close is correct behaviour, not a
  violation.
- "Heading size = heading level" — visual hierarchy and `<h1>` /
  `<h2>` / `<h3>` are independent.
- "WebAIM Million uses axe-core" — uses WAVE.
- "WCAG 3 will use APCA" — APCA was dropped from WCAG 3 in July 2023.
- "Adding ARIA improves accessibility" — empirically the opposite.
- "Bare `<a>` with click handler is a link" — wrong. `<a>` without
  `href` is not focusable, not keyboard-operable.
- Removing the focus outline via `outline: none` without a
  replacement. Triple failure: 1.4.11, 2.4.7, 2.4.13.
- Placeholder text as the only label for a form input. Fails 1.3.1
  and 3.3.2; placeholder disappears on input.
- Native HTML `<button>` reimplemented as `<div role="button">`
  without keyboard handling, focus, or `aria-pressed`. The
  `ProjectCard` currently does this — fix when the home gets its
  next pass.
