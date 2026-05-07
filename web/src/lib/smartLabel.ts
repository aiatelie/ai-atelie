/* smartLabel.ts — UI-only semantic-role inference for selected elements.
 *
 * The pain we're solving: a `<div style="font-size:64px;font-weight:700">`
 * styled like a heading should READ like a heading in the inspector,
 * comment bubble, comments panel, composer pill, and chat reference card —
 * not "DIV". Tag alone is too dumb; full descriptor.label is too long for
 * the small chips. This module classifies an element by tag + computed
 * style + role + ancestors, and returns three width-graded variants
 * (short / medium / full) so each surface can pick the right fit.
 *
 * Strict non-goal: the AI prompt path. `descriptor.label` (used by
 * `descriptorToPrompt` and `formatElementBlock` on the API) is left
 * byte-identical. The kind here exists only for the UI; nothing about
 * what the model sees changes.
 */

import type { ElementDescriptor } from "./cssPath";

/** Closed taxonomy of semantic kinds. Order matters in the cascade
 *  (Link before Button before Heading) — see `classifyKind`. */
export type LabelKind =
  | "Heading"
  | "Subheading"
  | "Body"
  | "Button"
  | "Link"
  | "Input"
  | "Image"
  | "Icon"
  | "List"
  | "ListItem"
  | "Section"
  | "Container"
  | "Element";

/** Minimal computed-style snapshot. We keep this lean because it's
 *  serialized into chat history and localStorage; a full
 *  CSSStyleDeclaration would explode payload size and break JSON. */
export type ComputedHints = {
  fontSizePx?: number;
  fontWeight?: number;
  display?: string;
  cursor?: string;
  borderRadiusPx?: number;
  paddingXPx?: number;
  hasBackgroundImage?: boolean;
  hasOnClick?: boolean;
};

/** Width-graded label variants. Each surface picks the one that fits:
 *  `short` for the inspector chip (~12ch), `medium` for the composer
 *  pill (~30ch), `full` for the comment-bubble header / panel row (~80ch).
 *  All are non-empty, never throw. */
export type SmartLabel = {
  kind: LabelKind;
  /** Just the kind (e.g. "Heading"). For 12-char chips. */
  short: string;
  /** Kind + class/href when it adds info (e.g. "Heading · .title"). */
  medium: string;
  /** Kind + structural identity (e.g. "Heading · div .title"). */
  full: string;
};

/** Input flexible enough to accept a fresh selection (descriptor +
 *  computed), a rehydrated chat message (descriptor only), or an old
 *  LocalComment row (just tag + classes). */
export type SmartLabelInput = {
  descriptor?: ElementDescriptor;
  /** When the kind was already classified at capture time, prefer it
   *  over re-classifying. Lets stored snapshots survive heuristic
   *  changes without flickering. */
  kind?: LabelKind;
  /** Live computed style — only available for the current Inspector
   *  selection. When absent, heading/button heuristics fall back to
   *  tag-only. */
  computed?: ComputedHints;
  /** Bare-tag fallback for legacy data lacking a descriptor. */
  tag?: string;
  classes?: string[];
  href?: string;
};

/** Heuristic thresholds — tunable. The 24px / 600 weight pair was
 *  picked to catch hero-style heading divs while excluding bold body
 *  copy at 16–18px. */
const HEADING_MIN_PX = 24;
const SUBHEADING_MIN_PX = 18;
const HEADING_MIN_WEIGHT = 600;
const SUBHEADING_MIN_WEIGHT = 500;
const BUTTON_PADDING_X_MIN = 8;
const BUTTON_RADIUS_MIN = 4;

/** Pick the most-specific kind for an element. Cascade order matters:
 *  Link/Input/Image take precedence over Button (a `<button>` inside a
 *  `<form>` shouldn't suddenly become an Input), and structural-tag
 *  kinds (Section, List, ListItem) come before the Container fallback. */
export function classifyKind(input: SmartLabelInput): LabelKind {
  const { descriptor: d, computed: c } = input;
  const tag = (d?.tag ?? input.tag ?? "").toLowerCase();
  const role = d?.role;
  const classes = d?.classes ?? input.classes ?? [];
  const href = d?.attrs?.href ?? input.href;
  const hasOnClick = c?.hasOnClick === true;

  // 1. Image — semantic image tags + sized SVG.
  if (tag === "img" || tag === "picture") return "Image";
  if (tag === "svg" && /icon/i.test(classes.join(" "))) return "Icon";

  // 2. Icon — small svg / `<i>` tags / icon-classed elements.
  if (tag === "svg" || tag === "i") return "Icon";
  if (/icon/i.test(classes.join(" ")) && !d?.text) return "Icon";

  // 3. Link — `<a href>` or role=link.
  if ((tag === "a" && href) || role === "link") return "Link";

  // 4. Input — form fields and contenteditable.
  if (tag === "input" || tag === "textarea" || tag === "select") return "Input";
  if (role === "textbox") return "Input";

  // 5. Button — `<button>`, role, OR clickable-styled wrapper. The
  //    "clickable-styled wrapper" rule is deliberately conservative:
  //    cursor:pointer alone isn't enough (links also have it); we
  //    require padding OR border-radius OR an explicit class match,
  //    AND short text — buttons aren't paragraphs.
  if (tag === "button") return "Button";
  if (role === "button") return "Button";
  if (
    c?.cursor === "pointer" &&
    ((c.paddingXPx ?? 0) >= BUTTON_PADDING_X_MIN ||
      (c.borderRadiusPx ?? 0) >= BUTTON_RADIUS_MIN ||
      hasOnClick ||
      /\b(btn|button|cta)\b/i.test(classes.join(" "))) &&
    (d?.text?.length ?? 0) <= 32
  ) return "Button";

  // 6. Heading — real h1/h2 OR a heading-sized weight-heavy div with
  //    short text and no children. Children check via class fingerprint:
  //    nested-div containers usually have multiple class hints; pure
  //    text-bearing leaf divs don't.
  if (tag === "h1" || tag === "h2" || role === "heading") return "Heading";
  if (
    (c?.fontSizePx ?? 0) >= HEADING_MIN_PX &&
    (c?.fontWeight ?? 0) >= HEADING_MIN_WEIGHT &&
    (d?.text?.length ?? 0) > 0 &&
    (d?.text?.length ?? 0) <= 120
  ) return "Heading";

  // 7. Subheading — h3/h4 OR a softer heading-styled div.
  if (tag === "h3" || tag === "h4") return "Subheading";
  if (
    (c?.fontSizePx ?? 0) >= SUBHEADING_MIN_PX &&
    (c?.fontSizePx ?? 0) < HEADING_MIN_PX &&
    (c?.fontWeight ?? 0) >= SUBHEADING_MIN_WEIGHT &&
    (d?.text?.length ?? 0) > 0
  ) return "Subheading";

  // 8. Body — `<p>` and prose-tagged elements.
  if (tag === "p" || tag === "blockquote") return "Body";

  // 9. List family.
  if (tag === "ul" || tag === "ol") return "List";
  if (tag === "li") return "ListItem";

  // 10. Sectioning content.
  if (
    tag === "section" || tag === "article" || tag === "header" ||
    tag === "footer" || tag === "main" || tag === "nav" || tag === "aside" ||
    tag === "form"
  ) return "Section";

  // 11. Container — generic block with structure (children > text).
  if (
    (tag === "div" || tag === "span") &&
    (c?.display === "flex" || c?.display === "grid" || classes.length > 0)
  ) return "Container";

  // 12. Last resort.
  return "Element";
}

/** Build a stable structural identity string ("h1", "div .title",
 *  "a → /docs"). Short — surfaces clip further as needed. */
function structureFor(input: SmartLabelInput): string {
  const d = input.descriptor;
  const tag = (d?.tag ?? input.tag ?? "div").toLowerCase();
  const href = d?.attrs?.href ?? input.href;
  const classes = (d?.classes ?? input.classes ?? []).slice(0, 1);
  const id = d?.id;

  if (href) {
    const trimmed = href.length > 20 ? href.slice(0, 17) + "…" : href;
    return `${tag} → ${trimmed}`;
  }
  if (id) return `${tag}#${id}`;
  if (classes.length) return `${tag} .${classes[0]}`;
  return tag;
}

/** Map of "the canonical tag for this kind" — used to suppress
 *  redundant suffixes like "Button · button". When the structure
 *  string IS the canonical tag and adds no class/id/href info, the
 *  medium variant collapses to just the kind. */
const CANONICAL: Partial<Record<LabelKind, string>> = {
  Heading: "h1",
  Subheading: "h3",
  Body: "p",
  Button: "button",
  Link: "a",
  Image: "img",
  Icon: "svg",
  Input: "input",
  List: "ul",
  ListItem: "li",
  Section: "section",
  Container: "div",
};

export function smartLabel(input: SmartLabelInput): SmartLabel {
  const kind = input.kind ?? classifyKind(input);
  const structure = structureFor(input);
  const canonical = CANONICAL[kind];

  // Medium drops the leading tag when it's the canonical one for
  // this kind AND no class/id/href context follows. So a real `<h1>`
  // on the composer pill reads as "Heading", but a `<div class="title">`
  // styled as one reads as "Heading · div .title" (the structural truth
  // matters — the user wants to know it isn't a real <h1>).
  const isBareCanonical =
    canonical && structure === canonical && !structure.includes(".") && !structure.includes("#") && !structure.includes("→");
  const medium = isBareCanonical ? kind : `${kind} · ${structure}`;
  // Full always carries the structure so wide rows aren't ambiguous.
  const full = `${kind} · ${structure}`;
  return { kind, short: kind, medium, full };
}

/** Derive ComputedHints from a live CSSStyleDeclaration. Caller passes
 *  this once per selection; the result serializes safely. */
export function computedHints(
  c: CSSStyleDeclaration,
  el?: Element,
): ComputedHints {
  const px = (v: string): number | undefined => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const fw = parseInt(c.fontWeight, 10);
  const padL = px(c.paddingLeft) ?? 0;
  const padR = px(c.paddingRight) ?? 0;
  return {
    fontSizePx: px(c.fontSize),
    fontWeight: Number.isFinite(fw) ? fw : undefined,
    display: c.display,
    cursor: c.cursor,
    borderRadiusPx: px(c.borderRadius),
    paddingXPx: padL + padR,
    hasBackgroundImage: c.backgroundImage !== "none" && !!c.backgroundImage,
    hasOnClick: el ? !!(el as HTMLElement).onclick || el.hasAttribute("onclick") : undefined,
  };
}
