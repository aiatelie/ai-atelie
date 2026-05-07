# Atelier — AI Atelie's craft rulebook

Universal UI craft rules for AI Atelie. Each file is a small, dense
rulebook on one dimension of professional UI craft (typography, color,
motion, …). The design tokens in `web/src/index.css` decide *what* the
brand looks like; this folder decides *how* a competent designer uses
them.

## Why this folder exists

Three axes shape every artifact we ship:

| Axis | Where it lives | Example |
|---|---|---|
| **Tokens** | `web/src/index.css` (`:root` + `[data-theme]`) | `--brand: #d97757`, `--text-md: 13px` |
| **Components** | `web/src/components/**` | `ProjectCard`, `ChatComposer`, `Inspector` |
| **Craft** | `atelier/**` (this folder) | "ALL CAPS always needs ≥0.06em tracking" |

Tokens tell the agent which colors and fonts AI Atelie uses. The atelier
tells the agent the universal rules a competent designer applies on top
— rules that are true regardless of which theme is active.

## Files

| File | Section name | When it applies |
|---|---|---|
| [`typography.md`](./typography.md) | `typography` | Any surface that emits typed content (≈all of them) |
| [`color.md`](./color.md) | `color` | Any surface that emits styled output (≈all of them) |
| [`anti-ai-slop.md`](./anti-ai-slop.md) | `anti-ai-slop` | Marketing pages, landing pages, decks, the home dashboard |
| [`state-coverage.md`](./state-coverage.md) | `state-coverage` | Any stateful UI: dashboards, tables, lists, the project grid, the chat panel |
| [`animation-discipline.md`](./animation-discipline.md) | `animation-discipline` | Any surface that ships motion: panels, dialogs, tab transitions, drag-reorder |
| [`accessibility-baseline.md`](./accessibility-baseline.md) | `accessibility-baseline` | Any interactive UI: dialogs, the composer, project cards |
| [`form-validation.md`](./form-validation.md) | `form-validation` | Any surface with an interactive form: NewProjectDialog, future settings |
| [`rtl-and-bidi.md`](./rtl-and-bidi.md) | `rtl-and-bidi` | Any localized text or layout — for the day we ship Arabic / Hebrew / Persian |

## How rules flow into agents

Skills under `.claude/skills/` may opt into atelier sections via a
`craft.requires` array in their front-matter:

```yaml
craft:
  requires: [typography, color, anti-ai-slop]
```

Allowed values match the file names in this directory minus the `.md`
extension. Unknown values are silently ignored — a skill can list a
planned slug and start benefiting the moment a follow-up PR vendors the
matching `atelier/<slug>.md`. The cost of a missed reference is a
missing paragraph in the system prompt, not a broken skill.

## Enforcement levels

Atelier files mix auto-checked rules and guidance.

- **Auto-checked.** The P0 list in `anti-ai-slop.md` (Tailwind indigo as
  accent, two-stop hero gradients, emoji-as-icons, lorem ipsum, etc.)
  is wired into our lint surface. Failing one is a regression, not a
  style preference.
- **Guidance.** The rest. The agent reads the rules, reviewers apply
  them, the linter doesn't check them.

A purely behavioral file (`state-coverage`, `animation-discipline`) is
guidance unless a specific rule is later promoted into the linter.

## Style we expect

- Lead with the rule, not the rationale. The reader wants the floor
  first, the *why* second.
- Cite primary sources where they exist. WCAG SC numbers, Material
  motion tokens, Bringhurst page references. Anchor opinions to
  measurable bars; flag opinion as opinion.
- Reference our actual tokens, not generic ones. `var(--brand)`,
  `var(--ink-65)`, `var(--text-md)` — not `var(--accent)` or
  `text-sm`. The point of a tailored rulebook is that it tells you
  exactly which token to reach for.
- Imperative voice. "Use logical properties on the inline axis." Not
  "you might consider using…".
