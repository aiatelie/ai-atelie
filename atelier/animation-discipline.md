# Animation discipline

Universal rules for when motion earns its place in the chrome and what
numbers constrain it. Tokens decide brand-specific motion *personality*;
this file decides whether motion should run at all and at what
duration, easing, and accessibility floor.

> Grounded in primary sources: Tversky/Morrison/Bétrancourt 2002
> (IJHCS), Heer & Robertson TVCG 2007, Harrison/Yeo/Hudson CHI 2010,
> Material 3 motion tokens, IBM `@carbon/motion`, Apple SwiftUI
> Animation API, W3C View Transitions, WCAG 2.2.2 + 2.3.3, WebKit's
> 2017 `prefers-reduced-motion` rationale.

## When motion earns its place

Tversky/Morrison/Bétrancourt's 2002 meta-analysis (IJHCS 57, pp.
247–262) found that every study claiming animation aids comprehension
had a broken control — the static version had less information,
different procedures, or hidden interactivity. When equalised,
animation does **not** beat static for teaching complex systems. The
single use case the paper endorses is real-time spatial or temporal
reorientation: page transitions, container morphs, viewpoint changes,
progress indicators (p. 257).

A follow-on hazard: Palmiter & Elkerton found animation-trained users
*declined* one week after training, while text-trained users
*improved* (Tversky 2002, p. 255). Animation's apparent short-term
parity hides worse retention.

So animate when the user is moving through space, time, or state —
navigation, container expansion, progress feedback, gesture
follow-through. Don't animate to teach, decorate, signal "premium",
or fill silence.

For our chrome: tab strip transitions, panel slide, dialog enter,
drag-reorder, comment thread expand. Don't animate the editor canvas
on every render, don't animate empty-state illustrations on idle, don't
animate hovers past micro-feedback duration.

## Duration thresholds

The cross-design-system convergence is **150 ms** — Material 3
`short3`, IBM Carbon `moderate-01`, Shopify Polaris `150`, Tailwind
default, SLDS `duration-fast` all land here. Use it as the default
duration for state-confirmation feedback.

| Duration | Use |
|---|---|
| 50–100 ms | Instant feedback (button press, toggle commit, hover) |
| 150 ms | Default for state-confirmation |
| 200–300 ms | Entering UI (modals, sheets, dropdowns, the NewProjectDialog) |
| 300–500 ms | Cross-screen transitions, container morphs (route change, panel collapse) |
| > 500 ms | Reserved for cross-screen, staged, or platform-native transitions |

Non-navigation microinteractions — hover, press, toggle, validation,
chip selection, row expansion — should stay under 500 ms. Past that
the user notices the motion as motion and waits on the UI rather than
working through it. Two qualifications: frequent animations (a hover
effect seen 50 times per session) need to stay ≤200 ms; mobile
animations should run 20–30% shorter than desktop equivalents because
travel distances are shorter.

## Curve vs spring

Use a curve for opacity, color, and any property that changes value
between two known points. Use a spring for position, scale, rotation,
and gesture-driven motion — anything that should feel physical.

Material 3 standard easing is `cubic-bezier(0.2, 0, 0, 1)` —
front-loaded; the trailing zero makes the curve hit its target
instantly and settle. M2 standard was the symmetric
`cubic-bezier(0.4, 0, 0.2, 1)`, preserved in M3 under the name
`legacy`. Anyone shipping the M2 curve and calling it "M3" is on
legacy tokens. M3 `emphasized` is a **two-segment Bézier path**, not
a single cubic-bezier; single-cubic approximations silently lose the
front-loaded character. CSS `linear()` (Chrome 113+) is the only way
to replicate it on a single property.

Apple's published SwiftUI default spring is
`(response: 0.5, dampingFraction: 0.825, blendDuration: 0)`. The
widely cited `.snappy = 0.25 s, .smooth = 0.35 s` numbers are wrong —
Apple's docs assign all three presets a 0.5 s base, differing only in
bounce (0 / 0.15 / 0.3).

For our React-DOM chrome: use CSS transitions with
`cubic-bezier(0.2, 0, 0, 1)` as the default, named token
`--ease-out-expressive` (to be added). Reach for a spring library
only for drag-reorder physics; everything else is a CSS transition.

## Reduced motion

Every animation that translates, scales, rotates, or parallaxes must
respect `@media (prefers-reduced-motion: reduce)`. WebKit shipped this
in 2017 to address vestibular triggers; the W3C MQ5 spec lets the UA
or author **strip motion entirely or substitute static imagery** —
the spec does not mandate which.

Working rule: strip motion-on-an-axis (translate, scale, rotate,
parallax). Keep opacity/color crossfades as substitutes when a state
change still needs to be conveyed. Be explicit — the View
Transitions API does **not** apply `prefers-reduced-motion`
automatically; the author must add a query override on the
pseudo-elements or skip `startViewTransition` entirely.

WCAG calibration: 2.2.2 (Pause/Stop/Hide) is Level A — the legal floor
under ADA Title II 2024 / EN 301 549 / EAA — but it names cognitive,
attentional, and reading populations, not vestibular. Vestibular
language lives in 2.3.3, which is **AAA**. Don't conflate the two.
Building for vestibular users is a craft commitment beyond the legal
floor, not a WCAG mandate.

**Flashing limits.** WCAG 2.3.1 (Level A) permits flashing only when
there are no more than three flashes within any one-second period, or
the flashing area stays below the general and red flash thresholds.
WCAG 2.3.2 (AAA) forbids flashing more than three times within any
one-second period regardless of area or brightness. The protected
concern is photosensitive epilepsy; the legal floor isn't negotiable.

## Repeated and ambient motion

The rules above target one-shot transitions. Looping motion (skeleton
shimmer, idle backgrounds, autoplay, reward bursts) has different
constraints.

- Cap iteration count: skeleton shimmer until content lands, never
  indefinitely. The Projects loading skeleton currently shimmers via
  `opacity: 0.35` — fine, but if we add an animated shimmer, it
  must terminate when data arrives.
- WCAG 2.2.2 (Level A) requires a pause control for any motion
  running longer than 5 seconds — moving, blinking, or scrolling
  content, not only video.
- Cancel ambient motion on route change. A spinner from a previous
  panel still rotating in the new one is jarring.
- Reward animations are one-shot. No looping confetti, no looping
  level-up bursts.
- Spinners must not run indefinitely. Escalate to progress / cancel
  states and stop animation at 60 s, matching `state-coverage.md`.

## Concrete patterns for our chrome

| Surface | Property | Token / value | Duration |
|---|---|---|---|
| Button hover | background, border-color | curve | 120 ms |
| Button press | scale (subtle) | curve | 80 ms |
| Card hover | shadow, border | curve | 150 ms |
| Tab change | underline x-position | curve | 150 ms |
| Dialog enter | opacity + translateY(8px) | curve | 200 ms |
| Dialog exit | opacity | curve | 150 ms |
| Panel slide | translateX | curve | 250 ms |
| Toast enter | opacity + translateY(-8px) | curve | 200 ms |
| Drag-reorder | y-position | spring | physics-driven |
| Comment thread expand | height (with `interpolate-size`) | curve | 250 ms |

These map to a small set of CSS variables we should add:
`--motion-fast: 120ms`, `--motion-default: 150ms`,
`--motion-medium: 250ms`, `--motion-slow: 400ms`,
`--ease-out-expressive: cubic-bezier(0.2, 0, 0, 1)`. Components
should read these tokens, not hardcode durations.

## Common mistakes

- "Skeleton screens feel 11% faster" — Harrison/Yeo/Hudson CHI 2010
  measured *backwards-decelerating ribbed determinate progress bars*
  (n=16). The induced-motion mechanism doesn't transfer to skeletons.
- "Doherty Threshold = 400 ms" — the 1982 paper does not contain
  "400". The lowest threshold actually measured is 300 ms.
- M2 standard easing `cubic-bezier(0.4, 0, 0.2, 1)` labelled as
  "Material 3". M3's standard is `cubic-bezier(0.2, 0, 0, 1)`.
- Animations that *perform* a state change rather than *confirming*
  one that has already happened. Optimistic UI first; motion second.
- More than 500 ms on any non-cross-screen transition.
- Animation as the only signal of state change. Reduced-motion users
  miss it; always pair with a static affordance (color, position,
  label).
- Ignoring `prefers-reduced-motion` on transform-based animations —
  the highest-cost vestibular triggers.
- Curve-based animation on a `transform: scale()` that should feel
  physical. Use a spring.
- Hero choreography in productivity tools. Motion budget belongs
  inside the product on functional micro-feedback, not on
  landing-page sequences.
- Decorative motion on the editor canvas. The user's content is the
  motion; chrome animation around it is noise.
