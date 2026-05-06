/* NewProjectDialog.tsx — modal that prompts for a project name and
 * routes through createProject. Used by both the Projects dashboard
 * and the in-editor ProjectSwitcher dropdown so the "New project"
 * action looks and behaves the same way regardless of entry point.
 */

import { useEffect, useState } from "react";
import s from "./projects.module.css";

type Props = {
  onCancel: () => void;
  /** May be async — the dialog enters a busy state until it resolves. */
  onConfirm: (name: string) => void | Promise<void>;
};

export function NewProjectDialog({ onCancel, onConfirm }: Props) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  const submit = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(name);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={s.dialogBackdrop} onClick={submitting ? undefined : onCancel}>
      <div className={s.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={s.dialogTitle}>New project</div>
        <label className={s.dialogLabel}>Name</label>
        <input
          autoFocus
          className={s.dialogInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="e.g. YouTube banner system"
          disabled={submitting}
        />
        {submitting && (
          <div className={s.dialogStatus}>
            Setting up project & starting Claude…
          </div>
        )}
        <div className={s.dialogActions}>
          <button className={s.dialogBtn} onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            className={`${s.dialogBtn} ${s.dialogPrimary}`}
            onClick={submit}
            disabled={!name.trim() || submitting}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
