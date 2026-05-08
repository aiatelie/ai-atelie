/* streamingJson.ts — lenient parser for in-flight `ask_user` tool input.
 *
 * As the model writes the JSON for a `questions_v2` call, the chat
 * sidebar wants to render each completed question as soon as its
 * literal balances. This file provides a small, dependency-free
 * extractor that scans a partial JSON string for:
 *
 *   - The top-level `title` value (whenever its closing quote arrives)
 *   - Each fully-formed object inside the top-level `questions` array
 *
 * Why a custom walker: `JSON.parse` is all-or-nothing — feeding it a
 * truncated string fails outright, so we'd need to truth-find the
 * longest-valid-prefix every delta. That's its own walker AND requires
 * a second `JSON.parse` per delta. Going straight to a structural
 * walker is simpler and faster.
 *
 * The shape we expect (built by mcp/ask-user-server.mjs):
 *   { title: string, questions: [{ id, kind, title, ... }, ...] }
 *
 * Anything else falls back to a single best-effort `JSON.parse` after
 * auto-closing common trailing tokens.
 */

export type StreamingQuestion = Record<string, unknown> & {
  id?: string;
  kind?: string;
  title?: string;
};

export type StreamingParse = {
  /** The form's overall title, once its closing quote has arrived. */
  title?: string;
  /** Every question object whose JSON literal has fully balanced —
   *  parse-ready. Order matches the agent's emission order. */
  questions: StreamingQuestion[];
  /** When true, the entire JSON has parsed cleanly — equivalent to
   *  `JSON.parse(partial)` succeeding. The form can flip its
   *  "Generating questions…" footer off. */
  complete: boolean;
};

const EMPTY: StreamingParse = { questions: [], complete: false };

/** Parse what's parseable out of a partial `questions_v2` JSON blob.
 *  Cheap: O(n) over `partial`. Safe to call on every delta. */
export function parsePartialQuestions(partial: string): StreamingParse {
  if (!partial) return EMPTY;
  // Fast path — fully-formed input.
  try {
    const full = JSON.parse(partial) as { title?: unknown; questions?: unknown };
    if (full && typeof full === "object") {
      return {
        title: typeof full.title === "string" ? full.title : undefined,
        questions: Array.isArray(full.questions) ? (full.questions as StreamingQuestion[]) : [],
        complete: true,
      };
    }
  } catch {}

  // Slow path — walk the partial.
  const out: StreamingParse = { questions: [], complete: false };

  // 1. Try to extract `title` if its string literal is complete.
  const titleMatch = matchTopLevelString(partial, "title");
  if (titleMatch !== undefined) out.title = titleMatch;

  // 2. Walk into questions[] and emit every balanced object.
  const arrStart = findKeyArrayStart(partial, "questions");
  if (arrStart < 0) return out;

  let i = arrStart + 1; // past `[`
  while (i < partial.length) {
    // Skip whitespace and commas.
    while (i < partial.length && (partial[i] === " " || partial[i] === "\n" || partial[i] === "\r" || partial[i] === "\t" || partial[i] === ",")) i++;
    if (i >= partial.length) break;
    if (partial[i] === "]") break; // end of array
    if (partial[i] !== "{") break; // unexpected token; bail
    const end = findBalancedObjectEnd(partial, i);
    if (end < 0) break; // partial object — stop here
    const literal = partial.slice(i, end + 1);
    try {
      const obj = JSON.parse(literal) as StreamingQuestion;
      out.questions.push(obj);
    } catch {
      // Malformed — skip it. We'll re-emit on the next delta.
      break;
    }
    i = end + 1;
  }
  return out;
}

/** Find the index of the `[` that opens the array value of `key` at
 *  the top level of `partial`, or -1 if not found / not yet open.
 *  Tolerates other keys appearing first. */
function findKeyArrayStart(partial: string, key: string): number {
  // Look for `"key"\s*:\s*[`. We don't bother with full JSON-aware
  // search — partial inputs don't have nested keys with this name in
  // the questions_v2 shape.
  const re = new RegExp(`"${key}"\\s*:\\s*\\[`);
  const m = re.exec(partial);
  if (!m) return -1;
  return m.index + m[0].length - 1;
}

/** Pluck out a top-level string value for `key` if its closing quote
 *  has arrived. Returns undefined otherwise. */
function matchTopLevelString(partial: string, key: string): string | undefined {
  const re = new RegExp(`"${key}"\\s*:\\s*"`);
  const m = re.exec(partial);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  let out = "";
  while (i < partial.length) {
    const c = partial[i];
    if (c === "\\") {
      // Escape sequence — try to JSON.parse the surrounding fragment
      // for correctness; cheap because we keep a running buffer.
      if (i + 1 >= partial.length) return undefined;
      const next = partial[i + 1];
      if (next === '"') { out += '"'; i += 2; continue; }
      if (next === "\\") { out += "\\"; i += 2; continue; }
      if (next === "n") { out += "\n"; i += 2; continue; }
      if (next === "t") { out += "\t"; i += 2; continue; }
      if (next === "r") { out += "\r"; i += 2; continue; }
      if (next === "/") { out += "/"; i += 2; continue; }
      if (next === "b") { out += "\b"; i += 2; continue; }
      if (next === "f") { out += "\f"; i += 2; continue; }
      if (next === "u" && i + 5 < partial.length) {
        out += String.fromCharCode(parseInt(partial.slice(i + 2, i + 6), 16));
        i += 6; continue;
      }
      return undefined;
    }
    if (c === '"') return out;
    out += c;
    i++;
  }
  return undefined;
}

/** Given `partial[start] === '{'`, return the index of the matching
 *  `}` at depth 0, or -1 if the object is incomplete. Honors string
 *  literals (so braces inside strings don't count). */
function findBalancedObjectEnd(partial: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < partial.length; i++) {
    const c = partial[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = false; continue; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
