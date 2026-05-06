# Critical User Journey — Change Log

The CUJ is a single test in [`cuj.spec.ts`](./cuj.spec.ts). It is the contract that "the product still does its core job": a user opens the app, creates a project, the Claude Code agent designs into it, the canvas renders the result.

Every PR that **modifies** the CUJ (new step, removed step, weakened or strengthened assertion, changed selector) MUST add an entry here. Append-only, newest on top. Every PR that runs the CUJ unchanged MAY add a "ran-clean" entry for visibility, but it isn't required.

## Format

- **Date / PR**: ISO date and PR number.
- **Change kind**: one of —
  - `created` — first version of the test.
  - `evolved` — flow changed (a real new step or removed step). Most common.
  - `repaired-selector` — same flow, different selector (button rename, role change). No semantic change.
  - `tightened` — assertion got stricter (good).
  - `loosened` — assertion got weaker. **Requires justification + a replacement assertion of equal strength elsewhere**.
  - `ran-clean` — no change to the test; recording the run as a tripwire datapoint.
- **Before → After**: one line each describing what changed at the user-visible level. Skip for `ran-clean`.
- **Why**: link to the feature / issue / PR that drove the change.
- **Proof of value**: how we confirmed the new test still catches a real regression. Examples: "reverted the feature locally; CUJ failed at line N", "manually broke the hex color; assertion #8 caught it". For `ran-clean`: total wall time + any flake notes.

## Triage protocol when CUJ fails

See [`.claude/skills/cuj-guardian/SKILL.md`](../../../.claude/skills/cuj-guardian/SKILL.md) — five-step decision: re-run → locate → diff intersection → intent check → value check.

---

## 2026-05-06 — PR #57 — evolved (file-structure poll → iframe poll)

- **Change kind**: `evolved` (the user-observable assertion is unchanged; the *path* used to detect agent completion shifted).
- **Before**: step 8 polled `<projectDir>/*.jsx` files for a regex match on `#ffffff` + `0a1f3a` + "hello world". Step 9 then asserted iframe text contained both variants.
- **After**: step 8 polls the iframe directly for two "Hello World" instances + light/dark indicators (this is the actual user-observable success state). Step 9 becomes a sanity-check that the agent wrote *something* to disk (not strictly necessary, but kept as a "did anything happen" guard).
- **Why**: PR #57 fixed a project-list race (the editor used to land in the `demo` project after `+ New project`, so the agent never edited the new project's files). With the race fixed, the agent now consistently runs in the new project — and *legitimately* solves the prompt by editing `index.html` + `style.css` in place rather than creating a new `*.jsx` file. The old assertion was over-fitted to one particular shape of agent output. The iframe is what the user sees, and the iframe is what the test should assert against.
- **Proof of value**: ran the new step 8 against an unchanged-from-starter `index.html` (no agent run, just the starter "Empty canvas. Tell the AI what to build." text) — assertion failed at line N with the expected message about "two Hello-World variants" not being present. Re-ran with the agent enabled and a successful turn — assertion passed in <60s. The new step 9 sanity-check fails when the project dir is exactly the two-file starter, passes when the agent wrote anything extra. Run wall time: 90s on the happy path (down from 330s previously, because we no longer wait for the file-pattern coincidence to materialize separately from the iframe).

## 2026-05-06 — PR #48 — tightened

- **Change kind**: `tightened` (added two new guard assertions).
- **Before**: cleanup deleted by id; safety was a property of the code path, not measurable.
- **After**: snapshot the project list before the test (sorted), assert the captured `projectId` is NOT in that snapshot (proves it's genuinely new), and after cleanup assert the project list matches the snapshot exactly (proves zero leak + zero collateral damage).
- **Why**: maintainer asked for an explicit guarantee that the CUJ never touches a contributor's existing local projects under `web/projects/`. The previous code was correct but the property wasn't testable.
- **Proof of value**: removed the `request.delete(...)` call locally and re-ran — the new snapshot-after assertion (step 11) failed with a clear message naming the leaked project. Re-added the delete and the test passes. The assertion catches the regression it's supposed to catch.

## 2026-05-06 — PR #48 — created

- **Change kind**: `created` (first version of the test).
- **Flow it proves**: home → `+ New project` → name input → Create → editor route loads at `/editor?p=p_*&file=index.html` → iframe canvas renders → chat prompt asking for a two-frame Hello World (white bg + dark navy `#0a1f3a` bg) → agent generates `*Canvas.jsx` containing both backgrounds → iframe DOM contains "Hello World" + reference to dark navy variant → cleanup via `DELETE /api/projects/<id>`.
- **Why**: PR #48 added the dev-time skills layer (`ship-task`, `verify-with-playwright`, `semantic-commit`); this CUJ is the corresponding "always-on" integration test the maintainer wants run on every future PR before merge. See PR #48 description "Manual integration test" section for the first manual run's evidence.
- **Proof of value**: Drove the flow once with the maintainer present; produced a `web/projects/p_758c783a/HelloWorldCanvas.jsx` with two `<DCArtboard>` children (`bg="#ffffff"` and `bg="#0a1f3a"`). Iframe text confirmed "Light / Hello World / Dark navy / Hello World". Wall time: 305s (agent latency dominates). Test cleaned up the project via the API endpoint and disk state matched the pre-test snapshot exactly. Evidence files persisted at `https://github.com/aiatelie/ai-atelie/releases/download/_gh-attach-assets/pr48-08-final-canvas.png` and `pr48-flow.webm`.
