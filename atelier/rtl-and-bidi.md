# RTL and bidirectional text

Universal rules for right-to-left layout and bidirectional text. AI
Atelie does not ship localized RTL UI today — every chrome string is
English-only. This file documents the rules so the day we localize
(Arabic / Hebrew / Persian / Urdu users dropping in their own brand
copy via the chat composer), we don't ship a broken layout.

> Grounded in primary sources: Unicode UAX #9 revision 51 (Sept 2025)
> + Unicode 17.0, CSS Logical Properties Level 1, HTML Living Standard
> (`dir`, `<bdi>`), W3C alreq, Material 3 RTL guidance, Apple HIG
> internationalization.

## When this matters today

Even though the chrome is English, RTL leaks in three ways already:

1. A user names a project in Arabic. `ProjectCard.cardName` renders
   that name; if the surrounding paragraph direction is wrong, the
   characters reorder.
2. A user types Arabic in the chat composer. The composer's textarea
   needs `dir="auto"` so Arabic input flows RTL while the surrounding
   English chrome stays LTR.
3. A user pastes mixed-script tool output (an English filename inside
   an Arabic comment). The browser bidi algorithm does the heavy
   lifting, but we can break it with hardcoded `text-align: left`.

Set the floor today; localizing the chrome is a separate effort.

## Base direction and language

Every full-page RTL artifact needs `<html dir="rtl" lang="ar">` (or
the matching `lang` for Hebrew, Persian, Urdu). The `lang` attribute
drives font-stack selection, hyphenation, locale-aware speech
synthesis, and search-engine indexing — `dir` alone isn't enough.

Three patterns cover the common cases:

- **Full-page RTL.** `<html dir="rtl" lang="ar">`. Everything inside
  inherits.
- **Mixed-language subtree.** Nest `<section dir="ltr" lang="en">…</section>`
  (or vice versa) when an embedded block uses a different script.
  Code samples, English citations, foreign brand names.
- **User-generated content of unknown direction.** `dir="auto"` on
  the paragraph or `<bdi>`. The browser resolves direction from the
  first strong directional character.

Setting `lang` without `dir` is fine **at the document root in a
default-LTR page** — English doesn't need `dir="ltr"` because the
bidi base direction is already LTR. Inside any opposite-direction
ancestor, `lang` does not reset the inherited base direction, so set
both `lang` and `dir` on the subtree.

## Logical properties first

Hardcoded `left` / `right` is a bug for any layout that might render
RTL. Use logical properties on the inline axis. Use them on the block
axis when the writing-mode varies; physical otherwise.

| Logical | LTR resolves to | RTL resolves to |
|---|---|---|
| `margin-inline-start` / `padding-inline-start` / `inset-inline-start` | left | right |
| `margin-inline-end` / `padding-inline-end` / `inset-inline-end` | right | left |
| `border-inline-start` | border-left | border-right |
| `border-start-start-radius` | border-top-left-radius | border-top-right-radius |
| `text-align: start` / `text-align: end` | left / right | right / left |
| `inline-size` / `block-size` | width / height | width / height |

Browser support: core inline-axis logical properties are Baseline
Widely Available (Chrome 87, Safari 14.1, Firefox 66; ≥95% global as
of 2026-05).

**Audit our CSS modules.** Search for `margin-left`, `margin-right`,
`padding-left`, `padding-right`, `text-align: left`, `left:`, `right:`
across `web/src/components/**/*.module.css` and `web/src/routes/*.module.css`.
Each is a future bug. Replace with `*-inline-start` / `*-inline-end` /
`text-align: start` / `inset-inline-start`. Exceptions: chart x-axes,
physical-object icons, fixed-position elements anchored to a corner.

## Bidirectional text

UAX #9 rev 51 (Sept 2025) is a version stamp for Unicode 17.0. No
algorithm change.

UAX #9 defines two distinct families of bidi formatting characters
that solve different problems:

- **Isolate controls** (modern, prefer these): U+2066 LRI, U+2067 RLI,
  U+2068 FSI — opened with these, all closed with U+2069 PDI. An
  isolated run does not affect, and is not affected by, the
  surrounding paragraph's bidi resolution. Use FSI when the embedded
  run's direction is unknown ahead of time.
- **Embedding / override controls** (legacy): U+202A LRE, U+202B RLE,
  U+202D LRO, U+202E RLO — all closed with U+202C PDF. These nest
  within the surrounding paragraph rather than isolating from it;
  LRO/RLO additionally force a direction onto neutral characters.
  Newer code should use isolates.

**Use `<bdi>` in HTML; in plain text, pick the isolate that matches
what you know about the run.** UAX #9 §2.7: *"where available, markup
should be used instead of the explicit formatting characters."*
`<bdi>` has been Baseline Widely Available since January 2020.

When you do reach for control characters in plain-text contexts (logs,
plain-text emails, terminal output):

- **LRI U+2066 + PDI U+2069** for known-LTR runs (English name in an
  Arabic paragraph, code-style identifiers, phone numbers).
- **RLI U+2067 + PDI U+2069** for known-RTL runs (Arabic name in an
  English paragraph).
- **FSI U+2068 + PDI U+2069** for unknown direction (UGC where the
  author and language can vary).

Don't reach for FSI as the default — it auto-detects from the first
strong character, which is the wrong choice when you already know
what direction the run should be.

`dir="auto"` on a paragraph or `<bdi>` lets the browser detect
direction from the first strong directional character. Best for
user-generated content where direction isn't known at author time —
**this is the right default for `ProjectCard.cardName` and chat
composer textareas.**

## What mirrors and what doesn't

Mirroring isn't universal. The rules below are unanimous across
Material 3 RTL guidance and Apple HIG internationalization.

**Must mirror:**

- Directional arrows (back / forward / next / previous), navigation
  rail position, tab order, calendar-grid weekday order.
- Slider fill direction and **non-media** progress-bar fill (a
  download progress bar, a form-completion bar, an upload status).
  Media scrubbers stay LTR.
- Checkbox-and-label position. Label sits to the right in LTR, to the
  left in RTL.
- Phone-number and IBAN affordances when the surrounding paragraph
  is RTL but the value itself is LTR — wrap the value in
  `<bdi dir="ltr">` (or `<span dir="ltr">`) so the digits don't
  reflow.

**Must not mirror:**

- Clock faces. Clockwise is universal.
- Circular refresh / sync / reload icons. Same reason.
- Media playback controls (play / pause / fast-forward / rewind)
  **and the media scrubber / progress timeline**. They represent
  tape direction, not reading direction.
- Charts and graphs. X-axis stays mathematical, not linguistic.
- Photographs, brand logos, physical-object icons (camera, keyboard,
  headphones). Identity over direction.

**Numerals are not a mirroring decision.** They follow locale, not
paragraph direction. Arabic-Indic digits carry bidi class **AN** and
sit inside mixed-direction lines without flipping.

## Typography rules anchored here

Two RTL-coupled typography rules sit in this file because they cause
breakage at the layout level:

- **Never apply CSS `letter-spacing` to Arabic runs.** alreq treats
  letter-spacing as a boundary concept, not a uniform tracking
  value. Applying tracking breaks the cursive joining the script
  depends on. The ALL CAPS tracking rule from `typography.md` does
  not apply to Arabic — Arabic doesn't have a case distinction.
- **Body type for Arabic runs ~14-18 px with line-height 1.5-1.75**
  to give harakat (diacritics) clearance. Latin defaults are too
  tight. Our chrome runs at 13 px which is below the Arabic floor —
  if we localize chrome to Arabic, bump it to 14-15 px under
  `[lang="ar"]`.

## Forms in RTL

Form fields commonly mix scripts. Three rules cover most of it.

- **`<input dir="auto">`** for any field whose value's direction is
  uncertain (search boxes, comment fields, free-text inputs, chat
  composer). The browser detects from the first strong directional
  character.
- **Force LTR on intrinsically-LTR fields** even inside an RTL
  paragraph: email, URL, phone, IBAN, credit-card.
  `<input type="email" dir="ltr">`.
- **Wrap rendered values in `<bdi>`** when displaying mixed-script
  content (a username inside a paragraph, a model number inside a
  description). For values whose direction is fixed and
  weak-character-heavy (phone, IBAN, card number), use
  `<bdi dir="ltr">` rather than bare `<bdi>`.

## Common mistakes

**Mechanically lintable:**

- Hardcoded `left` / `right` / `text-align: left` in new CSS — bug
  for any layout that may render RTL. Exceptions: chart x-axes,
  physical-object icons, platform-pinned UI like a status-bar clock.
- "WebKit doesn't support U+2066-U+2069" — wrong, they're
  interoperable across modern browsers.
- Setting `dir="rtl"` without `lang="ar"` (or matching). Lint
  together; `dir` alone misses the font-stack and locale path.

**Needs script detection (will false-positive without it):**

- "Use `text-justify: kashida` for Arabic" — no browser implements
  it. CSS `text-align: justify` adds inter-word spacing and looks
  unnatural in Arabic; kashida elongation is the correct form, but
  it isn't shippable on the web today.
- Italics on Arabic or Hebrew text. Neither script has an italic
  tradition.
- CSS `letter-spacing` applied to Arabic. Breaks cursive joining.
- Lorem Ipsum used for RTL prototyping. Arabic word lengths,
  connection behaviors, and vertical extents differ; use real
  Arabic / Hebrew text.

**HTML semantics:**

- Reaching for CSS bidi controls (`unicode-bidi: isolate` /
  `plaintext` / `embed`) for inline runs when `<bdi>` or a
  `dir`-bearing element does the job. Prefer semantic isolation in
  HTML for inline content.
- Bare `<bdi>` around phone / IBAN / card numbers in an RTL
  paragraph. First-strong detection on weak/neutral characters is
  unreliable; force `dir="ltr"` explicitly.
