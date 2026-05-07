# e2e/

Browser-driven end-to-end tests using `@playwright/test`. Specs in this
folder are run by the `verify-with-playwright` dev-time skill (and by
contributors verifying changes by hand).

## Prerequisites

```sh
bun run dev   # in another terminal — boots api + web on :5174 / :5173
```

Playwright will reuse an existing dev server (`reuseExistingServer:
true` in `playwright.config.ts`), so don't dual-boot it.

## Running

```sh
bunx playwright test                          # all specs
bunx playwright test web/tests/e2e/foo.spec.ts # one spec
bunx playwright test --headed                 # watch the browser drive
bunx playwright show-report                   # view last HTML report
```

Artifacts:

- `test-results/<spec>/video.webm` — video of every run (config sets `video: 'on'`).
- `test-results/<spec>/trace.zip` — trace, retained on failure.
- `test-results/<spec>/*.png` — screenshots, retained on failure.
- `playwright-report/index.html` — aggregated HTML report.

All four are gitignored. The `verify-with-playwright` skill copies the
relevant ones into `.evidence/<run>/` and uploads them to the PR via
`scripts/upload-evidence.mjs` (GitHub user-attachments CDN — videos
play inline in PR descriptions).

## The journey suite

`journeys/` holds the canonical baseline journeys (home / create /
agent / cleanup) that ship inline-rendering evidence into every PR's
body. See [`journeys/README.md`](./journeys/README.md) and
[`CUJ_JOURNAL.md`](./CUJ_JOURNAL.md). Run with:

```sh
bun run journeys              # full suite + upload to current PR
bun run test:journeys         # full suite, no upload
bun run journeys -- --only home-loads --no-upload  # one journey, local
```

## Naming

`<feature>.spec.ts`. Mirror the surface you're testing — e.g.
`live-preview.spec.ts` for issue #1, `inspector-css.spec.ts` for the
inspector flow. Baseline journeys live under `journeys/<id>.spec.ts`.

## Conventions

- Always start at `await page.goto('/')` (the `baseURL` resolves to
  `http://localhost:5173`).
- For load-bearing UI nodes, prefer `getByTestId(...)` against the
  ids defined alongside the production element. Role-based selectors
  (`getByRole`, `getByLabel`) are the second-best choice; CSS
  selectors and placeholder/text matches are last-resort.
- One scenario per file unless they share fixtures.
- Don't test the agent's outputs — test that the surface behaves the
  way the issue's acceptance criteria says it should.
- Take a deterministic final screenshot at the end of each spec so
  the runner has a stable artifact path to upload.
