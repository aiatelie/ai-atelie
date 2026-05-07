/* ContextualFilesPanel — Figma-style scoped file list. Shows the active
 * file plus the project files it references (href / src / @import / ES
 * imports). When the active route doesn't map to a real file (e.g. the
 * Design Files tab is active or the project has no tabs), shows a hint.
 *
 * The full project browser still lives in the canvas-area "Design Files"
 * tab — this panel is intentionally narrow on purpose.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import s from "./files.module.css";
import { extractReferences, referencesPath, isScannable } from "./fileRefs";

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
  /** Project-relative route of the active editor tab (e.g. "index.html"
   *  or "_preview/components/foo.jsx"). When this looks like a real file,
   *  we fetch + parse it to resolve referenced files. */
  activeFile: string;
  /** Stripped paths of every open tab — referenced rows that match get a
   *  small "open in tab" dot. */
  openRoutes: Set<string>;
  /** Open a file as a regular editor tab. */
  onOpenRoute: (route: string, label: string) => void;
};

export function ContextualFilesPanel({ projectId, activeFile, openRoutes, onOpenRoute }: Props) {
  const [tree, setTree] = useState<FileTree | null>(null);
  const [refs, setRefs] = useState<SandboxFile[]>([]);
  const [usedBy, setUsedBy] = useState<SandboxFile[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(false);
  const [loadingUsedBy, setLoadingUsedBy] = useState(false);
  // Tracks whether the initial /files fetch has reached a terminal
  // state (success or error). Lets the UI distinguish "still loading"
  // from "failed, here's a retry button" — the panel used to just say
  // "Loading…" forever when the fetch errored or was aborted.
  const [loadError, setLoadError] = useState<string | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    refreshAbort.current?.abort();
    if (!projectId) { setTree(null); setLoadError(null); return; }
    const ctrl = new AbortController();
    refreshAbort.current = ctrl;
    // Hard timeout — if /files hangs (saturated socket pool, server
    // wedge, etc.) we fail fast instead of leaving the panel stuck on
    // "Loading…". 10s is generous; the endpoint normally answers in <5ms.
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    setLoadError(null);
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/files`,
        { signal: ctrl.signal },
      );
      if (!r.ok) {
        if (!ctrl.signal.aborted) setLoadError(`HTTP ${r.status}`);
        return;
      }
      const next = (await r.json()) as Partial<FileTree>;
      if (ctrl.signal.aborted) return;
      // Defensive: malformed response (server bug, mid-deploy, etc.)
      // shouldn't crash the panel. Coerce to a known-good shape.
      setTree({ files: Array.isArray(next?.files) ? next.files : [] });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "AbortError") return;
      if (!ctrl.signal.aborted) setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
    return () => { refreshAbort.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener("files:invalidate", onChange);
    return () => window.removeEventListener("files:invalidate", onChange);
  }, [refresh]);

  // Re-parse references whenever the active file or the file tree
  // changes. Earlier this effect could leave `loadingRefs=true` forever
  // ("Scanning…" spinner stuck) if the cleanup fired before the IIFE
  // resolved (StrictMode double-fire, fast tab switch, hung fetch).
  // Two defenses now:
  //   1. AbortController on the fetch — cleanup actually aborts it
  //      instead of just setting a `cancelled` flag the IIFE may never
  //      check before its own loadingRefs reset.
  //   2. `finally` ALWAYS resets loadingRefs (no `if (!cancelled)`
  //      guard). Worst case: a stale render briefly shows the wrong
  //      list, but the next effect tick corrects it. The previous
  //      gating made "stuck spinner" the failure mode — strictly worse.
  useEffect(() => {
    if (!tree || !projectId) return;
    const path = stripPreviewPrefix(activeFile);
    const self = tree.files.find((f) => f.path === path);
    if (!self) { setRefs([]); setLoadingRefs(false); return; }

    const ctrl = new AbortController();
    setLoadingRefs(true);
    (async () => {
      try {
        const text = await fetchAsText(
          `/p/${encodeURIComponent(projectId)}/${encodePath(path)}`,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        const referenced = extractReferences(text, path);
        const resolved: SandboxFile[] = [];
        for (const ref of referenced) {
          const hit = tree.files.find((f) => f.path === ref);
          if (hit && !resolved.find((r) => r.path === hit.path)) resolved.push(hit);
        }
        setRefs(resolved);
      } catch {
        if (!ctrl.signal.aborted) setRefs([]);
      } finally {
        if (!ctrl.signal.aborted) setLoadingRefs(false);
      }
    })();
    return () => { ctrl.abort(); };
  }, [tree, projectId, activeFile]);

  // "Used by" — scan every scannable file to see which ones import the
  // active file. Skipped for HTML pages (they're rarely imported) and for
  // assets/configs that aren't text-referenced like that. Capped scope:
  // only fetches files we'd plausibly import from (HTML/CSS/JS/JSX).
  useEffect(() => {
    if (!tree || !projectId) { setUsedBy([]); return; }
    const path = stripPreviewPrefix(activeFile);
    const self = tree.files.find((f) => f.path === path);
    if (!self || self.kind === "page") { setUsedBy([]); return; }

    const candidates = tree.files.filter((f) => f.path !== path && isScannable(f.name));
    if (candidates.length === 0) { setUsedBy([]); return; }

    const ctrl = new AbortController();
    setLoadingUsedBy(true);
    (async () => {
      const found: SandboxFile[] = [];
      try {
        for (const cand of candidates) {
          if (ctrl.signal.aborted) return;
          try {
            const text = await fetchAsText(
              `/p/${encodeURIComponent(projectId)}/${encodePath(cand.path)}`,
              ctrl.signal,
            );
            if (referencesPath(text, cand.path, path)) found.push(cand);
          } catch { /* skip individual file errors */ }
        }
        if (!ctrl.signal.aborted) setUsedBy(found);
      } finally {
        // Always reset the loading flag — guard-on-cancelled stuck the
        // "Scanning…" spinner forever when cleanup raced with the loop.
        if (!ctrl.signal.aborted) setLoadingUsedBy(false);
      }
    })();
    return () => { ctrl.abort(); };
  }, [tree, projectId, activeFile]);

  const path = stripPreviewPrefix(activeFile);
  const self = tree?.files.find((f) => f.path === path) ?? null;

  if (!tree) {
    if (loadError) {
      return (
        <div className={s.empty}>
          <p style={{ margin: 0 }}>Couldn't load files: {loadError}</p>
          <button
            type="button"
            onClick={refresh}
            style={{
              marginTop: 10,
              appearance: "none",
              border: "1px solid var(--ink-12)",
              background: "transparent",
              color: "var(--ink-65)",
              borderRadius: 6,
              padding: "5px 12px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return <div className={s.empty}>Loading…</div>;
  }
  if (!self) {
    return (
      <div className={s.empty}>
        <p style={{ margin: 0 }}>
          Open a file (Design Files tab) to see what it uses.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className={s.section}>
        <div className={s.sectionLabel}>
          Referenced{refs.length > 0 ? ` · ${refs.length}` : ""}
        </div>
        {loadingRefs && <div className={s.empty}>Scanning…</div>}
        {!loadingRefs && refs.length === 0 && (
          <div className={s.empty}>No project files referenced from this file.</div>
        )}
        {refs.map((f) => (
          <FileRow
            key={f.path}
            file={f}
            openInTab={openRoutes.has(f.path)}
            onOpen={() => onOpenRoute(routeFor(f), f.name)}
          />
        ))}
      </div>

      {self.kind !== "page" && (
        <div className={s.section}>
          <div className={s.sectionLabel}>
            Used by{usedBy.length > 0 ? ` · ${usedBy.length}` : ""}
          </div>
          {loadingUsedBy && <div className={s.empty}>Scanning…</div>}
          {!loadingUsedBy && usedBy.length === 0 && (
            <div className={s.empty}>Nothing in this project imports it yet.</div>
          )}
          {usedBy.map((f) => (
            <FileRow
              key={`usedby:${f.path}`}
              file={f}
              openInTab={openRoutes.has(f.path)}
              onOpen={() => onOpenRoute(routeFor(f), f.name)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function FileRow({
  file, active, openInTab, onOpen,
}: {
  file: SandboxFile;
  active?: boolean;
  openInTab?: boolean;
  onOpen: () => void;
}) {
  const iconClass = file.kind === "component"
    ? `${s.icon} ${s.iconComponent}`
    : (file.kind === "asset" || file.kind === "config")
    ? `${s.icon} ${s.iconAsset}`
    : s.icon;
  const subtitle = file.kind === "page" ? "HTML page"
    : file.kind === "component" ? "Component"
    : file.kind === "config" ? "Source"
    : "Asset";
  const rowClass = `${s.row} ${active ? s.rowActive : ""} ${openInTab ? s.rowOpen : ""}`.trim();
  return (
    <div
      className={rowClass}
      onClick={onOpen}
      title={openInTab ? `${file.path} — open in tab` : file.path}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", file.path);
        e.dataTransfer.setData("application/x-cc-file-path", file.path);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div className={iconClass}>
        <svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="currentColor" strokeWidth={1.4}>
          <path d="M1 1 H7 L10 4 V12 H1 Z" />
          <path d="M7 1 V4 H10" />
        </svg>
      </div>
      <div className={s.meta}>
        <span className={s.name}>{file.name}</span>
        <span className={s.sub}>{subtitle} · {formatSize(file.size)}</span>
      </div>
      {openInTab && !active && <span className={s.dotOpen} aria-label="Open in tab" />}
    </div>
  );
}

/* ─── Helpers ──────────────────────────────────────────────────────── */
function stripPreviewPrefix(route: string): string {
  return route.startsWith("_preview/") ? route.slice("_preview/".length) : route;
}
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
function routeFor(f: SandboxFile): string {
  if (f.kind === "component") return `_preview/${f.path}`;
  return f.path;
}
async function fetchAsText(url: string, signal?: AbortSignal): Promise<string> {
  // 10s safety timeout. If the static-serve route is wedged on a single
  // file (or the browser's HTTP/1.1 socket pool is saturated), we fail
  // fast instead of hanging "Scanning…" forever.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  const onParentAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onParentAbort);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onParentAbort);
  }
}
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

