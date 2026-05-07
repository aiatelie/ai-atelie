/* detectFileExtension.ts — sniff a sensible file extension for a
 * pasted blob of text, so the paste-as-file dialog can pre-fill the
 * filename without making the user pick from a long list.
 *
 * Lightweight content-based heuristics: look at the first non-empty
 * line for a few obvious markers. Bias toward the safer choice (.txt)
 * when nothing matches, never throw. */

export type DetectedExtension =
  | "json"
  | "md"
  | "html"
  | "svg"
  | "css"
  | "js"
  | "ts"
  | "txt";

/** Pick an extension based on the content's first bytes. */
export function detectFileExtension(text: string): DetectedExtension {
  const trimmed = text.trim();
  if (!trimmed) return "txt";

  // JSON: object or array literal at the top.
  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* fall through */
    }
  }

  // SVG comes before HTML so an <svg ...> root doesn't get classified
  // as HTML by the broader sniff below.
  if (/^<\?xml[^>]*\?>\s*<svg[\s>]/i.test(trimmed)) return "svg";
  if (/^<svg[\s>]/i.test(trimmed)) return "svg";

  // HTML: doctype or <html or any leading tag.
  if (/^<!doctype html/i.test(trimmed)) return "html";
  if (/^<html[\s>]/i.test(trimmed)) return "html";
  if (/^<[a-z][^>]*>/i.test(trimmed) && /<\/[a-z]+>/i.test(trimmed)) return "html";

  // Markdown: headings, fenced code, or list markers on the first line.
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  if (/^#{1,6}\s/.test(firstLine)) return "md";
  if (/^```/.test(firstLine)) return "md";
  if (/^[-*]\s/.test(firstLine) && trimmed.includes("\n")) return "md";

  // CSS: a rule like `.foo { color: red; }` or `@media (...)`.
  if (/^@(?:media|import|keyframes|font-face)\b/i.test(trimmed)) return "css";
  if (/^[.#]?[a-z][\w-]*\s*\{[\s\S]*\}/im.test(trimmed) && /:\s*[^;]+;/.test(trimmed)) return "css";

  // TypeScript: explicit type annotations or interface/type alias.
  if (/^\s*(?:export\s+)?(?:interface|type)\s+\w+/m.test(trimmed)) return "ts";

  // JavaScript: import/export, function/const at the top-level — looser
  // than TS so it stays the default for "looks like code, not types".
  if (/^\s*(?:import|export|const|let|var|function|class)\s/m.test(trimmed)) return "js";

  return "txt";
}

/** Suggested filename for a fresh paste. Keeps the timestamp short
 *  enough that two adjacent pastes don't collide but still readable. */
export function suggestPasteFilename(text: string, now: number = Date.now()): string {
  const ext = detectFileExtension(text);
  const stamp = new Date(now)
    .toISOString()
    .slice(0, 16)
    .replace(/[:T-]/g, "")
    .slice(2); // "YYMMDDHHMM"
  return `paste-${stamp}.${ext}`;
}
