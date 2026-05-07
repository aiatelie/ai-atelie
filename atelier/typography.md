# Typography

Universal typography rules applied on top of AI Atelie's font tokens.
The token layer (`web/src/index.css`) decides *which* fonts; this file
decides *how* they behave at every size.

Token quick reference:

| Role | Token | Default value |
|---|---|---|
| Body sans | `--font-system` | system stack (`-apple-system, system-ui, …`) |
| Code, metadata | `--font-mono` | `JetBrains Mono` |
| Display (when added) | `--font-display` | system stack at larger sizes |
| Body sizes | `--text-xs` … `--text-xl` | 11 / 12 / 13 / 14 / 16 px |
| Weights | `--weight-regular` / `--weight-medium` / `--weight-semi` | 400 / 500 / 600 |

## Type scale

Use a multiplicative scale (1.2 or 1.25). Cap at 6–8 sizes per surface.
Our body sizes already follow this; for display and headings, target:

| Role | Range | Use |
|---|---|---|
| Display | 48–72 px | Onboarding hero, splash, large empty-states |
| H1 | 32–48 px | Page header on a single-purpose route |
| H2 | 24–32 px | Section opener inside a page |
| H3 | 20–24 px | Subsection / dialog title |
| Body | 14–16 px | Default paragraph, panel text |
| Small | 12–13 px | Metadata, secondary chips, footnotes |
| Caption | 11–12 px | Eyebrow labels, micro-status |

Body in our chrome runs at `--text-md` (13 px). That is intentional —
the editor is dense, the dashboard is dense. Don't bump the chrome to
14–16 px because external advice says so. Do use 14–16 px for any
read-the-words surface (release notes, long-form empty states, the
onboarding intro), where reading flow matters more than density.

## Line height (leading)

| Text size | Line height |
|---|---|
| Display / H1 (≥32 px) | 1.0–1.2 (tight) |
| Body (14–18 px) | 1.5–1.6 |
| Chrome (12–13 px) | 1.45–1.5 |
| Small / caption (≤12 px) | 1.4–1.5 |

`html, body` already sets `font-size: var(--text-md)` with the system
default line-height; explicitly set `line-height` on display and
heading rules. Don't rely on inherited 1.0.

## Letter-spacing — the rule that makes or breaks craft

This is the single most-skipped rule in machine-generated UI. **No
exceptions.**

| Context | Letter-spacing |
|---|---|
| Body text (14–18 px) | `0` (default) |
| Small text (11–13 px) | `0.01em` to `0.02em` (positive) |
| UI labels and button text | `0.02em` |
| **ALL CAPS** | **`0.06em` to `0.1em` (required)** |
| Headings ≥32 px | `-0.01em` to `-0.02em` |
| Display ≥48 px | `-0.02em` to `-0.03em` |

ALL CAPS without positive tracking looks cramped and amateur. Display
text without negative tracking looks loose and weak. These two failures
are the most reliable machine-generated tells.

The `0.06em` floor is empirical: print and web typographers converge on
5–10% of the em for caps tracking, and modern screen practice rounds
the lower end to 0.06em. Anything tighter and the counters collide on
screen; the upper bound `0.1em` keeps the word from disintegrating
into letters.

**Concrete audit.** Our brand sub-label "YOUR PROJECTS" on the home
header is ALL CAPS and currently inherits `letter-spacing: normal`.
That is below the floor. Anywhere we render ALL CAPS — section
labels, eyebrows, status pills, kbd hints — must declare
`letter-spacing: 0.06em` or higher. There is no opt-out.

## Font pairing

- Maximum 2 typefaces per artifact (system sans + `JetBrains Mono`,
  or system sans + a single display face for hero copy).
- Always declare a fallback chain. The `--font-system` chain already
  ends in `sans-serif`; preserve that on every override.
- Never set `font-family: system-ui` alone on a heading — that's the
  textbook machine default. Pair it with an intentional first choice
  (`var(--font-display)` once we add display, otherwise the full
  `--font-system` chain).
- Cairo and other webfonts are loaded for retro / themed surfaces only.
  Do not pull in a display webfont for a one-off heading; promote it to
  a token and a theme override or skip it.

## Three-weight system

Most well-crafted UI uses exactly 3 weights. Map ours:

- **Read** — `var(--weight-regular)` / 400 — body copy
- **Emphasize** — `var(--weight-medium)` / 500 — UI text, labels, navigation
- **Announce** — `var(--weight-semi)` / 600 — headlines, primary buttons

700+ is rarely needed. If a design uses bold for "emphasis on emphasis",
it lacks weight discipline elsewhere — the fix is a stronger
read/emphasize contrast or a color decision, not a fourth weight.

## Line length

Limit body copy to **50–75 characters** per line. CSS shortcut:
`max-width: 65ch`. The Onboard route and any future long-form empty
state should clamp; the editor canvas is exempt because the user
controls the canvas width.

## Case usage

- **Sentence case** for buttons, menu items, dialog titles: "New
  project", "Delete project". Title case ("New Project") reads as
  marketing copy and clashes with our chrome.
- **ALL CAPS** for tiny eyebrow labels only ("YOUR PROJECTS",
  "ASSETS", section dividers). With the required `0.06em` tracking.
  Never on body or button labels.
- **lowercase** is fine for kbd hints (`shift + ⏎`) and for
  intentionally-quiet labels in the inspector.

## Numerals

Use `font-variant-numeric: tabular-nums` for any column of numbers
(metric panels, tool-call durations, the project-card "3 tabs · 2h
ago" line). Proportional digits in tables read as misalignment.

## Common mistakes

- ALL CAPS without `letter-spacing: 0.06em+`.
- Display text (≥32 px) without negative tracking.
- More than 3 type sizes visible above the fold.
- Mixed serif and slab on the same screen without a clear role split.
- Body copy in `text-align: justify` (creates rivers; never on the web).
- A heading that uses `font-family: system-ui` directly instead of
  `var(--font-system)` — reads as machine default the first time
  the page loads on Linux.
- Code / metadata in the body sans instead of `var(--font-mono)`.
- Tabular columns in proportional digits.
