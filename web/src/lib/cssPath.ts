// Build a durable CSS selector path for an element inside an iframe.
// The path is rooted at <body> and uses :nth-of-type to disambiguate
// siblings. Two reasons we don't return `[data-dm-ref="..."]` here:
//   1. The inject-script's refs renumber on every iframe reload, so a
//      ref-based key wouldn't replay against a fresh DOM.
//   2. Source-mapping (e.g. the Persist→source flow) needs a path that
//      carries semantic info Kimi can grep for; an opaque ref doesn't.
// Runtime callers that want the live ref still read it directly from
// the resolved element via `el.getAttribute("data-dm-ref")`.

export function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && cur !== cur.ownerDocument!.body) {
    let part = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === cur!.tagName
      );
      if (sameTag.length > 1) {
        const i = sameTag.indexOf(cur) + 1;
        part += `:nth-of-type(${i})`;
      }
    }
    parts.unshift(part);
    cur = parent;
  }
  return `body > ${parts.join(" > ")}`;
}

export function resolveCssPath(doc: Document, path: string): Element | null {
  try {
    return doc.querySelector(path);
  } catch {
    return null;
  }
}

/* ─── Rich descriptor ────────────────────────────────────────────
 * cssPath() gives the AI a structural address. It does NOT tell the
 * AI what the user is *pointing at*. When the AI sees only
 * `body > div > div > h1` plus a 1200-char outerHtml dump, it tends
 * to describe the structure ("a heading inside a wrapper inside a
 * section…") rather than the thing.
 *
 * `buildDescriptor(el)` extracts the human-meaningful identity from
 * the element + a few ancestors: the visible text, identifying
 * attributes (id, class, role, aria-label, data-testid, alt, title,
 * name, href), and the nearest semantic landmarks. The AI gets
 * "Heading 'Welcome' in section.hero (h1.title)" instead of a CSS
 * path it has to mentally resolve. */

export type ElementDescriptor = {
  /** Single-line, human-readable summary suitable for inline display
   *  AND for the top of an AI prompt. e.g. `<h1.title> "Welcome" inside <section.hero>`. */
  label: string;
  tag: string;
  /** Short text content (≤ 80 chars), if any. */
  text?: string;
  classes: string[];
  id?: string;
  role?: string;
  ariaLabel?: string;
  testId?: string;
  /** Common identifying attributes worth surfacing to the AI. */
  attrs?: Record<string, string>;
  /** Up to 5 ancestors, nearest first. Each is a short signature like
   *  `section.hero` or `nav` or `<form name="signup">`. */
  ancestors: string[];
  /** Position among same-tag siblings (1-based). Useful when the
   *  element is one of many cards/items. */
  siblingIndex?: number;
  siblingTotal?: number;
};

const SHOW_ATTRS = ["href", "src", "alt", "title", "name", "type", "placeholder"];
const SEMANTIC_TAGS = new Set([
  "header", "footer", "main", "nav", "aside", "section", "article",
  "form", "ul", "ol", "li", "table", "tr", "td", "th", "figure",
  "dialog", "details", "summary", "button", "label",
]);

function classList(el: Element): string[] {
  const raw = el.getAttribute("class") || "";
  return raw.split(/\s+/).filter(Boolean).slice(0, 4);
}

/** A short, grep-friendly signature for one element. Prefers
 *  semantic info: `nav#main-nav`, `section.hero`, `<a href="/about">`. */
function signature(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute("id");
  if (id) return `${tag}#${id}`;
  const classes = classList(el);
  if (classes.length) return `${tag}.${classes.join(".")}`;
  const role = el.getAttribute("role");
  if (role) return `${tag}[role=${role}]`;
  const testId = el.getAttribute("data-testid");
  if (testId) return `${tag}[data-testid=${testId}]`;
  return tag;
}

function shortText(el: Element): string | undefined {
  // textContent collapses whitespace and skips hidden nodes' text;
  // good enough as a label hint. Cap aggressively.
  const t = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
}

function collectAttrs(el: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of SHOW_ATTRS) {
    const v = el.getAttribute(name);
    if (v) out[name] = v.length > 60 ? v.slice(0, 57) + "…" : v;
  }
  return Object.keys(out).length ? out : undefined;
}

function ancestorChain(el: Element, max = 5): string[] {
  const chain: string[] = [];
  let cur: Element | null = el.parentElement;
  while (cur && cur !== cur.ownerDocument!.body && chain.length < max) {
    // Skip wrapper divs that contribute nothing (no class, no id, no
    // semantic tag) — they make the AI's mental picture noisier.
    const tag = cur.tagName.toLowerCase();
    const noise = tag === "div" && !cur.id && classList(cur).length === 0;
    if (!noise) chain.push(signature(cur));
    cur = cur.parentElement;
  }
  // Always close with `<body>` so the AI knows the chain isn't truncated.
  chain.push("body");
  return chain;
}

function siblingPosition(el: Element): { index?: number; total?: number } {
  const parent = el.parentElement;
  if (!parent) return {};
  const sameTag = Array.from(parent.children).filter(
    (c) => c.tagName === el.tagName
  );
  if (sameTag.length <= 1) return {};
  return { index: sameTag.indexOf(el) + 1, total: sameTag.length };
}

export function buildDescriptor(el: Element): ElementDescriptor {
  const tag = el.tagName.toLowerCase();
  const classes = classList(el);
  const id = el.getAttribute("id") || undefined;
  const role = el.getAttribute("role") || undefined;
  const ariaLabel = el.getAttribute("aria-label") || undefined;
  const testId = el.getAttribute("data-testid") || undefined;
  const text = shortText(el);
  const attrs = collectAttrs(el);
  const ancestors = ancestorChain(el);
  const { index: siblingIndex, total: siblingTotal } = siblingPosition(el);

  // Nearest semantic ancestor, used to anchor the label. Falls back
  // to the immediate parent if nothing semantic is found.
  let semantic = "";
  let cur: Element | null = el.parentElement;
  while (cur && cur !== cur.ownerDocument!.body) {
    if (SEMANTIC_TAGS.has(cur.tagName.toLowerCase()) || cur.id || classList(cur).length > 0) {
      semantic = signature(cur);
      break;
    }
    cur = cur.parentElement;
  }

  // Build a readable label.
  const sig = signature(el);
  const labelParts: string[] = [`<${sig}>`];
  if (text) labelParts.push(`"${text.length > 40 ? text.slice(0, 37) + "…" : text}"`);
  if (semantic) labelParts.push(`inside <${semantic}>`);
  if (siblingIndex && siblingTotal) labelParts.push(`(${siblingIndex} of ${siblingTotal})`);
  const label = labelParts.join(" ");

  return {
    label,
    tag,
    text,
    classes,
    id,
    role,
    ariaLabel,
    testId,
    attrs,
    ancestors,
    siblingIndex,
    siblingTotal,
  };
}

/** Multi-line markdown rendering of a descriptor for AI prompts. */
export function descriptorToPrompt(d: ElementDescriptor): string {
  const lines: string[] = [`**Element:** ${d.label}`];
  const facts: string[] = [];
  if (d.id) facts.push(`id=\`${d.id}\``);
  if (d.classes.length) facts.push(`class=\`${d.classes.join(" ")}\``);
  if (d.role) facts.push(`role=\`${d.role}\``);
  if (d.ariaLabel) facts.push(`aria-label=\`${d.ariaLabel}\``);
  if (d.testId) facts.push(`data-testid=\`${d.testId}\``);
  if (d.attrs) {
    for (const [k, v] of Object.entries(d.attrs)) facts.push(`${k}=\`${v}\``);
  }
  if (facts.length) lines.push(`- ${facts.join(" · ")}`);
  if (d.text && d.text.length > 40) {
    lines.push(`- text: ${JSON.stringify(d.text)}`);
  }
  if (d.ancestors.length > 1) {
    lines.push(`- ancestors: ${d.ancestors.join(" › ")}`);
  }
  if (d.siblingIndex && d.siblingTotal && d.siblingTotal > 1) {
    lines.push(`- position: ${d.siblingIndex} of ${d.siblingTotal} same-tag siblings`);
  }
  return lines.join("\n");
}
