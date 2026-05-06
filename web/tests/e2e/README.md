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
`gh attach`.

## Naming

`<feature>.spec.ts`. Mirror the surface you're testing — e.g.
`live-preview.spec.ts` for issue #1, `inspector-css.spec.ts` for the
inspector flow.

## Conventions

- Always start at `await page.goto('/')` (the `baseURL` resolves to
  `http://localhost:5173`).
- Prefer role-based selectors (`getByRole`, `getByLabel`) over CSS
  selectors so tests survive markup changes.
- One scenario per file unless they share fixtures.
- Don't test the agent's outputs — test that the surface behaves the
  way the issue's acceptance criteria says it should.
