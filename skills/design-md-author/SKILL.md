---
name: design-md-author
display: DESIGN.md author
description: Read or write a Google-spec DESIGN.md at the project root — the cross-tool aesthetic spec that grounds every prompt in this project. Use when the user asks to capture, update, or import a design system, or when starting a project that should have a documented aesthetic direction.
body_status: original
sources:
  - https://github.com/google-labs-code/design.md
---

# DESIGN.md author

Read, write, or update a `DESIGN.md` at the project root. `DESIGN.md` is the Google-Labs-published cross-tool spec for documenting a design system: tokens, typography, components, motion, do's-and-don'ts. When present, it grounds every subsequent prompt in this project — the agent reads it as project-context before generating UI.

## When to use

- The user asks to "set up the design system", "create a DESIGN.md", "import this design system", "capture our look".
- A project doesn't have a `DESIGN.md` yet and the user wants to commit to a direction once instead of re-deciding per prompt.
- The user wants to import a DESIGN.md from elsewhere (a Stitch export, a community gallery, another project).
- The user wants to update tokens, typography rules, or component specs declared in the project's existing `DESIGN.md`.

Skip when:
- The user is generating a one-off design — `DESIGN.md` is for projects with continuity, not single artifacts.
- The change is implementation, not specification. (Component code changes go through `frontend-design`; the DESIGN.md only changes when the *spec* shifts.)

## The schema (Google spec)

A valid `DESIGN.md` has YAML front-matter and a fixed set of markdown sections in order. Every section is required.

```yaml
---
version: "0.1.0"
name: "Project name"
description: "One-sentence aesthetic direction."
colors:
  bg: "#hex"
  surface: "#hex"
  ink: "#hex"
  brand: "#hex"
  # … semantic tokens, named by purpose
typography:
  display: "Font Name, fallback"
  body: "Font Name, fallback"
  mono: "Font Name, fallback"
rounded:
  none: "0"
  sm: "4px"
  md: "8px"
  lg: "16px"
spacing:
  unit: "4px"
  scale: [0, 1, 2, 3, 4, 6, 8, 12, 16, 24]
components:
  button:
    primary:
      bg: "{colors.brand}"
      ink: "{colors.bg}"
    # … per-component variants
---
```

Token references use `{path.to.token}` so semantic relationships survive when individual values change.

Required markdown sections, in this order:

1. `## Overview` — the aesthetic direction in 2–4 paragraphs. What feeling, what posture, what's the differentiation.
2. `## Colors` — semantic role per color, with hex and a one-line use-case. Reference front-matter tokens.
3. `## Typography` — display vs body vs mono roles, the type scale, tracking rules, letter-spacing floors.
4. `## Layout` — grid system, spacing scale, breakpoints, content max-widths.
5. `## Elevation & Depth` — shadow tokens, when to use which.
6. `## Shapes` — radii, border weights, decorative elements.
7. `## Components` — per-component spec: button, card, input, dialog, navigation, etc. Each with state variants (default, hover, active, disabled, error).
8. `## Do's and Don'ts` — the project-specific anti-patterns, paired with what to do instead.

## Authoring flows

### From scratch

1. Ask the user for the aesthetic direction — name a tone (or invoke `design-aesthetic-presets` to pick one).
2. Ask for any constraints — required brand colors, fonts the user is licensed for, accessibility targets.
3. Generate a complete `DESIGN.md` with all 8 sections filled in. Use the chosen aesthetic to drive concrete values, not placeholders.
4. Save to `DESIGN.md` at the project root.
5. Update the project manifest's `design.design_md` field to `"DESIGN.md"` so the API picks it up.

### From an imported spec

1. Read the imported file. Validate it has the 8 required sections.
2. If sections are missing, list them and ask the user whether to fill in defaults or stop.
3. Save the validated content to `DESIGN.md` at the project root.
4. Run a contrast check on the color tokens (WCAG AA: 4.5:1 body, 3:1 large) and surface any failures before declaring done.

### From a codebase (reverse engineer)

1. Scan the project's existing CSS for tokens, fonts, and components.
2. Cluster related values (e.g. all the colors used → propose semantic roles; all the radii → propose `none/sm/md/lg`).
3. Generate a draft `DESIGN.md` and present it for user review BEFORE writing.
4. Iterate on the user's feedback, then commit.

### Updating an existing DESIGN.md

1. Read the current `DESIGN.md`.
2. Identify which section(s) the user wants to change.
3. Update only those sections; leave the rest untouched.
4. If a token is renamed or removed, scan the codebase for `var(--<token>)` references and surface them — the user may need to refactor before the new spec ships.

## Reading flows

When `DESIGN.md` is present at the project root, the API prepends its content to the system prompt automatically (see `api/src/services/promptBuilder.ts`). So if you're generating UI inside the canvas, you'll already have the spec in context — your job is to follow it, not to read it again.

If you do need to read it manually (for an audit, an export, or a critique):

1. Read the file.
2. Use the front-matter tokens as the source of truth for color/type/spacing values.
3. Use the markdown sections as the source of truth for *how* tokens combine into components and layouts.

## Hard rules

- **Never silently modify `DESIGN.md`.** It's the project's contract with the user. Show the diff and confirm before writing.
- **Tokens MUST be semantic.** `--brand`, not `--orange-500`. `--surface-elevated`, not `--white-2`. Names by purpose lock in re-skinning later.
- **Every color must pass WCAG AA against its companions.** Body text on background ≥ 4.5:1. Large text ≥ 3:1. Re-check after any color change.
- **The 8 required sections are not optional.** A spec missing one is incomplete — don't ship it as valid.
- **Reference tokens, don't inline values, in the components section.** `bg: "{colors.brand}"`, not `bg: "#d97757"`. The whole point of the spec is that values can change without touching components.

## Compatibility

A Google-spec `DESIGN.md` is consumed by:
- AI Atelie (this project, via `api/src/services/promptBuilder.ts`)
- Claude Code (anywhere `claude` runs in a project root)
- Cursor (via `.cursor/rules` adapter)
- Kiro (via `.kiro/steering/`)
- Windsurf (via `global_rules.md`)
- Stitch (Google Labs)

So a `DESIGN.md` written here travels — the project's aesthetic direction is portable.

## Lint & validate

After writing, validate via `npx @google/design.md lint <path>`. The CLI checks:
- All required sections present in the right order
- All token references resolvable (no `{colors.foo}` where `foo` isn't defined)
- WCAG AA contrast on color pairs
- YAML front-matter parses cleanly

If the lint fails, fix before declaring done.

## Anti-patterns

- **A `DESIGN.md` filled with TODOs or placeholders.** Either the spec is real or it's noise. Ship a complete one with simple values, not an aspirational one with gaps.
- **Aesthetic prose in the spec.** "Modern, minimalist, bold." Words like that are vibes, not specs. The Overview section can be evocative, but the rest is concrete tokens and rules.
- **Re-deriving values per component.** If three components all need a 12px radius, that's `--radius-md` in the front-matter, not three component-level decisions.
- **Editing component values without updating the spec.** If you change a button's primary fill in code, update the spec or the spec is now lying.
