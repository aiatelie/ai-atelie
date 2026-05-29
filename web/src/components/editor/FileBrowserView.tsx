/* FileBrowserView — special tab content shown when "Design Files" is
 * active. Two-column layout:
 *   left  → file browser (folders, pages, components, assets)
 *   right → preview of the currently-hovered/selected file
 *
 * Clicking a row activates the file in the preview pane. The "Open"
 * button (or double-click) opens it as a regular editor tab via the
 * onOpenRoute callback supplied by the caller.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import s from "./fileBrowserView.module.css";
import { readRecents, pushRecent, writeRecents } from "./recents";
import { readFolderState, writeFolderState } from "./folderState";
import { EmptyState, CenteredLoader } from "../feedback";
import { toast } from "../toast";
import { PasteAsFileDialog } from "./PasteAsFileDialog";

export type SandboxFile = {
  path: string;
  name: string;
  size: number;
  modified: number;
  kind: "page" | "component" | "asset" | "config";
};
type FileTree = { files: SandboxFile[] };

type Props = {
  projectId: string;
  /** Open the file as a regular editor tab. */
  onOpenRoute: (route: string, label: string) => void;
  /** Stripped paths of every open editor tab — rows with a matching path
   *  show an "open in tab" dot. */
  openRoutes: Set<string>;
  /** Stripped path of the currently active editor tab — gets the
   *  prominent active treatment (accent name + left border). Empty when
   *  no editor file tab is active (e.g. Design Files itself is active). */
  activeRoute: string;
  /** When the parent wants us to scroll-to + flash a row (e.g. user
   *  cmd-clicked the editor tab), it bumps `nonce` while keeping `path`. */
  revealRequest?: { path: string; nonce: number } | null;
};

export function FileBrowserView({ projectId, onOpenRoute, openRoutes, activeRoute, revealRequest }: Props) {
  const [tree, setTree] = useState<FileTree | null>(null);
  // Surface fetch state so a failed/loading initial read isn't an
  // indistinguishable empty tree (the old behavior silently swallowed
  // both `!r.ok` and network errors).
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<SandboxFile | null>(null);
  // Folder-collapse state is per-project: a user who collapsed "uploads"
  // expects it to stay collapsed on the next reopen of the same project.
  // We seed from localStorage on first render, then write back on every
  // change so flipping projects loses no state. Defaults to {} (every
  // folder closed) when nothing is stored, keeping the historical
  // behavior on a fresh browser.
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>(
    () => readFolderState(projectId),
  );
  const [dropOver, setDropOver] = useState(false);
  // Counter that survives nested-element dragenter/dragleave events.
  // Naive setDropOver(true)/(false) on enter/leave flickers each time
  // the cursor crosses a child boundary; tracking depth fixes it. */
  const dragDepthRef = useRef(0);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ file: SandboxFile; x: number; y: number } | null>(null);
  // Path of the row currently flashing from a reveal request. Cleared on a timer.
  const [pulsePath, setPulsePath] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Recently-opened paths, persisted per project. Most-recent first; capped at 6.
  const [recents, setRecents] = useState<string[]>(() => readRecents(projectId));

  const refresh = useCallback(async () => {
    if (!projectId) { setTree(null); return; }
    setLoading(true);
    setError(false);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
      if (!r.ok) {
        setError(true);
        toast.error(`Couldn't load files: HTTP ${r.status}`);
        return;
      }
      const next: FileTree = await r.json();
      setTree(next);
      // Re-resolve the current selection by path so deleted files clear and
      // edited files pick up fresh size/modified. Falls back to the first
      // page (or first file) so the preview pane isn't empty on load.
      setSelected((cur) => {
        if (cur) {
          const stillThere = next.files.find((f) => f.path === cur.path);
          if (stillThere) return stillThere;
        }
        return next.files.find((f) => f.kind === "page") ?? next.files[0] ?? null;
      });
      // Drop recents that point at files which no longer exist on the
      // server (renamed, deleted, garbage-collected). Without this, the
      // Recent section silently hides those entries forever via the
      // existing tree-presence filter — but the localStorage entry
      // sticks around and crowds out fresh paths.
      setRecents((prev) => {
        const present = new Set(next.files.map((f) => f.path));
        const pruned = prev.filter((p) => present.has(p));
        if (pruned.length === prev.length) return prev;
        writeRecents(projectId, pruned);
        return pruned;
      });
    } catch (err) {
      setError(true);
      toast.error(`Couldn't load files: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Reveal-from-tab: scroll to the requested row, select it for preview,
  // briefly flash it. Re-runs every time the parent bumps the nonce.
  useEffect(() => {
    if (!revealRequest || !tree) return;
    const target = tree.files.find((f) => f.path === revealRequest.path);
    if (!target) return;
    setSelected(target);
    // If the file lives inside a folder, ensure that folder is expanded.
    const dir = target.path.includes("/") ? target.path.split("/")[0] : "";
    if (dir) setOpenFolders((prev) => ({ ...prev, [dir]: true }));
    setPulsePath(target.path);
    // Wait a frame so the (possibly newly-expanded) row is in the DOM.
    const raf = requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLDivElement>(
        `[data-path="${cssEscape(target.path)}"]`,
      );
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const t = window.setTimeout(() => setPulsePath(null), 1400);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(t); };
  }, [revealRequest, tree]);
  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener("files:invalidate", onChange);
    return () => window.removeEventListener("files:invalidate", onChange);
  }, [refresh]);

  // Re-seed folder state when the active project changes so each project
  // remembers its own "uploads collapsed / inspirations expanded" shape.
  // FileBrowserView remounts rarely; without this the previous project's
  // map would carry over.
  useEffect(() => { setOpenFolders(readFolderState(projectId)); }, [projectId]);

  // Persist on every change. Cheap (<10 keys, <100 bytes), and keeps
  // the storage in lockstep with React state — no debounce needed.
  useEffect(() => { writeFolderState(projectId, openFolders); }, [projectId, openFolders]);

  // Group files by inferred kind + by directory prefix (uploads/, bg/, etc.).
  // When the user has typed a query, filter to case-insensitive substring
  // matches on the full path before grouping so empty sections drop out.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const treeFiles = tree?.files ?? [];
    const all = q ? treeFiles.filter((f) => f.path.toLowerCase().includes(q)) : treeFiles;
    const folders = new Map<string, SandboxFile[]>();
    const pages: SandboxFile[] = [];
    const components: SandboxFile[] = [];
    const source: SandboxFile[] = [];
    const assets: SandboxFile[] = [];
    for (const f of all) {
      const dir = f.path.includes("/") ? f.path.split("/")[0] : "";
      if (dir) {
        const list = folders.get(dir) ?? [];
        list.push(f);
        folders.set(dir, list);
        continue;
      }
      if (f.kind === "page") pages.push(f);
      else if (f.kind === "component") components.push(f);
      else if (f.kind === "config") source.push(f);
      else assets.push(f);
    }
    const byModifiedDesc = (a: SandboxFile, b: SandboxFile) => b.modified - a.modified;
    pages.sort(byModifiedDesc);
    components.sort(byModifiedDesc);
    source.sort(byModifiedDesc);
    assets.sort(byModifiedDesc);
    for (const list of folders.values()) list.sort(byModifiedDesc);
    return { folders, pages, components, source, assets };
  }, [tree, query]);

  const openMenu = (f: SandboxFile) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ file: f, x: e.clientX, y: e.clientY });
  };

  const openFile = (f: SandboxFile) => {
    onOpenRoute(routeFor(f), f.name);
    setRecents(pushRecent(projectId, f.path));
  };

  const deleteFile = async (f: SandboxFile) => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: f.path }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(`Couldn't delete ${f.name}: ${err.error ?? `HTTP ${res.status}`}`);
        return;
      }
      // Drop the now-stale entry from the preview pane and recents,
      // then refetch the tree.
      setSelected((cur) => (cur?.path === f.path ? null : cur));
      setRecents((prev) => prev.filter((p) => p !== f.path));
      await refresh();
      toast.success(`Deleted ${f.name}`);
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    if (!projectId) return;
    const list = Array.from(files);
    for (const f of list) {
      const dataUrl: string = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      });
      try {
        await fetch(`/api/projects/${encodeURIComponent(projectId)}/file/upload`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: `uploads/${f.name}`, dataUrl }),
        });
      } catch { /* skip */ }
    }
    refresh();
  };

  /** Write a textual paste at uploads/<name>. Goes through the upload
   *  endpoint so file-write permissions stay in one place. */
  const writePastedFile = async (filename: string, content: string) => {
    if (!projectId) return;
    const safeName = filename.replace(/[\\/]/g, "_");
    const dataUrl = `data:text/plain;base64,${btoa(unescape(encodeURIComponent(content)))}`;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: `uploads/${safeName}`, dataUrl }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(`Couldn't save ${safeName}: ${err.error ?? `HTTP ${res.status}`}`);
        return;
      }
      await refresh();
      toast.success(`Saved ${safeName}`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Pull image-typed entries out of a clipboard event and route them
   *  through the existing upload flow. Returns true if anything was
   *  handled so the caller can preventDefault. */
  const consumeClipboardImages = (data: DataTransfer | null): boolean => {
    if (!data) return false;
    const files: File[] = [];
    for (const item of Array.from(data.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return false;
    void uploadFiles(files);
    return true;
  };

  return (
    <div
      className={`${s.shell} ${dropOver ? s.shellDrop : ""}`}
      onDragEnter={(e) => {
        // Only count drags that actually carry files. Internal drags
        // (e.g. row reordering, chat composer chips) shouldn't trigger
        // the upload overlay.
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepthRef.current += 1;
        if (dragDepthRef.current === 1) setDropOver(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDropOver(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        dragDepthRef.current = 0;
        setDropOver(false);
        if (e.dataTransfer.files.length) await uploadFiles(e.dataTransfer.files);
      }}
      onPaste={(e) => {
        // Skip when the user is typing inside any input/textarea
        // (e.g. the filter search). We only want clipboard-image
        // paste to land here when the panel is the focused container.
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (consumeClipboardImages(e.clipboardData)) e.preventDefault();
      }}
    >
      <div className={s.list} ref={listRef}>
        <div className={s.crumb}>
          <button className={s.crumbBtn} onClick={refresh} title="Refresh">↻</button>
          <span className={s.crumbPath}>project</span>
          <div className={s.crumbActions}>
            <button
              type="button"
              className={s.crumbAction}
              onClick={() => setPasteOpen(true)}
              title="Paste text or markdown into a new file"
            >
              Paste…
            </button>
            <button
              type="button"
              className={s.crumbAction}
              onClick={() => uploadInputRef.current?.click()}
              title="Upload one or more files"
            >
              Upload
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <input
            className={s.search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files…"
            spellCheck={false}
          />
        </div>

        {/* Initial fetch state — only when the tree has never loaded.
         * A failed read used to fall through to an empty tree, making a
         * transport error indistinguishable from an empty project. */}
        {tree === null && loading && <CenteredLoader label="Loading files…" />}
        {tree === null && error && !loading && (
          <EmptyState
            tone="error"
            size="sm"
            title="Couldn’t load files"
            body="Something went wrong reading this project."
            action={
              <button type="button" className={s.crumbAction} onClick={() => refresh()}>
                Retry
              </button>
            }
          />
        )}

        {/* File sections — suppressed during the initial loading/error
         * state above so we don't double-render an empty tree under the
         * loader or error card. */}
        {!(tree === null && (loading || error)) && (<>
        {/* Recent — only shown when no filter is active. */}
        {!query.trim() && (() => {
          const seen = new Set<string>();
          const recentFiles: SandboxFile[] = [];
          for (const p of recents) {
            if (seen.has(p)) continue;
            const hit = tree?.files.find((f) => f.path === p);
            if (hit) { recentFiles.push(hit); seen.add(p); }
          }
          if (recentFiles.length === 0) return null;
          return (
            <Section label="Recent" count={recentFiles.length}>
              {recentFiles.map((f) => (
                <FileRow
                  key={`recent:${f.path}`}
                  file={f}
                  selected={selected?.path === f.path}
                  activeTab={activeRoute === f.path}
                  openInTab={openRoutes.has(f.path)}
                  pulse={pulsePath === f.path}
                  onSelect={() => setSelected(f)}
                  onActivate={() => openFile(f)}
                  onContextMenu={openMenu(f)}
                  onOpenMenu={openMenu(f)}
                />
              ))}
            </Section>
          );
        })()}

        {/* Folders */}
        {groups.folders.size > 0 && (
          <Section label="Folders" count={groups.folders.size}>
            {Array.from(groups.folders.entries()).map(([dir, files]) => {
              // Force-open folders while filtering so matches inside them are visible.
              const open = query.trim() ? true : (openFolders[dir] ?? false);
              return (
                <div key={dir} className={s.folder}>
                  <div
                    className={s.folderRow}
                    onClick={() => setOpenFolders((p) => ({ ...p, [dir]: !open }))}
                  >
                    <span className={s.chev}>{open ? "▾" : "▸"}</span>
                    <FolderIcon />
                    <span className={s.name}>{dir}</span>
                    <span className={s.sub}>{files.length}</span>
                  </div>
                  {open && files.map((f) => (
                    <FileRow
                      key={f.path}
                      file={f}
                      selected={selected?.path === f.path}
                      activeTab={activeRoute === f.path}
                      openInTab={openRoutes.has(f.path)}
                      pulse={pulsePath === f.path}
                      onSelect={() => setSelected(f)}
                      onActivate={() => openFile(f)}
                      onContextMenu={openMenu(f)}
                      onOpenMenu={openMenu(f)}
                      indent
                    />
                  ))}
                </div>
              );
            })}
          </Section>
        )}

        {/* Pages */}
        <Section label="Pages" count={groups.pages.length}>
          {groups.pages.length === 0 && (
            <EmptyState
              title="No pages yet"
              body="Ask Claude to scaffold one, or drop in a starter file."
              size="sm"
            />
          )}
          <RowList
            items={groups.pages}
            renderItem={(f) => (
              <FileRow
                key={f.path}
                file={f}
                selected={selected?.path === f.path}
                activeTab={activeRoute === f.path}
                openInTab={openRoutes.has(f.path)}
                pulse={pulsePath === f.path}
                onSelect={() => setSelected(f)}
                onActivate={() => openFile(f)}
                onContextMenu={openMenu(f)}
                onOpenMenu={openMenu(f)}
              />
            )}
          />
        </Section>

        {/* Components */}
        {groups.components.length > 0 && (
          <Section label="Components" count={groups.components.length}>
            <RowList
              items={groups.components}
              renderItem={(f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  selected={selected?.path === f.path}
                  activeTab={activeRoute === f.path}
                  openInTab={openRoutes.has(f.path)}
                  pulse={pulsePath === f.path}
                  onSelect={() => setSelected(f)}
                  onActivate={() => openFile(f)}
                  onContextMenu={openMenu(f)}
                  onOpenMenu={openMenu(f)}
                />
              )}
            />
          </Section>
        )}

        {/* Source (CSS / JS / JSON) */}
        {groups.source.length > 0 && (
          <Section label="Source" count={groups.source.length}>
            <RowList
              items={groups.source}
              renderItem={(f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  selected={selected?.path === f.path}
                  activeTab={activeRoute === f.path}
                  openInTab={openRoutes.has(f.path)}
                  pulse={pulsePath === f.path}
                  onSelect={() => setSelected(f)}
                  onActivate={() => openFile(f)}
                  onContextMenu={openMenu(f)}
                  onOpenMenu={openMenu(f)}
                />
              )}
            />
          </Section>
        )}

        {/* Assets (images, video, audio, other) */}
        {groups.assets.length > 0 && (
          <Section label="Assets" count={groups.assets.length}>
            <RowList
              items={groups.assets}
              renderItem={(f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  selected={selected?.path === f.path}
                  activeTab={activeRoute === f.path}
                  openInTab={openRoutes.has(f.path)}
                  pulse={pulsePath === f.path}
                  onSelect={() => setSelected(f)}
                  onActivate={() => openFile(f)}
                  onContextMenu={openMenu(f)}
                  onOpenMenu={openMenu(f)}
                />
              )}
            />
          </Section>
        )}

        <div className={s.dropHint}>
          <span className={s.dropHintLabel}>↑ Drop files here</span>
          <span className={s.dropHintBody}>Images, docs, references, Figma links, or folders — Claude will use them as context.</span>
        </div>
        </>)}
      </div>

      <FilePreview
        projectId={projectId}
        file={selected}
        openInTab={selected ? openRoutes.has(selected.path) : false}
        onOpen={(f) => openFile(f)}
      />
      {menu && (
        <FileContextMenu
          file={menu.file}
          x={menu.x}
          y={menu.y}
          projectId={projectId}
          onOpen={() => { openFile(menu.file); setMenu(null); }}
          onDelete={() => { void deleteFile(menu.file); }}
          onClose={() => setMenu(null)}
        />
      )}
      <PasteAsFileDialog
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        onSubmit={(filename, content) => writePastedFile(filename, content)}
      />
      {dropOver && (
        <div className={s.dropOverlay} aria-hidden="true">
          <div className={s.dropOverlayCard}>
            <span className={s.dropOverlayIcon} aria-hidden="true">↑</span>
            <span className={s.dropOverlayLabel}>Drop to upload</span>
            <span className={s.dropOverlayBody}>
              Images, docs, references — Claude will use them as context.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function FileContextMenu({
  file, x, y, projectId, onOpen, onDelete, onClose,
}: {
  file: SandboxFile;
  x: number;
  y: number;
  projectId: string;
  onOpen: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onClick = () => onClose();
    window.addEventListener("keydown", onKey);
    // Defer click listener so the right-click that opened us doesn't close it.
    const t = setTimeout(() => window.addEventListener("mousedown", onClick), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
    onClose();
  };
  const downloadHref = `/p/${encodeURIComponent(projectId)}/${encodePath(file.path)}`;
  return (
    <div
      className={s.menu}
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      <button className={s.menuItem} onClick={onOpen}>Open</button>
      <a
        className={s.menuItem}
        href={downloadHref}
        download={file.name}
        onClick={onClose}
      >
        Download
      </a>
      <button className={s.menuItem} onClick={() => copy(file.path)}>Copy path</button>
      <button className={s.menuItem} onClick={() => copy(file.name)}>Copy filename</button>
      <div className={s.menuDivider} role="separator" />
      {confirming ? (
        <button
          className={`${s.menuItem} ${s.menuItemDanger}`}
          onClick={() => { onDelete(); onClose(); }}
        >
          Confirm delete
        </button>
      ) : (
        <button
          className={`${s.menuItem} ${s.menuItemDanger}`}
          onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
        >
          Delete…
        </button>
      )}
    </div>
  );
}

/** Pick a `data-kind` attribute for the row icon. CSS targets these
 *  to give image / video / audio / pdf / code / other their own
 *  background+border tone, which makes a long file list scan-able by
 *  glyph color rather than reading every name. */
function iconKindFor(f: SandboxFile): string {
  if (f.kind === "page") return "page";
  if (f.kind === "component") return "component";
  if (f.kind === "config") return "code";
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["json", "ts", "tsx", "js", "jsx", "css", "scss", "html", "md", "yaml", "yml", "toml"].includes(ext)) return "code";
  return "other";
}

/** Pages open as their path, components open through the synthetic
 *  /_preview/ wrapper, everything else is a download. */
function routeFor(f: SandboxFile): string {
  if (f.kind === "component") return `_preview/${f.path}`;
  return f.path;
}

function Section({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
  return (
    <div className={s.section}>
      <div className={s.sectionLabel}>
        <span>{label}</span>
        {typeof count === "number" && count > 0 && (
          <span className={s.sectionCount}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/** Render the first `initialLimit` rows; expose a "Show N more…"
 *  button that swaps to the full list inside a useTransition so the
 *  UI doesn't stutter on big projects (Claude can produce hundreds of
 *  files in a long session). */
const INITIAL_SECTION_LIMIT = 30;

function RowList<T>({
  items,
  initialLimit = INITIAL_SECTION_LIMIT,
  renderItem,
}: {
  items: T[];
  initialLimit?: number;
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const [, startTransition] = useTransition();
  // Reset whenever the underlying list shrinks below the cap (e.g.
  // after a delete) so the button doesn't linger pointing at zero.
  useEffect(() => {
    if (items.length <= initialLimit && showAll) setShowAll(false);
  }, [items.length, initialLimit, showAll]);
  const visible = showAll ? items : items.slice(0, initialLimit);
  const hidden = items.length - visible.length;
  return (
    <>
      {visible.map(renderItem)}
      {hidden > 0 && (
        <button
          type="button"
          className={s.showMore}
          onClick={() => startTransition(() => setShowAll(true))}
        >
          Show {hidden} more
        </button>
      )}
    </>
  );
}

function FileRow({
  file, selected, activeTab, openInTab, pulse, onSelect, onActivate, onContextMenu, onOpenMenu, indent,
}: {
  file: SandboxFile;
  selected: boolean;
  activeTab?: boolean;
  openInTab?: boolean;
  pulse?: boolean;
  onSelect: () => void;
  onActivate: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Open the row's kebab menu anchored to the click point. */
  onOpenMenu?: (e: React.MouseEvent) => void;
  indent?: boolean;
}) {
  const Icon = file.kind === "component" ? ComponentIcon : file.kind === "asset" ? AssetIcon : PageIcon;
  const subtitle = file.kind === "page" ? "HTML page"
    : file.kind === "component" ? "Component"
    : file.kind === "config" ? "Source"
    : guessAssetLabel(file.name);
  const rowClass = [
    s.row,
    selected ? s.rowActive : "",
    activeTab ? s.rowEditorActive : "",
    openInTab ? s.rowOpen : "",
    pulse ? s.rowPulse : "",
    indent ? s.rowIndent : "",
  ].filter(Boolean).join(" ");
  const tipBits = [file.path];
  if (activeTab) tipBits.push("active tab");
  else if (openInTab) tipBits.push("open in tab");
  tipBits.push("double-click to open");
  return (
    <div
      className={rowClass}
      onClick={onSelect}
      onDoubleClick={onActivate}
      onContextMenu={onContextMenu}
      title={tipBits.join(" — ")}
      data-path={file.path}
      draggable
      onDragStart={(e) => {
        // text/plain so the chat textarea (and any other plain target)
        // accepts it natively. Custom MIME lets the chat composer
        // distinguish a file-reference drop from random pasted text.
        e.dataTransfer.setData("text/plain", file.path);
        e.dataTransfer.setData("application/x-cc-file-path", file.path);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div
        className={`${s.icon} ${file.kind === "component" ? s.iconComponent : (file.kind === "asset" || file.kind === "config") ? s.iconAsset : ""}`}
        data-kind={iconKindFor(file)}
      >
        <Icon />
      </div>
      <div className={s.meta}>
        <span className={s.name}>{file.name}</span>
        <span className={s.sub}>{subtitle}</span>
      </div>
      {openInTab && !activeTab && <span className={s.dotOpen} aria-label="Open in tab" />}
      <span className={s.modified}>{timeAgo(file.modified)}</span>
      {onOpenMenu && (
        <button
          type="button"
          className={s.kebab}
          onClick={(e) => { e.stopPropagation(); onOpenMenu(e); }}
          aria-label={`Actions for ${file.name}`}
          title="More actions"
        >
          ⋯
        </button>
      )}
    </div>
  );
}

function FilePreview({
  projectId, file, openInTab, onOpen,
}: {
  projectId: string;
  file: SandboxFile | null;
  openInTab: boolean;
  onOpen: (f: SandboxFile) => void;
}) {
  // Local nonce so the user can manually refresh the preview without
  // touching anything else. Bumped by clicking the ↻ button.
  const [refreshTick, setRefreshTick] = useState(0);
  // Scale factor for the iframe. CSS can't derive a unitless number
  // from a length, so we measure previewBody and write the ratio into a
  // custom property the iframe rule reads.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const apply = (w: number) => {
      el.style.setProperty("--preview-scale", String(w / 1280));
    };
    apply(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) apply(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [file?.path]);

  if (!file) {
    return (
      <aside className={s.preview}>
        <EmptyState
          title="Nothing to preview"
          body="Pick a file on the left to see it render here."
          size="sm"
        />
      </aside>
    );
  }
  const cacheKey = `${file.modified}:${refreshTick}`;
  const previewUrl = `/p/${encodeURIComponent(projectId)}/${encodePath(file.path)}?v=${cacheKey}`;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
  return (
    <aside className={s.preview}>
      <div className={s.previewBody} ref={bodyRef}>
        <PreviewSurface file={file} url={previewUrl} projectId={projectId} cacheKey={cacheKey} />
        <button
          className={s.previewRefresh}
          onClick={() => setRefreshTick((n) => n + 1)}
          title="Refresh preview"
          aria-label="Refresh preview"
        >↻</button>
      </div>

      <div className={s.previewActions}>
        <button className={s.previewAction} onClick={() => onOpen(file)} title="Open as tab">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 3 H13 V7" />
            <path d="M13 3 L7 9" />
            <path d="M11 11 V13 H3 V5 H5" />
          </svg>
          Open
        </button>
        <button className={s.previewActionGhost} onClick={() => copy(file.path)} title="Copy project-relative path">
          Copy path
        </button>
        <button className={s.previewActionGhost} onClick={() => copy(file.name)} title="Copy filename">
          Copy name
        </button>
      </div>

      {dir && (
        <div className={s.previewCrumbs} title={file.path}>
          {dir.split("/").map((seg, i, arr) => (
            <span key={i}>
              {seg}
              {i < arr.length - 1 && <span className={s.previewCrumbSep}> / </span>}
            </span>
          ))}
        </div>
      )}
      <div className={s.previewNameRow}>
        <div className={s.previewName}>{file.name}</div>
        {openInTab && <span className={s.previewPill}>Open in tab</span>}
      </div>
      <div className={s.previewType}>{labelFor(file)}</div>
      <div className={s.previewMeta}>
        Modified {timeAgo(file.modified)} · {formatSize(file.size)} · {extOf(file.name).toUpperCase()}
      </div>
    </aside>
  );
}

function PreviewSurface({
  file, url, projectId, cacheKey,
}: { file: SandboxFile; url: string; projectId: string; cacheKey: string }) {
  const ext = extOf(file.name).toLowerCase();
  if (ext === "html" || file.kind === "page") {
    return (
      <iframe
        className={s.previewFrame}
        src={url}
        title={file.name}
      />
    );
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) {
    return <img className={s.previewImg} src={url} alt={file.name} />;
  }
  if (file.kind === "component") {
    // The server's _preview/ route renders the component on a solo stage.
    const previewUrl = `/p/${encodeURIComponent(projectId)}/_preview/${encodePath(file.path)}?v=${cacheKey}`;
    return (
      <iframe
        className={s.previewFrame}
        src={previewUrl}
        title={file.name}
      />
    );
  }
  return (
    <div className={s.previewPlaceholder}>
      <AssetIcon />
      <p>{file.name}</p>
    </div>
  );
}

/* ─── Icons ────────────────────────────────────────────────────────── */
function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4 H6 L7.5 6 H14 V13 H2 Z" />
    </svg>
  );
}
export function PageIcon() {
  // Document with folded corner — HTML/page metaphor.
  return (
    <svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M1 1 H7 L10 4 V12 H1 Z" />
      <path d="M7 1 V4 H10" />
    </svg>
  );
}
export function ComponentIcon() {
  // Angle brackets — JSX/component metaphor.
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2 L1 5.5 L4 9" />
      <path d="M9 2 L12 5.5 L9 9" />
      <path d="M7.5 1.5 L5.5 9.5" />
    </svg>
  );
}
export function AssetIcon() {
  // Picture frame with sun + horizon — image/asset metaphor.
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <rect x="1" y="1" width="11" height="9" rx="1" />
      <circle cx="4" cy="4" r="0.9" fill="currentColor" stroke="none" />
      <path d="M1.5 9 L5 6 L7.5 7.5 L10 5 L12 7" />
    </svg>
  );
}

/* ─── Formatting helpers ───────────────────────────────────────────── */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
function cssEscape(s: string): string {
  // CSS.escape isn't quite universal in older webviews; backslash-escape
  // the handful of characters we see in real file paths.
  return s.replace(/["\\]/g, "\\$&");
}
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1);
}
function labelFor(f: SandboxFile): string {
  if (f.kind === "page") return "HTML page";
  if (f.kind === "component") return "Component";
  if (f.kind === "config") return "Source";
  return guessAssetLabel(f.name);
}
function guessAssetLabel(name: string): string {
  const ext = extOf(name).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return "Image";
  if (ext === "json") return "JSON";
  if (["mp4", "mov", "webm"].includes(ext)) return "Video";
  if (["mp3", "wav", "ogg"].includes(ext)) return "Audio";
  if (ext === "pdf") return "PDF";
  return "Asset";
}
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}
