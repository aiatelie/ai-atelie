/* Markdown.tsx — lightweight formatter for assistant replies.
 *
 * Regex-based parser covering code blocks, inline code, bold, italic,
 * lists, and paragraphs. Fenced code blocks are syntax-highlighted via
 * Shiki (lazy-loaded so first render isn't blocked). The Shiki
 * highlighter instance is cached at module scope; per-snippet HTML is
 * memoized so we don't re-tokenize on every parent re-render.
 *
 * Also exports <DiffBlock> — a unified-diff renderer (line numbers,
 * +/- gutters, color-coded rows) backed by jsdiff. It is exported for
 * tool-call edit displays (Edit / MultiEdit / Write) so callers can
 * swap their old red/green block in for a real GitHub-style diff.
 *
 * Usage of DiffBlock:
 *   import { DiffBlock } from "./Markdown";
 *   <DiffBlock oldText={oldStr} newText={newStr} filename={filePath} />
 *
 *   - oldText, newText: required strings.
 *   - filename: optional, rendered in a header above the diff.
 *   - context: optional number of context lines around hunks (default 3).
 */

import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPatch, structuredPatch } from "diff";
import s from "./chat.module.css";

// ─── Inline AST ──────────────────────────────────────────────────────

type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "link"; text: string; href: string };

type TableAlign = "left" | "center" | "right" | null;

type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "codeBlock"; lang: string; code: string }
  | {
      type: "list";
      ordered: boolean;
      items: { content: InlineNode[]; checked: boolean | null }[];
    }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][]; align: TableAlign[] };

/** Bare-URL autolink. Match http(s) URLs and split surrounding text into
 *  text/link nodes. Trailing punctuation that's likely sentence-final gets
 *  stripped from the URL and preserved as text — `(https://x.com).` should
 *  not pull the closing paren + period into the link. */
const URL_RE = /\bhttps?:\/\/[^\s<>"`]+/g;
const TRAILING_PUNCT_RE = /[.,!?;:)\]]+$/;

function autolinkText(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let lastIdx = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (start > lastIdx) out.push({ type: "text", value: text.slice(lastIdx, start) });
    let url = m[0];
    // Pull trailing sentence punctuation out of the link.
    const punct = url.match(TRAILING_PUNCT_RE);
    let trail = "";
    if (punct) {
      trail = punct[0];
      url = url.slice(0, -trail.length);
    }
    out.push({ type: "link", text: url, href: url });
    if (trail) out.push({ type: "text", value: trail });
    lastIdx = start + m[0].length;
  }
  if (lastIdx < text.length) out.push({ type: "text", value: text.slice(lastIdx) });
  return out.length > 0 ? out : [{ type: "text", value: text }];
}

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const patterns = [
    { re: /\[([^\]]+)\]\(([^)]+)\)/g, type: "link" as const },
    { re: /```([^`]+)```/g, type: "code" as const },
    { re: /`([^`]+)`/g, type: "code" as const },
    { re: /\*\*([^*]+)\*\*/g, type: "bold" as const },
    { re: /__([^_]+)__/g, type: "bold" as const },
    { re: /\*([^*]+)\*/g, type: "italic" as const },
    { re: /_([^_]+)_/g, type: "italic" as const },
  ];

  // Simple split-and-match approach
  let remaining = text;
  while (remaining.length > 0) {
    let bestIdx = Infinity;
    let bestLen = 0;
    let bestMatch: RegExpExecArray | null = null;
    let bestType: typeof patterns[number]["type"] | null = null;

    for (const p of patterns) {
      p.re.lastIndex = 0;
      const m = p.re.exec(remaining);
      if (m && m.index < bestIdx) {
        bestIdx = m.index;
        bestLen = m[0].length;
        bestMatch = m;
        bestType = p.type;
      }
    }

    if (bestMatch && bestType) {
      if (bestIdx > 0) {
        // Bare-URL autolink the leading text segment (between matches).
        nodes.push(...autolinkText(remaining.slice(0, bestIdx)));
      }
      if (bestType === "link") {
        nodes.push({ type: "link", text: bestMatch[1], href: bestMatch[2] });
      } else {
        nodes.push({ type: bestType, value: bestMatch[1] });
      }
      remaining = remaining.slice(bestIdx + bestLen);
    } else {
      // No more inline-formatting matches — autolink whatever's left.
      nodes.push(...autolinkText(remaining));
      break;
    }
  }
  return nodes;
}

/** GFM table: a header row `| col | col |` followed by a separator row
 *  `| --- | :--: |`. Returns column count + alignment per column when the
 *  separator line matches; otherwise null so the caller can treat the
 *  current line as a paragraph. */
function parseTableSeparator(line: string): TableAlign[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  const align: TableAlign[] = [];
  for (const raw of cells) {
    const c = raw.trim();
    if (!/^:?-{2,}:?$/.test(c)) return null;
    if (c.startsWith(":") && c.endsWith(":")) align.push("center");
    else if (c.endsWith(":")) align.push("right");
    else if (c.startsWith(":")) align.push("left");
    else align.push(null);
  }
  return align;
}

/** Split a `| a | b | c |` row into trimmed cell texts. */
function splitTableRow(line: string): string[] {
  return line.trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Pull a `[ ]` / `[x]` / `[X]` checkbox marker off the front of a list-item
 *  text. Returns `{ checked, rest }` where `checked` is null when the item
 *  isn't a task list entry. */
function parseChecklistItem(text: string): { checked: boolean | null; rest: string } {
  const m = text.match(/^\[([ xX])\]\s+(.*)$/);
  if (!m) return { checked: null, rest: text };
  return { checked: m[1].toLowerCase() === "x", rest: m[2] };
}

function parseMarkdown(input: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  const lines = input.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "codeBlock", lang, code: codeLines.join("\n") });
      i++;
      continue;
    }

    // GFM table — header line followed by a separator. Look-ahead one line
    // before committing so a non-table pipe line falls through to the
    // paragraph branch.
    if (line.trim().startsWith("|") && i + 1 < lines.length) {
      const align = parseTableSeparator(lines[i + 1]);
      if (align) {
        const header = splitTableRow(line).map(parseInline);
        // Pad alignment to header length so `<td>` rendering can index it.
        while (align.length < header.length) align.push(null);
        const rows: InlineNode[][][] = [];
        i += 2; // skip header + separator
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          const cells = splitTableRow(lines[i]).map(parseInline);
          // Normalize cell count to header so the rendered table doesn't
          // skew when a row is short or trailing-pipe is missing.
          while (cells.length < header.length) cells.push([]);
          rows.push(cells.slice(0, header.length));
          i++;
        }
        blocks.push({ type: "table", header, rows, align });
        continue;
      }
    }

    // List
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[2]);
      const items: { content: InlineNode[]; checked: boolean | null }[] = [];
      let currentItem: string[] = [listMatch[3]];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const nextMatch = next.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (nextMatch && nextMatch[1].length <= listMatch[1].length) {
          const joined = currentItem.join(" ");
          const { checked, rest } = parseChecklistItem(joined);
          items.push({ content: parseInline(rest), checked });
          currentItem = [nextMatch[3]];
          i++;
          continue;
        }
        if (next.trim() === "") {
          const joined = currentItem.join(" ");
          const { checked, rest } = parseChecklistItem(joined);
          items.push({ content: parseInline(rest), checked });
          currentItem = [];
          i++;
          break;
        }
        currentItem.push(next.trim());
        i++;
      }
      if (currentItem.length > 0) {
        const joined = currentItem.join(" ");
        const { checked, rest } = parseChecklistItem(joined);
        items.push({ content: parseInline(rest), checked });
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph
    if (line.trim() !== "") {
      const paraLines: string[] = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !lines[i].startsWith("```") &&
        !lines[i].match(/^(\s*)([-*]|\d+\.)\s+/) &&
        !lines[i].trim().startsWith("|")
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "paragraph", children: parseInline(paraLines.join(" ")) });
      continue;
    }

    i++;
  }

  return blocks;
}

/** Split text on `\n` and emit real <br/> nodes between segments. Replaces
 *  `dangerouslySetInnerHTML` so we can drop the manual escapeHtml() pass —
 *  React handles entity escaping for any string content automatically. */
function withBreaks(text: string, baseKey: string): ReactNode[] {
  const parts = text.split("\n");
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push(<br key={`${baseKey}-br-${i}`} />);
    if (part) out.push(<Fragment key={`${baseKey}-t-${i}`}>{part}</Fragment>);
  });
  return out;
}

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text":
            return <Fragment key={i}>{withBreaks(n.value, String(i))}</Fragment>;
          case "code":
            return <code key={i} className={s.inlineCode}>{n.value}</code>;
          case "bold":
            return <strong key={i}>{n.value}</strong>;
          case "italic":
            return <em key={i}>{n.value}</em>;
          case "link":
            return (
              <a
                key={i}
                href={n.href}
                target="_blank"
                rel="noreferrer noopener"
                className={s.markdownLink}
              >
                {n.text}
              </a>
            );
        }
      })}
    </>
  );
}

// ─── Shiki highlighter (lazy, cached) ────────────────────────────────

// We hold a singleton highlighter promise so only the first <CodeBlock>
// kicks off the dynamic import + WASM load; every other block awaits the
// same promise.
type ShikiHighlighter = {
  codeToHtml: (code: string, opts: { lang: string; theme: string }) => string;
  getLoadedLanguages: () => string[];
};

const SHIKI_THEME = "github-light";
const SHIKI_LANGS = [
  "html",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "json",
  "bash",
  "sh",
  "md",
] as const;
type ShikiLang = (typeof SHIKI_LANGS)[number] | "plaintext";

// Map a fence info-string ("```typescript") to a language Shiki knows.
function normalizeLang(input: string): ShikiLang {
  const v = (input || "").toLowerCase().trim().split(/\s+/)[0];
  if (!v) return "plaintext";
  if (v === "typescript") return "ts";
  if (v === "javascript") return "js";
  if (v === "shell" || v === "zsh") return "bash";
  if (v === "markdown") return "md";
  if (v === "yml") return "plaintext"; // not in our bundle
  if ((SHIKI_LANGS as readonly string[]).includes(v)) return v as ShikiLang;
  return "plaintext";
}

let highlighterPromise: Promise<ShikiHighlighter> | null = null;
function getHighlighter(): Promise<ShikiHighlighter> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const shiki = await import("shiki");
    const hl = await shiki.createHighlighter({
      themes: [SHIKI_THEME],
      langs: SHIKI_LANGS as unknown as string[],
    });
    return hl as unknown as ShikiHighlighter;
  })().catch((err) => {
    // Reset so future renders can retry; fall back to plain text in callers.
    highlighterPromise = null;
    throw err;
  });
  return highlighterPromise;
}

// Cache per (lang, code) so repeated renders of the same block don't
// re-tokenize. Keyed by `${lang}\0${code}`.
const HIGHLIGHT_CACHE = new Map<string, string>();
const HIGHLIGHT_CACHE_LIMIT = 200;
function cacheGet(lang: string, code: string): string | undefined {
  return HIGHLIGHT_CACHE.get(lang + "\0" + code);
}
function cacheSet(lang: string, code: string, html: string) {
  if (HIGHLIGHT_CACHE.size >= HIGHLIGHT_CACHE_LIMIT) {
    // drop oldest entry (Map preserves insertion order)
    const first = HIGHLIGHT_CACHE.keys().next().value;
    if (first !== undefined) HIGHLIGHT_CACHE.delete(first);
  }
  HIGHLIGHT_CACHE.set(lang + "\0" + code, html);
}

function useHighlighted(lang: string, code: string): string | null {
  const normalized = useMemo(() => normalizeLang(lang), [lang]);
  const [html, setHtml] = useState<string | null>(() => cacheGet(normalized, code) ?? null);

  useEffect(() => {
    const hit = cacheGet(normalized, code);
    if (hit) {
      setHtml(hit);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const hl = await getHighlighter();
        const langForShiki: string =
          normalized === "plaintext" || !hl.getLoadedLanguages().includes(normalized)
            ? "plaintext"
            : normalized;
        const out = hl.codeToHtml(code, {
          lang: langForShiki,
          theme: SHIKI_THEME,
        });
        cacheSet(normalized, code, out);
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [normalized, code]);

  return html;
}

// ─── Fenced code block ───────────────────────────────────────────────

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch { /* ignore */ }
  };

  const lines = code.split("\n").length;
  const collapsible = lines > 12;
  const [expanded, setExpanded] = useState(false);
  const highlighted = useHighlighted(lang, code);

  return (
    <div className={s.codeBlock}>
      <div className={s.codeBlockHeader}>
        <span className={s.codeBlockLang}>{lang || "code"}</span>
        <div className={s.codeBlockActions}>
          {collapsible && (
            <button
              className={s.codeBlockToggle}
              onClick={() => setExpanded((e) => !e)}
              type="button"
            >
              {expanded ? "Show less" : `Show all (${lines})`}
            </button>
          )}
          <button className={s.codeBlockCopy} onClick={copy} type="button" title="Copy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
      </div>
      {highlighted ? (
        // Shiki produces a <pre><code>…</code></pre> wrapper with inline
        // styles for the theme background + token colors. We strip its
        // outer chrome via className but keep the tokens.
        <div
          className={s.codeBlockShiki}
          style={collapsible && !expanded ? { maxHeight: 180, overflow: "hidden" } : undefined}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <pre
          className={s.codeBlockPre}
          style={collapsible && !expanded ? { maxHeight: 180, overflow: "hidden" } : undefined}
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

// ─── DiffBlock ───────────────────────────────────────────────────────
//
// Real unified-diff renderer. Wraps jsdiff's `structuredPatch` to get
// hunks with old/new line numbers, then renders them GitHub/Cursor-style
// with +/- gutters and color-coded rows.

type DiffBlockProps = {
  oldText: string;
  newText: string;
  filename?: string;
  /** Number of context lines around hunks (default 3). */
  context?: number;
};

type DiffRow =
  | { kind: "hunk"; header: string }
  | { kind: "context" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string };

function buildDiffRows(oldText: string, newText: string, context: number): DiffRow[] {
  const patch = structuredPatch("a", "b", oldText, newText, "", "", { context });
  const rows: DiffRow[] = [];

  for (const hunk of patch.hunks) {
    rows.push({
      kind: "hunk",
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });

    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;

    for (const raw of hunk.lines) {
      // jsdiff emits a single trailing "\\ No newline at end of file"
      // marker when applicable; surface it as a context row.
      if (raw.startsWith("\\")) {
        rows.push({ kind: "context", oldNo: null, newNo: null, text: raw });
        continue;
      }
      const sign = raw.charAt(0);
      const text = raw.slice(1);
      if (sign === "+") {
        rows.push({ kind: "add", oldNo: null, newNo, text });
        newNo++;
      } else if (sign === "-") {
        rows.push({ kind: "del", oldNo, newNo: null, text });
        oldNo++;
      } else {
        rows.push({ kind: "context", oldNo, newNo, text });
        oldNo++;
        newNo++;
      }
    }
  }

  return rows;
}

function DiffBlockImpl({
  oldText,
  newText,
  filename,
  context = 3,
}: DiffBlockProps) {
  const rows = useMemo(
    () => buildDiffRows(oldText, newText, context),
    [oldText, newText, context],
  );

  // Counts for the header summary (+N / −N).
  const { adds, dels } = useMemo(() => {
    let a = 0;
    let d = 0;
    for (const r of rows) {
      if (r.kind === "add") a++;
      else if (r.kind === "del") d++;
    }
    return { adds: a, dels: d };
  }, [rows]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        createPatch(filename ?? "file", oldText, newText, "", "", { context }),
      );
    } catch { /* ignore */ }
  };

  // Empty diff (texts identical): render a soft "no changes" note instead
  // of a blank box.
  if (rows.length === 0) {
    return (
      <div className={s.diffBlock}>
        <div className={s.diffBlockHeader}>
          <span className={s.diffBlockFilename}>{filename ?? "diff"}</span>
          <span className={s.diffBlockStat}>no changes</span>
        </div>
      </div>
    );
  }

  // Width for the line-number gutter — sized to the largest line number
  // we'll print so digits don't jitter as you scroll.
  let maxNo = 1;
  for (const r of rows) {
    if (r.kind === "hunk") continue;
    if (r.oldNo && r.oldNo > maxNo) maxNo = r.oldNo;
    if (r.newNo && r.newNo > maxNo) maxNo = r.newNo;
  }
  const gutterCh = String(maxNo).length;
  const gutterStyle: CSSProperties = { width: `${gutterCh}ch` };

  return (
    <div className={s.diffBlock}>
      <div className={s.diffBlockHeader}>
        <span className={s.diffBlockFilename}>{filename ?? "diff"}</span>
        <div className={s.diffBlockHeaderRight}>
          <span className={s.diffStatAdd}>+{adds}</span>
          <span className={s.diffStatDel}>−{dels}</span>
          <button
            className={s.codeBlockCopy}
            onClick={copy}
            type="button"
            title="Copy patch"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
      </div>
      <div className={s.diffBlockBody} role="table">
        {rows.map((r, i) => {
          if (r.kind === "hunk") {
            return (
              <div key={i} className={s.diffHunkHeader} role="row">
                <span className={s.diffGutter} style={gutterStyle} aria-hidden />
                <span className={s.diffGutter} style={gutterStyle} aria-hidden />
                <span className={s.diffSign} aria-hidden />
                <span className={s.diffHunkText}>{r.header}</span>
              </div>
            );
          }
          const rowCls =
            r.kind === "add"
              ? s.diffRowAdd
              : r.kind === "del"
                ? s.diffRowDel
                : s.diffRowCtx;
          const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
          return (
            <div key={i} className={`${s.diffRow} ${rowCls}`} role="row">
              <span className={s.diffGutter} style={gutterStyle} aria-hidden>
                {r.oldNo ?? ""}
              </span>
              <span className={s.diffGutter} style={gutterStyle} aria-hidden>
                {r.newNo ?? ""}
              </span>
              <span className={s.diffSign} aria-hidden>{sign}</span>
              <span className={s.diffLineText}>{r.text || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const DiffBlock = memo(DiffBlockImpl);

// ─── Block renderers (memoized for streaming-incremental render) ─────
//
// Each closed block hashes its content via a JSON.stringify-ish key, so
// React can skip re-rendering identical blocks while a streaming reply
// keeps appending fresh ones at the tail. The Shiki tokenizer cache (see
// HIGHLIGHT_CACHE above) plus this memoization is what keeps long
// agent replies smooth as they grow.

const ParagraphBlock = memo(function ParagraphBlock({ nodes }: { nodes: InlineNode[] }) {
  return (
    <p className={s.markdownParagraph}>
      <Inline nodes={nodes} />
    </p>
  );
});

const ListBlock = memo(function ListBlock({
  ordered,
  items,
}: {
  ordered: boolean;
  items: { content: InlineNode[]; checked: boolean | null }[];
}) {
  const Tag = ordered ? "ol" : "ul";
  // Whole list becomes "task list mode" when ANY item carries a checkbox
  // — flatten styling so checkboxes line up with non-task items below.
  const isTaskList = items.some((it) => it.checked !== null);
  return (
    <Tag
      className={`${ordered ? s.markdownOl : s.markdownUl}${isTaskList ? " " + s.markdownTaskList : ""}`}
    >
      {items.map((item, j) => {
        if (item.checked === null) {
          return (
            <li key={j}>
              <Inline nodes={item.content} />
            </li>
          );
        }
        return (
          <li key={j} className={s.markdownTaskItem} data-checked={item.checked}>
            <input
              type="checkbox"
              checked={item.checked}
              readOnly
              className={s.markdownCheckbox}
              aria-label={item.checked ? "Task done" : "Task pending"}
            />
            <span className={item.checked ? s.markdownTaskDone : undefined}>
              <Inline nodes={item.content} />
            </span>
          </li>
        );
      })}
    </Tag>
  );
});

const TableBlock = memo(function TableBlock({
  header,
  rows,
  align,
}: {
  header: InlineNode[][];
  rows: InlineNode[][][];
  align: TableAlign[];
}) {
  return (
    <div className={s.markdownTableWrap}>
      <table className={s.markdownTable}>
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                style={align[i] ? { textAlign: align[i] as "left" | "center" | "right" } : undefined}
              >
                <Inline nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={align[j] ? { textAlign: align[j] as "left" | "center" | "right" } : undefined}
                >
                  <Inline nodes={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

// ─── Entrypoint ──────────────────────────────────────────────────────

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "paragraph":
            return <ParagraphBlock key={i} nodes={b.children} />;
          case "codeBlock":
            return <CodeBlock key={i} lang={b.lang} code={b.code} />;
          case "list":
            return <ListBlock key={i} ordered={b.ordered} items={b.items} />;
          case "table":
            return <TableBlock key={i} header={b.header} rows={b.rows} align={b.align} />;
        }
      })}
    </>
  );
}
