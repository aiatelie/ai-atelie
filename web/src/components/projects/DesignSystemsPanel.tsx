/* DesignSystemsPanel.tsx — list + create + edit + delete UX for the
 * workspace's Design Systems. Rendered inside the home page when the
 * user activates the "Design systems" tab.
 *
 * Three modes:
 *   • "list"    → table of existing DSes + "Create new" button
 *   • "create"  → name + description form, "Save"
 *   • "edit"    → same form pre-filled, plus "Delete" + Published toggle
 *
 * The mode-switch state is owned here; the parent only chooses which
 * top-level home tab is active.
 */

import { useEffect, useRef, useState } from "react";
import s from "./projects.module.css";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  createDesignSystem,
  deleteDesignSystem,
  getDesignSystem,
  publishDesignSystem,
  updateDesignSystem,
  useDesignSystems,
  type DesignSystemSummary,
} from "../../lib/designSystems";

type Mode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; id: string };

export function DesignSystemsPanel() {
  const { all, loading } = useDesignSystems();
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  if (mode.kind === "create") {
    return (
      <DesignSystemEditor
        onCancel={() => setMode({ kind: "list" })}
        onSaved={() => setMode({ kind: "list" })}
      />
    );
  }

  if (mode.kind === "edit") {
    return (
      <DesignSystemEditor
        editingId={mode.id}
        onCancel={() => setMode({ kind: "list" })}
        onSaved={() => setMode({ kind: "list" })}
      />
    );
  }

  return (
    <div className={s.dsPanel}>
      <div className={s.dsHeader}>
        <div>
          <div className={s.dsLead}>Design systems</div>
          <div className={s.dsSub}>
            Teach Claude your brand and product. Bind one to a project and
            every visual decision will follow it.
          </div>
        </div>
        <button
          type="button"
          className={s.dsCreateBtn}
          onClick={() => setMode({ kind: "create" })}
          data-testid="ds-create"
        >
          + Create new design system
        </button>
      </div>

      {loading && all.length === 0 ? (
        <div className={s.dsEmpty}>
          <div className={s.dsEmptyTitle}>Loading…</div>
        </div>
      ) : all.length === 0 ? (
        <div className={s.dsEmpty}>
          <div className={s.dsEmptyTitle}>No design systems yet</div>
          <div className={s.dsEmptyBody}>
            A Design System is a brand definition Claude follows on every
            design turn — colors, typography, voice, component rules.
            Reusable across every project.
          </div>
        </div>
      ) : (
        <ul className={s.dsList}>
          {all.map((ds) => (
            <DesignSystemRow
              key={ds.id}
              ds={ds}
              onEdit={() => setMode({ kind: "edit", id: ds.id })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DesignSystemRow({ ds, onEdit }: { ds: DesignSystemSummary; onEdit: () => void }) {
  const [pubBusy, setPubBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delBusy, setDelBusy] = useState(false);

  const togglePublished = async () => {
    if (pubBusy) return;
    setPubBusy(true);
    try { await publishDesignSystem(ds.id, !ds.published); }
    finally { setPubBusy(false); }
  };

  const doDelete = async () => {
    if (delBusy) return;
    setDelBusy(true);
    try { await deleteDesignSystem(ds.id); }
    finally {
      setDelBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <li className={s.dsRow}>
      <button type="button" className={s.dsRowMain} onClick={onEdit}>
        <span className={s.dsRowName}>{ds.name}</span>
        <span className={s.dsRowMeta}>
          {ds.published ? "Published" : "Draft"} · created {formatDate(ds.createdAt)}
        </span>
      </button>
      <div className={s.dsRowActions}>
        <label className={s.dsToggleWrap} title={ds.published ? "Published" : "Draft"}>
          <input
            type="checkbox"
            className={s.dsToggleInput}
            checked={ds.published}
            disabled={pubBusy}
            onChange={togglePublished}
          />
          <span className={s.dsToggleVisual} aria-hidden="true" />
          <span className={s.dsToggleLabel}>Published</span>
        </label>
        <button
          type="button"
          className={s.dsRowBtn}
          onClick={onEdit}
          aria-label={`Edit ${ds.name}`}
        >
          Edit
        </button>
        <button
          type="button"
          className={`${s.dsRowBtn} ${s.dsRowBtnDanger}`}
          onClick={() => setConfirmDelete(true)}
          aria-label={`Delete ${ds.name}`}
        >
          Delete
        </button>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete design system?"
          body={
            <>
              <strong>{ds.name}</strong> will be permanently removed. Projects
              currently bound to it will keep the reference but the agent
              will silently fall through to no-DS behavior.
            </>
          }
          confirmLabel={delBusy ? "Deleting…" : "Delete"}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={doDelete}
        />
      )}
    </li>
  );
}

function DesignSystemEditor({
  editingId,
  onCancel,
  onSaved,
}: {
  editingId?: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState<boolean>(!!editingId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    if (!editingId) return;
    // `loading` is initialized to `!!editingId` already, so we don't
    // setLoading(true) here — that would trip the cascading-render
    // lint and the initial value is already correct.
    void getDesignSystem(editingId).then((ds) => {
      if (cancelled.current) return;
      if (ds) {
        setName(ds.name);
        setDescription(ds.description);
      } else {
        setError("Design system not found");
      }
      setLoading(false);
    });
    return () => { cancelled.current = true; };
  }, [editingId]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    setError(null);
    if (name.trim().length === 0) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await updateDesignSystem(editingId, { name, description });
      } else {
        await createDesignSystem({ name, description });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <form className={s.dsEditor} onSubmit={submit} noValidate>
      <div className={s.dsEditorHead}>
        <button
          type="button"
          className={s.dsBackBtn}
          onClick={onCancel}
          aria-label="Back to design systems list"
        >
          ← Back
        </button>
        <div className={s.dsEditorTitle}>
          {editingId ? "Edit design system" : "New design system"}
        </div>
      </div>

      <label htmlFor="ds-name" className={s.dsFieldLabel}>Name</label>
      <input
        id="ds-name"
        data-testid="ds-name"
        className={s.formInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Cabin Brand"
        disabled={saving || loading}
        autoFocus
      />

      <label htmlFor="ds-desc" className={s.dsFieldLabel}>
        Describe your brand
      </label>
      <textarea
        id="ds-desc"
        data-testid="ds-description"
        className={s.dsTextarea}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Colors, typography, voice, component rules — anything Claude should always follow. Free-form Markdown."
        disabled={saving || loading}
        rows={16}
      />

      {error && (
        <div className={s.formError} role="alert">{error}</div>
      )}

      <div className={s.dsEditorActions}>
        <button type="button" className={s.dialogBtn} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="submit"
          data-testid="ds-save"
          className={`${s.dialogBtn} ${s.dialogPrimary}`}
          disabled={saving || loading}
        >
          {saving ? "Saving…" : editingId ? "Save changes" : "Create"}
        </button>
      </div>
    </form>
  );
}

function formatDate(ts: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "today";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString();
}

