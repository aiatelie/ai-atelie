# Form validation

Universal rules for form validation lifecycle, error wiring beyond the
accessibility baseline, and the schema-as-contract layer that makes
the same validation work on the server and the client. The token
layer decides how the field looks; this file decides *when* it tells
the user it's wrong, *how* the error reaches assistive tech, and
*where* the rule lives.

> Grounded in primary sources: WHATWG HTML Living Standard
> (Constraint Validation), CSS Selectors L4 (`:user-invalid`), WCAG
> 2.2 SC 3.3.x, ARIA APG forms patterns, Standard Schema spec
> (`@standard-schema/spec`), Baymard 2024 inline-validation research,
> WebAIM Million 2026 forms findings.

## Where this applies in our app

Today: `NewProjectDialog`, `ConfirmDialog`, the editor's chat
composer, any inline rename input on cards, the asset upload form,
the eventual settings panel. Tomorrow: any sign-in / share surface
we add to the API.

## The input state machine

Every input passes through these states. Drive error chrome off the
state, not off raw `:invalid` or focus/blur booleans.

| State | Meaning | UI |
|---|---|---|
| `pristine` | User has not interacted | No error chrome, no green check |
| `dirty` | User has typed but not committed (still focused) | No error chrome yet |
| `touched` | User has blurred at least once after editing | Field-level constraint runs |
| `invalid-after-touched` | Constraint failed after blur | Show error, link via `aria-describedby` |
| `invalid-after-submit` | Submit attempted, field still invalid | Same, plus focus management to summary or first invalid field |
| `recovering` | User editing an already-invalid field | Re-validate on `input`, not on next blur |
| `submitting` | Action in flight | Disable submit, announce status via a polite live region |
| `server-error` | Server returned an error for this field | Use server's message text; treat as `invalid-after-submit` |

Decision rule: errors appear on transition into `invalid-after-touched`,
clear on transition out of any invalid state, and never appear from
`pristine` or plain `dirty`. CSS `:user-invalid` matches the
`invalid-after-touched` / `invalid-after-submit` states for free.

## Validation timing

Baymard's checkout-UX benchmark (2024-01-09 inline-validation article):
**31% of sites have no inline validation, and most of the rest fire
too early.** The participant quote: *"Why are you telling me my email
address is wrong, I haven't had a chance to fill it all out yet?"*
Premature firing is the loudest UX failure in this space.

The four rules:

1. **First blur after edit** runs the field-level constraint. Not on
   focus, not on first keystroke, not on every keystroke.
2. **Once a field is invalid, switch to `input`-event re-validation**
   so the error clears the moment input becomes valid. Don't make the
   user blur again to dismiss it.
3. **On submit**, run the schema parse. Move focus to the error
   summary at the top of the form (a heading-led container with
   `tabindex="-1"`, no `role="alert"`), or to the first invalid field
   if no summary exists. Don't move focus on every keystroke.
4. **Async checks** split into two paths. *Background preflight*
   (uniqueness while typing, address lookup) debounces 250–500 ms,
   announces via a polite live region, and never gates typing.
   *Authoritative server validation on submit* must await the
   server's response and surface field errors from it.

CSS gets you most of timing rule 1 for free: style off
`:user-invalid` not `:invalid`. The `:user-invalid` selector is
Baseline Newly available 2023 (Chrome 119, Firefox 88, Safari 16.5)
and matches only after the user has either submitted the form or
blurred the field with bad input.

## Constraint Validation API as the platform floor

Native HTML constraints are not an alternative to JS validation; they
are the substrate the rest of the layers run on. They survive JS
failure, they integrate with autofill, and they are what
`reportValidity()` and screen-reader native announcements key off.

```html
<input type="text" name="project-name" required maxlength="80">
```

Use these declaratively for every field that has them: `required`,
`type` (email, url, number, tel), `pattern`, `min`/`max`,
`minlength`/`maxlength`, `step`. Cross-field rules go through
`setCustomValidity()` on both `input` and `change` events.

Rules of the API:

- **Empty string clears `setCustomValidity`.** Not `null`, not no-arg.
- **`form.requestSubmit()` honors validation; `form.submit()` skips
  it.** Never call the second.
- `disabled` controls are barred from validation and not submitted.
- `inputmode` is a virtual-keyboard hint, **not** validation.
  `<input type="text" inputmode="numeric" pattern="[0-9]*">` is the
  recommended shape for ZIPs / OTPs / card numbers.

## Error wiring beyond the baseline

The default error pattern in `accessibility-baseline.md` covers WCAG
3.3.1 / 3.3.2. Three additions matter for real forms:

**Adaptive error messages.** Baymard 2023: 98% of audited sites use
generic catch-all errors ("Provide a valid phone number") rather than
the specific subrule that fired ("Phone number is too short"). Surface
the specific message — for our `NewProjectDialog`, that means
"Project name can't be blank" + "Project name is too long (max 80
chars)" + "A project named X already exists" as separate, specific
errors.

**Error summary at the top, on submit only.** Long forms benefit from
a summary list of in-page anchor links to invalid fields, focused on
submit:

```html
<div id="form-errors" tabindex="-1">
  <h2>2 problems</h2>
  <ul>
    <li><a href="#project-name">Project name is required</a></li>
    <li><a href="#starter-template">Starter template not found</a></li>
  </ul>
</div>
```

The container is heading-led with `tabindex="-1"` so JS can move focus
to it on submit. It does **not** carry `role="alert"` because
combining a moved-focus target with an alert role causes
double-announcement. Reserve `role="alert"` for inline per-field
errors that appear without focus moving.

**Preserve user input on error.** Baymard 2024: 34% of audited
checkouts wipe the credit-card field when an unrelated error reloads
the page. Direct cause of abandonment. For our forms: never clear a
field on submit failure. The user's typed name should still be there
when the dialog re-renders with an error.

## Schema as the cross-stack contract

Validation expressed once, consumed everywhere. We use TypeScript on
both the React client and the Bun + Hono API; a Zod 4 / Valibot /
ArkType schema (any Standard Schema-compliant validator) runs in
both:

```ts
const NewProject = z.object({
  name: z.string().min(1).max(80),
  template: z.enum(["banner", "blank"]).optional(),
});
// Same schema parses on the API route and on the dialog client.
```

Three rules that survive across stacks:

- **Server is the truth, client is the optimization.** Same schema
  runs in both. Returning `{ errors }` from the action (not throwing)
  keeps the form data accessible.
- **Standard Schema is the contract, not Zod.** A form library that
  ships per-validator resolver shims (`zodResolver`, etc.) is
  yesterday's stack. Accept any `~standard`-compliant validator.
- **`novalidate` on `<form>` does not mean "skip validation".** It
  means "let the form library repaint errors instead of the
  browser's bubble." Don't ship `novalidate` on a server-rendered
  `<form>` whose submit path requires JS — the no-JS user loses the
  browser's submit-blocking. Either set `form.noValidate = true`
  *after hydration*, or only ship `novalidate` when the submit path
  reaches the server without JS.

## WCAG 3.3.x beyond Error Identification

`accessibility-baseline.md` covers 3.3.1 (Error ID), 3.3.2 (Labels),
and 3.3.7 (Redundant Entry). The rest of 3.3 binds harder on
transactional forms:

- **3.3.3 Error Suggestion (AA):** when the fix is determinable,
  suggest it in text. "Project name must be 1–80 characters. You
  entered 95. Trim 15."
- **3.3.4 Error Prevention — Legal, Financial, Data (AA):** any
  submission with legal / financial / data-modifying consequence
  needs reversibility, server-side check + correction step, or a
  confirm-summary screen before commit. Project deletion qualifies —
  hence `ConfirmDialog`.
- **3.3.8 Accessible Authentication (AA, WCAG 2.2):** auth steps must
  not require a cognitive function test (remember a password,
  transcribe a code) without an alternative. Don't block paste on
  password fields, support password managers.
- **3.3.9 Accessible Authentication, No Exception (AAA):** removes
  even the object-recognition exceptions. Aspirational.

## Common mistakes

- Styling off `input:invalid` instead of `input:user-invalid`. Red
  borders on page load is the loudest "this validation was added
  without testing" signal.
- Validating on every keystroke. Hostile.
- Generic catch-all error messages ("Invalid input") when the back
  end already knows which subrule fired.
- Throwing from a server action on validation failure. Loses the form
  data. Return `{ errors }` instead.
- `role="alert"` on the error-summary container that focus moves to.
  Double-announces. Reserve `role="alert"` for inline per-field
  errors.
- `aria-busy="true"` on the submit button while submitting. For
  buttons use `disabled` plus a polite live-region status message.
- Email-confirm fields ("retype your email"). 3.3.7 redundant entry —
  exceptions are essential / security / no-longer-valid, not "we
  want to catch typos."
- Per-validator resolver shims (`zodResolver`, `valibotResolver`).
  Accept Standard Schema's `~standard` interface and the validator
  becomes swappable.
- Wiping a field when another field errors. Direct abandonment cause.
- `setCustomValidity(null)` to clear an error. Pass empty string;
  `null` does not clear.
- Calling `alert()` on submit failure (currently the case for
  `Projects.handleCreate`). Use an inline error message wired to
  the form via `aria-describedby` instead.
