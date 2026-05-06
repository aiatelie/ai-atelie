# tests/

Black-box integration tests that drive the dev server's HTTP API end-to-end. They're plain Node ES modules — no test framework. Each script:

1. Boots its own scratch state (creates a project, writes synthetic files, etc.).
2. Hits real endpoints on `http://127.0.0.1:4321`.
3. Asserts results with a tiny inline `ok()` helper.
4. Cleans up after itself (deletes the project).

## Prerequisites

The dev server must be running:

```sh
cd web && npm run dev
```

(or whatever port you've configured — the tests assume `4321`).

## Running

```sh
node web/tests/test-multi-turn.mjs       # Claude SDK + session resume across 3 turns
node web/tests/test-tweak-bridge.mjs     # /api/projects/:id/tweak — EDITMODE rewrite
node web/tests/test-inspector-css.mjs    # /api/projects/:id/inspector-css — saved-rules layer
```

Each prints `✓` per assertion and exits 0 if everything passes, 1 otherwise.

## What each one covers

| Script | Endpoint | Verifies |
|---|---|---|
| `test-multi-turn.mjs` | `POST /api/comment-edit` | OAuth/SDK auth resolves to subscription path, claudeSlug matches Claude's actual on-disk session storage, three turns in one session resume cleanly |
| `test-tweak-bridge.mjs` | `POST /api/projects/:id/tweak` | EDITMODE block parsed + merged + atomic write; missing markers → 404; malformed JSON → 422; path traversal → 400; same-value edit → `unchanged: true` |
| `test-inspector-css.mjs` | `POST /api/projects/:id/inspector-css` | Multi-selector + multi-property writes; updates replace prior content; empty value drops a property; static middleware serves the generated CSS with `text/css`; multi-route accumulation in one file |

## Adding new tests

Copy any of the existing files as a template. Conventions:

- Filename: `test-<feature>.mjs`
- Prefix every assertion with `ok(condition, "human label")`
- Always delete the test project at the end (`fetch(`${BASE}/api/projects/${id}`, { method: "DELETE" })`)
- Print a final `✓ ALL CHECKS PASSED` only on the success path
