/* QuickSwitcher — Cmd/Ctrl+P file palette overlay. Fetches the project
 * file tree on open, filters by case-insensitive substring on path, and
 * calls onOpenRoute on Enter. Esc closes. ↑↓ navigates the list. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import s from "./quickSwitcher.module.css";
import { readRecents, pushRecent } from "./recents";

type SandboxFile = {
  path: string;
  name: string;
  size: number;
  modified: number;
  kind: "page" | "component" | "asset" | "config";
};
type FileTree = { files: SandboxFile[] };

type Props = {
  projectId: string;
  onOpenRoute: (route: string, label: string) => void;
  onClose: () => void;
};

export function QuickSwitcher({ projectId, onOpenRoute, onClose }: Props) {
  const [tree, setTree] = useState<FileTree | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { signal: ctrl.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((next) => { if (next) setTree(next); })
      .catch(() => { /* ignore */ });
    return () => ctrl.abort();
  }, [projectId]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const matches = useMemo(() => {
    const all = tree?.files ?? [];
    const q = query.trim().toLowerCase();
    if (q) {
      return all
        .map((f) => ({ f, score: scoreMatch(f, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.f)
        .slice(0, 50);
    }
    // No query → recents first (still-extant files only), then fill with
    // most-recently-modified files that aren't already in the recent list.
    const recents = readRecents(projectId);
    const byPath = new Map(all.map((f) => [f.path, f] as const));
    const recentFiles: SandboxFile[] = [];
    const seen = new Set<string>();
    for (const p of recents) {
      const hit = byPath.get(p);
      if (hit && !seen.has(p)) { recentFiles.push(hit); seen.add(p); }
    }
    const rest = all
      .filter((f) => !seen.has(f.path))
      .sort((a, b) => b.modified - a.modified);
    return [...recentFiles, ...rest].slice(0, 50);
  }, [tree, query, projectId]);

  // Reset cursor when the result set changes shape.
  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLDivElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const open = useCallback((f: SandboxFile) => {
    const route = f.kind === "component" ? `_preview/${f.path}` : f.path;
    onOpenRoute(route, f.name);
    pushRecent(projectId, f.path);
    onClose();
  }, [onOpenRoute, onClose, projectId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, matches.length - 1)); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const hit = matches[cursor];
      if (hit) open(hit);
    }
  };

  return (
    <div className={s.overlay} onMouseDown={onClose}>
      <div className={s.palette} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className={s.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Open file…"
          spellCheck={false}
        />
        <div className={s.list} ref={listRef}>
          {matches.length === 0 && (
            <div className={s.empty}>{tree ? "No matches" : "Loading…"}</div>
          )}
          {matches.map((f, i) => (
            <div
              key={f.path}
              data-idx={i}
              className={`${s.row} ${i === cursor ? s.rowActive : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => open(f)}
            >
              <span className={s.name}>{f.name}</span>
              <span className={s.path}>{f.path}</span>
              <span className={s.kind}>{labelFor(f)}</span>
            </div>
          ))}
        </div>
        <div className={s.footer}>
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function labelFor(f: SandboxFile): string {
  if (f.kind === "page") return "HTML";
  if (f.kind === "component") return "Component";
  if (f.kind === "config") return "Source";
  return "Asset";
}

/** Cheap fuzzy: prefix-on-name beats substring-on-name beats substring-on-path. */
function scoreMatch(f: SandboxFile, q: string): number {
  const name = f.name.toLowerCase();
  const path = f.path.toLowerCase();
  if (name === q) return 1000;
  if (name.startsWith(q)) return 500;
  if (name.includes(q)) return 250;
  if (path.includes(q)) return 100;
  return 0;
}
