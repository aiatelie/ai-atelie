/* Projects.tsx — home page (3-column shell).
 *
 * Top: sticky app chrome bar (brand mark + wordmark, avatar slot).
 * Left: sidebar with the always-visible NewProjectForm and the
 *       "Local-first · stored on disk" chip pinned to the bottom.
 * Main: tab strip (single "Projects" tab today, ready for more) above
 *       the project grid. Loading skeleton, empty hero, and populated
 *       grid all render inside the main pane.
 *
 * Project creation is owned by `handleCreate`; the sidebar form calls
 * it directly. Errors surface as an inline `role="alert"` under the
 * form input rather than a browser `alert()`.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import s from "../components/projects/projects.module.css";
import { NewProjectForm } from "../components/projects/NewProjectForm";
import { ConfirmDialog } from "../components/projects/ConfirmDialog";
import { Skeleton } from "../components/feedback";
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
  const [deleting, setDeleting] = useState<Project | null>(null);

  const openProject = (id: string) => {
    setActiveProject(id);
    navigate("/editor");
  };

  /** Owns the create flow. The sidebar form calls this and lets any
   *  thrown error bubble up so it can render the inline alert. */
  const handleCreate = async (name: string) => {
    const trimmed = name.trim() || "Untitled project";
    const p = await createProject(trimmed);
    setActiveProject(p.id);
    // Land directly in the editor. When the project has no real files
    // yet, the editor renders an empty-project chat layout (no canvas,
    // bigger composer, starter chips) and the same intake prompt fires
    // automatically.
    navigate("/editor?fresh=1");
  };

  return (
    <div className={s.shell}>
      <header className={s.appbar}>
        <div className={s.brand}>
          <span className={s.brandMark} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2 L20 6 V18 L12 22 L4 18 V6 Z" />
            </svg>
          </span>
          <span className={s.brandTitle}>AI Atelie</span>
        </div>
      </header>

      <div className={s.body}>
        <aside className={s.sidebar} aria-label="Create project">
          <NewProjectForm onSubmit={handleCreate} />
          <div className={s.sidebarFoot}>
            <span className={s.footerChip}>Local-first · stored on disk</span>
          </div>
        </aside>

        <main className={s.main}>
          <nav className={s.tabstrip} aria-label="Home sections">
            <button
              type="button"
              className={s.tab}
              data-active="true"
              aria-current="page"
            >
              Projects
              {!loading && (
                <span className={s.tabCount} aria-label={`${all.length} projects`}>
                  {all.length}
                </span>
              )}
            </button>
          </nav>

          <div className={s.mainBody}>
            {all.length === 0 ? (
              loading ? (
                <LoadingSkeleton />
              ) : (
                <EmptyState />
              )
            ) : (
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
            )}
          </div>
        </main>
      </div>

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
    <div className={s.grid} aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className={s.card} aria-hidden="true">
          <Skeleton width="60%" height={18} />
          <div className={s.tabsList}>
            <Skeleton variant="rect" width={80} height={20} />
            <Skeleton variant="rect" width={64} height={20} />
          </div>
          <div className={s.cardMeta}>
            <Skeleton width={120} height={11} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className={s.empty}>
      <span className={s.emptyMark} aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7 V18 H21 V9 H12 L10 7 Z" />
        </svg>
      </span>
      <div className={s.emptyTitle}>No projects yet</div>
      <div className={s.emptyBody}>
        A project is a workspace for one banner system, prototype, or design
        exploration. It owns its own tabs, comments, and chat history. Shared
        assets (colors, lotties, components) are global across projects.
        Name yours in the sidebar to get started.
      </div>
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
          className={s.formInput}
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
