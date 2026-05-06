/* FilesPanel — project file browser body.
 *
 * Per-project sandbox content: pulls from /api/projects/<id>/files which
 * returns a flat directory mirror of `web/projects/<id>/`. Files are
 * grouped client-side by inferred kind (page / component / asset).
 *
 * Right-click / kebab on a file:
 *   • Download   — open the raw file via /p/<id>/<path>
 *   • Delete     — POST /api/projects/<id>/file/delete
 *   • Open in canvas — for .jsx components, opens a synthetic preview
 *                      tab at /_preview/<file> that mounts the component
 *                      solo on a centered stage. Chat in this tab is
 *                      scoped to only that file via scopeFile.
 *
 * Drop zone uploads to /api/projects/<id>/file/upload under uploads/.
 *
 * The outer chrome (panel wrapper, tabs, collapse) is owned by
 * LeftPanel — this component renders only the sections + drop zone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import s from "./files.module.css";

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
  /** Open a tab at the given project-relative route. */
  onOpenRoute: (route: string, label: string) => void;
};

export function FilesPanel({ projectId, onOpenRoute }: Props) {
  const [tree, setTree] = useState<FileTree | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) { setTree(null); return; }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
      if (!r.ok) return;
      setTree(await r.json());
    } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh after the AI finishes editing.
  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener("files:invalidate", onChange);
    return () => window.removeEventListener("files:invalidate", onChange);
  }, [refresh]);

  // Close menus on any click outside.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuFor]);

  const downloadFile = (path: string) => {
    if (!projectId) return;
    window.open(`/p/${encodeURIComponent(projectId)}/${path}`, "_blank");
  };

  const deleteFile = async (path: string) => {
    if (!projectId) return;
    if (!confirm(`Delete ${path}?\nThis cannot be undone.`)) return;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Delete failed: ${j.error ?? `HTTP ${r.status}`}`);
        return;
      }
      refresh();
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
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
          body: JSON.stringify({
            path: `uploads/${f.name}`,
            dataUrl,
          }),
        });
      } catch { /* skip */ }
    }
    refresh();
  };

  if (!tree) return <div className={s.empty}>Loading…</div>;

  const pages = tree.files.filter((f) => f.kind === "page");
  const components = tree.files.filter((f) => f.kind === "component");
  const others = tree.files.filter((f) => f.kind === "asset" || f.kind === "config");

  return (
    <>
      <div className={s.section}>
        <div className={s.sectionLabel}>Pages</div>
        {pages.length === 0 && <div className={s.empty}>No pages yet.</div>}
        {pages.map((p) => (
          <FileRow
            key={p.path}
            file={p}
            onActivate={() => onOpenRoute(p.path, p.name)}
            onPreview={undefined}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
            onDownload={downloadFile}
            onDelete={deleteFile}
          />
        ))}
      </div>

      <div className={s.section}>
        <div className={s.sectionLabel}>Components</div>
        {components.length === 0 && <div className={s.empty}>No components.</div>}
        {components.map((c) => (
          <FileRow
            key={c.path}
            file={c}
            onActivate={() => onOpenRoute(`_preview/${c.path}`, c.name)}
            onPreview={() => onOpenRoute(`_preview/${c.path}`, c.name)}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
            onDownload={downloadFile}
            onDelete={deleteFile}
          />
        ))}
      </div>

      {others.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionLabel}>Assets</div>
          {others.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              onActivate={() => downloadFile(f.path)}
              onPreview={undefined}
              menuFor={menuFor}
              setMenuFor={setMenuFor}
              onDownload={downloadFile}
              onDelete={deleteFile}
            />
          ))}
        </div>
      )}

      <DropZone
        active={dropOver}
        onDragEnter={() => setDropOver(true)}
        onDragLeave={() => setDropOver(false)}
        onDrop={async (files) => {
          setDropOver(false);
          await uploadFiles(files);
        }}
      />
    </>
  );
}

function FileRow({
  file, onActivate, onPreview, menuFor, setMenuFor, onDownload, onDelete,
}: {
  file: SandboxFile;
  onActivate: () => void;
  /** Components-only: "Open in canvas" — same target as activate, just labelled differently in the menu. */
  onPreview?: () => void;
  menuFor: string | null;
  setMenuFor: (p: string | null) => void;
  onDownload: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const open = menuFor === file.path;
  const iconClass = file.kind === "component"
    ? `${s.icon} ${s.iconComponent}`
    : (file.kind === "asset" || file.kind === "config")
    ? `${s.icon} ${s.iconAsset}`
    : s.icon;
  const label = file.kind === "page" ? "Page" : file.kind === "component" ? "Component" : file.kind === "config" ? "Source" : "Asset";
  return (
    <div
      className={s.row}
      onClick={onActivate}
      onContextMenu={(e) => { e.preventDefault(); setMenuFor(file.path); }}
    >
      <div className={iconClass}>
        <svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="currentColor" strokeWidth={1.4}>
          <path d="M1 1 H7 L10 4 V12 H1 Z" />
          <path d="M7 1 V4 H10" />
        </svg>
      </div>
      <div className={s.meta}>
        <span className={s.name}>{file.name}</span>
        <span className={s.sub}>{label} · {formatSize(file.size)} · {timeAgo(file.modified)}</span>
      </div>
      <button
        className={s.kebab}
        onClick={(e) => { e.stopPropagation(); setMenuFor(open ? null : file.path); }}
        aria-label="More"
      >
        ⋯
      </button>
      {open && (
        <div className={s.menu} onClick={(e) => e.stopPropagation()}>
          {onPreview && (
            <button className={s.menuItem} onClick={() => { onPreview(); setMenuFor(null); }}>
              ✨ Open in canvas
            </button>
          )}
          <button className={s.menuItem} onClick={() => { onDownload(file.path); setMenuFor(null); }}>
            ↓ Download
          </button>
          <button className={`${s.menuItem} ${s.menuItemDanger}`} onClick={() => { onDelete(file.path); setMenuFor(null); }}>
            🗑 Delete
          </button>
        </div>
      )}
    </div>
  );
}

function DropZone({
  active, onDragEnter, onDragLeave, onDrop,
}: {
  active: boolean;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (files: FileList) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div
      className={`${s.dropZone} ${active ? s.dropZoneActive : ""}`}
      onDragOver={(e) => { e.preventDefault(); onDragEnter(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) onDrop(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      style={{ cursor: "pointer" }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) onDrop(e.target.files);
          e.target.value = "";
        }}
      />
      <div className={s.dropZoneTitle}>↑ Drop files here</div>
      <div>Images, fonts, JSON — uploaded to public/uploads/</div>
    </div>
  );
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
