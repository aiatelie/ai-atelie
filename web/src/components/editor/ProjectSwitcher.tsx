/* ProjectSwitcher.tsx — dropdown that replaces the static "Design Files"
 * folder pill. Shows the list of projects, lets you switch / rename /
 * delete, and links out to the Projects dashboard for everything else
 * (creating projects, managing shared assets).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import s from "./projectSwitcher.module.css";
import { ConfirmDialog } from "../projects/ConfirmDialog";
import {
  type Project,
  deleteProject,
  setActiveProject,
  updateProject,
  useProjects,
} from "../../lib/projects";

export function ProjectSwitcher() {
  const { all, active } = useProjects();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position the portal menu against the trigger's viewport rect on open.
  // Done in a layout effect so the menu renders at the right spot before
  // first paint — avoids a one-frame flash at (0, 0).
  useLayoutEffect(() => {
    if (!open) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: r.left });
  }, [open]);

  // Close on outside click and on Escape. The previous onMouseLeave
  // approach lost the menu the moment a user's cursor wandered.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={s.root}>
      <button
        ref={triggerRef}
        type="button"
        className={s.trigger}
        onClick={() => setOpen((v) => !v)}
        title="Switch / manage projects"
        aria-label="Switch project"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className={s.chev}>▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className={s.menu}
          style={{ top: pos.top, left: pos.left }}
        >
          <div className={s.section}>Projects</div>
          {all.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              isActive={p.id === active?.id}
              canDelete={all.length > 1}
              onSwitch={() => { setActiveProject(p.id); setOpen(false); }}
              onRequestDelete={() => { setOpen(false); setDeleting(p); }}
            />
          ))}
          <div className={s.divider} />
          <Link
            to="/projects"
            className={s.action}
            onClick={() => setOpen(false)}
          >
            <span className={s.icon}>▦</span>
            Browse all projects
          </Link>
        </div>,
        document.body,
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete project?"
          body={
            <>
              <strong>{deleting.name}</strong> will be permanently removed,
              along with its tabs, comments, threads, and uploaded files.
              This cannot be undone.
            </>
          }
          confirmLabel="Delete project"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            deleteProject(deleting.id);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

function ProjectRow({
  project,
  isActive,
  canDelete,
  onSwitch,
  onRequestDelete,
}: {
  project: Project;
  isActive: boolean;
  canDelete: boolean;
  onSwitch: () => void;
  onRequestDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  if (editing) {
    return (
      <div className={s.rowEditing}>
        <input
          autoFocus
          className={s.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { updateProject(project.id, { name: draft.trim() || project.name }); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { updateProject(project.id, { name: draft.trim() || project.name }); setEditing(false); }
            if (e.key === "Escape") { setDraft(project.name); setEditing(false); }
          }}
        />
      </div>
    );
  }
  return (
    <div className={`${s.row} ${isActive ? s.rowActive : ""}`}>
      <button className={s.rowMain} onClick={onSwitch}>
        <span className={s.check}>{isActive ? "✓" : ""}</span>
        <span className={s.rowName}>{project.name}</span>
        <span className={s.rowMeta}>{project.openTabs.length} tab{project.openTabs.length === 1 ? "" : "s"}</span>
      </button>
      <button
        className={s.rowAct}
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Rename"
      >
        ✎
      </button>
      {canDelete && (
        <button
          className={s.rowAct}
          onClick={(e) => { e.stopPropagation(); onRequestDelete(); }}
          title="Delete project"
        >
          ×
        </button>
      )}
    </div>
  );
}
