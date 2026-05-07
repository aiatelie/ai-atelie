# Journeys

Each spec under `web/tests/e2e/journeys/` is one focused user flow. A
journey is a Playwright test (or small group of tests) that proves a
single piece of the canonical AI Atelie experience still works, and
produces inline-renderable evidence for the PR description.

## Catalog

| Spec | Title | Baseline | Approx duration | What it proves |
|---|---|---|---|---|
| `home-loads.spec.ts` | Home loads | ✅ | 2–3 s | App shell paints, create form is interactive. |
| `create-project.spec.ts` | Create project | ✅ | 5–10 s | Name + Create lands in `/editor` with a fresh `p_*` id; project dir exists on disk. |
| `agent-edits-canvas.spec.ts` | Agent edits canvas | ✅ | 3–8 min | The Claude Code agent receives a chat prompt, writes to disk, and the iframe canvas renders the result. |
| `cleanup-snapshot.spec.ts` | Cleanup snapshot | ✅ | <1 s | The `web/projects/` directory contains the same project ids it did before the suite ran (no leak, no collateral damage). |

`@baseline` journeys run on every PR via `bun run journeys`. Per-task
verification specs live elsewhere (under `web/tests/e2e/` directly or
under `.evidence/`).

## Conventions

- Each spec's final assertion is `page.screenshot({ path:
  "test-results/journeys-<id>-final.png" })` so the runner has a
  deterministic image path to upload alongside `video.webm`.
- Selectors prefer `getByTestId(...)` for load-bearing nodes. New test
  ids on production elements ship in the same commit as the journey
  that needs them.
- `test.setTimeout(...)` is set per journey based on the table above.
  The 8-minute timeout on the agent journey is the budget; if the
  agent is consistently slower than that, fix the agent — don't pad
  the budget.
- Journeys that create a project clean it up in their own `finally`
  block and the suite's final `cleanup-snapshot.spec.ts` enforces the
  global guarantee.

## Running

```sh
# Single journey
bunx playwright test web/tests/e2e/journeys/home-loads.spec.ts

# All baseline journeys, with evidence upload to the current PR
bun run journeys

# Dry run — no PR upload, .evidence/ bundle only
bun run journeys -- --no-upload
```

## Evolving a journey

Touching an assertion is a deliberate change. Append an entry to
`web/tests/e2e/CUJ_JOURNAL.md` in the same commit (one journal entry
per assertion change, regardless of which journey).
