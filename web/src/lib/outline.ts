/* outline.ts — build a layers-panel-style tree of an iframe document.
 *
 * Mirrors what Omelette's DM.outline() emits but client-side: walk the
 * iframe's DOM, collect tag + role + className + a short label per node,
 * and return a tree the panel can render.
 */

export type OutlineNode = {
  selector: string;        // CSS path used by the parent to resolve back
  tag: string;
  label: string;           // short visible label
  className?: string;
  role?: string;
  children: OutlineNode[];
};

const SKIP_TAGS = new Set(["script", "style", "link", "meta", "head", "noscript"]);
const MAX_DEPTH = 8;
const MAX_CHILDREN = 80;

function classFingerprint(el: Element): string | undefined {
  const cls = typeof el.className === "string" ? el.className : "";
  if (!cls) return undefined;
  const parts = cls.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.length ? "." + parts.join(".") : undefined;
}

function shortText(el: Element): string {
  const t = (el as HTMLElement).innerText?.trim();
  if (!t) return "";
  return t.length > 32 ? t.slice(0, 29) + "…" : t;
}

function nthOfTypeIndex(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 1;
  const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (same.length === 1) return 0;
  return same.indexOf(el) + 1;
}

function pathFor(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && cur !== cur.ownerDocument!.body) {
    let part = cur.tagName.toLowerCase();
    const i = nthOfTypeIndex(cur);
    if (i > 0) part += `:nth-of-type(${i})`;
    parts.unshift(part);
    cur = cur.parentElement;
  }
  return `body > ${parts.join(" > ")}`;
}

function build(el: Element, depth: number): OutlineNode | null {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return null;
  const tag = el.tagName.toLowerCase();
  const cls = classFingerprint(el);
  const role = el.getAttribute("role") || undefined;
  const text = shortText(el);
  const label = [tag, cls].filter(Boolean).join("") + (text ? `  "${text}"` : "");

  const children: OutlineNode[] = [];
  if (depth < MAX_DEPTH) {
    let count = 0;
    for (const c of Array.from(el.children)) {
      if (count >= MAX_CHILDREN) break;
      const node = build(c, depth + 1);
      if (node) {
        children.push(node);
        count++;
      }
    }
  }

  return {
    selector: pathFor(el),
    tag,
    label,
    className: cls,
    role,
    children,
  };
}

export function buildOutline(doc: Document): OutlineNode | null {
  if (!doc.body) return null;
  return build(doc.body, 0);
}
