/* Projects.tsx — dashboard / first-run page for the editor.
 *
 * Shows a card grid of all projects, with a header "+ New project" button
 * and a hero empty-state when there are zero projects. Clicking a card
 * activates that project and routes to /editor.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import s from "../components/projects/projects.module.css";
import { NewProjectDialog } from "../components/projects/NewProjectDialog";
import { ConfirmDialog } from "../components/projects/ConfirmDialog";
import {
  createProject,
  deleteProject,
  setActiveProject,
  updateProject,
  useProjects,
  type Project,
} from "../lib/projects";

export default function Projects() {
  const { all, loading } = useProjects();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);

  const openProject = (id: string) => {
    setActiveProject(id);
    navigate("/editor");
  };

  const handleCreate = async (name: string) => {
    const trimmed = name.trim() || "Untitled project";
    try {
      const p = await createProject(trimmed);
      setActiveProject(p.id);
      // Land directly in the editor. When the project has no real files
      // yet, the editor renders an empty-project chat layout (no canvas,
      // bigger composer, starter chips) and the same intake prompt fires
      // automatically — so this replaces the old /projects/:id/start
      // wizard while keeping Claude's behaviour identical.
      navigate("/editor?fresh=1");
    } catch (err) {
      alert(`Couldn't create project: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={s.shell}>
      <div className={s.inner}>
        <header className={s.header}>
          <div className={s.brand}>
            <span className={s.brandMark}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2 L20 6 V18 L12 22 L4 18 V6 Z" />
              </svg>
            </span>
            <div>
              <div className={s.brandTitle}>AI Atelie</div>
              <div className={s.brandSub}>YOUR PROJECTS</div>
            </div>
          </div>
          {all.length > 0 && (
            <button className={s.newBtn} onClick={() => setCreating(true)}>
              + New project
            </button>
          )}
        </header>

        {all.length === 0 ? (
          loading ? (
            <LoadingSkeleton />
          ) : (
            <EmptyState onCreate={() => setCreating(true)} />
          )
        ) : (
          <>
            <div className={s.sectionLabel}>Projects · {all.length}</div>
            <div className={s.grid}>
              {all.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onOpen={() => openProject(p.id)}
                  onDelete={() => setDeleting(p)}
                  onRename={(next) => updateProject(p.id, { name: next })}
                />
              ))}
            </div>
          </>
        )}

        <footer className={s.footer}>
          <span className={s.footerChip}>Local-first · stored on disk</span>
        </footer>
      </div>

      {creating && (
        <NewProjectDialog
          onCancel={() => setCreating(false)}
          onConfirm={async (name) => {
            await handleCreate(name);
            setCreating(false);
          }}
        />
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

function LoadingSkeleton() {
  return (
    <>
      <div className={s.sectionLabel} aria-busy="true">Projects · …</div>
      <div className={s.grid}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={s.card} aria-hidden="true" style={{ opacity: 0.35 }}>
            <div className={s.cardName} style={{ background: "currentColor", height: 18, borderRadius: 4, opacity: 0.15, width: "60%" }} />
            <div className={s.tabsList}>
              <span className={s.tabPill} style={{ width: 80 }}>&nbsp;</span>
              <span className={s.tabPill} style={{ width: 64 }}>&nbsp;</span>
            </div>
            <div className={s.cardMeta}>
              <span>&nbsp;</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={s.empty}>
      <span className={s.emptyMark}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7 V18 H21 V9 H12 L10 7 Z" />
        </svg>
      </span>
      <div className={s.emptyTitle}>No projects yet</div>
      <div className={s.emptyBody}>
        A project is a workspace for one banner system, prototype, or design exploration.
        It owns its own tabs, comments, and chat history. Shared assets (colors, lotties,
        components) are global across projects.
      </div>
      <button className={s.newBtn} onClick={onCreate}>
        + Create your first project
      </button>
    </div>
  );
}

function ProjectCard({
  project, onOpen, onDelete, onRename,
}: {
  project: Project;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);

  const tabsLabel = `${project.openTabs.length} tab${project.openTabs.length === 1 ? "" : "s"}`;
  const lastUpdated = formatTime(project.updatedAt);

  if (editing) {
    return (
      <div className={s.card} onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className={s.dialogInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(draft.trim() || project.name); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onRename(draft.trim() || project.name); setEditing(false); }
            if (e.key === "Escape") { setDraft(project.name); setEditing(false); }
          }}
        />
        <div className={s.cardMeta}>
          <span>{tabsLabel}</span>
          <span>·</span>
          <span>{lastUpdated}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={s.card} onClick={onOpen}>
      <div className={s.cardName}>{project.name}</div>
      <div className={s.tabsList}>
        {project.openTabs.slice(0, 5).map((t) => (
          <span key={t.id} className={s.tabPill}>{t.label}</span>
        ))}
        {project.openTabs.length > 5 && (
          <span className={s.tabPill}>+{project.openTabs.length - 5}</span>
        )}
      </div>
      <div className={s.cardMeta}>
        <span>{tabsLabel}</span>
        <span>·</span>
        <span>{lastUpdated}</span>
      </div>
      <div className={s.cardActions}>
        <button
          className={s.cardActBtn}
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          title="Rename"
        >✎</button>
        <button
          className={s.cardActBtn}
          data-danger="true"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete"
        >×</button>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}
