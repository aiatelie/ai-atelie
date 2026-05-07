/* NewProjectForm.tsx — sidebar-resident form for spawning a new
 * project. Replaces the old `NewProjectDialog` modal: the form is
 * always visible in the home page's left rail so creating a project
 * never requires opening a separate surface.
 *
 * Submission delegates to the `onSubmit` prop; the form owns its
 * pending + inline-error state, and reports errors as a small
 * `role="alert"` block under the input (no more `alert()` popup).
 */

import { useState } from "react";
import s from "./projects.module.css";

type Props = {
  /** May be async — the form enters a busy state until it resolves. */
  onSubmit: (name: string) => Promise<void>;
};

export function NewProjectForm({ onSubmit }: Props) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(name);
      // Navigation happens in the parent; we don't reset state because
      // the route unmounts on success.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const errorId = "new-project-form-error";

  return (
    <form className={s.formWrap} onSubmit={submit} noValidate>
      <div className={s.formEyebrow}>New project</div>

      <label htmlFor="new-project-name" className={s.visuallyHidden}>
        Project name
      </label>
      <input
        id="new-project-name"
        autoFocus
        className={s.formInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. YouTube banner system"
        disabled={submitting}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
      />

      {error && (
        <div id={errorId} className={s.formError} role="alert">
          {error}
        </div>
      )}

      <button
        type="submit"
        className={s.formCreateBtn}
        disabled={submitting}
      >
        {submitting ? "Creating…" : "Create"}
      </button>

      <button
        type="button"
        className={s.formImportBtn}
        disabled
        title="Coming soon"
        aria-disabled="true"
      >
        Import .zip
      </button>

      {submitting && (
        <div className={s.formStatus} aria-live="polite">
          Setting up project &amp; starting Claude…
        </div>
      )}
    </form>
  );
}
