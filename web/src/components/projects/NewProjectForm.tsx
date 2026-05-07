/* NewProjectForm.tsx — sidebar-resident form for spawning a new
 * project. Replaces the old `NewProjectDialog` modal: the form is
 * always visible in the home page's left rail so creating a project
 * never requires opening a separate surface.
 *
 * Submission delegates to the `onSubmit` prop with both the project
 * name and the aesthetic-skill selection. Skill rows live below the
 * name input under a "Design skills" section, visible by default so
 * users see the choice at the moment they're most thoughtful about
 * aesthetic intent. The header doubles as a select-all/none toggle.
 * Selection is fully reversible later via Settings → Skills (no lock
 * after first message).
 *
 * The catalog is fetched on every mount from /api/skills/catalog,
 * filtered to kind:"aesthetic" — adding a new aesthetic skill to
 * skills/index.json makes it appear here on the next page load with
 * no code changes. The fetch is the single source of truth; nothing
 * is hardcoded.
 *
 * The form owns its pending + inline-error state, and reports errors
 * as a small `role="alert"` block under the input (no more `alert()`
 * popup).
 */

import { useEffect, useMemo, useState } from "react";
import s from "./projects.module.css";

type CatalogEntry = {
  name: string;
  display: string;
  description: string;
  kind?: "aesthetic" | "capability";
};

/** Tiny inline check glyph for the custom checkbox visual. The native
 *  <input type="checkbox"> is kept (visually hidden) for accessibility +
 *  form semantics; this glyph just paints the visible state. */
function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3 3 6.5-7" />
    </svg>
  );
}

type CatalogResponse = { skills: CatalogEntry[] };

type Props = {
  /** May be async — the form enters a busy state until it resolves.
   *  `activeSkills` is the user's aesthetic-skill picks at creation
   *  time; pass through to `POST /api/projects/create`. */
  onSubmit: (name: string, activeSkills: string[]) => Promise<void>;
};

export function NewProjectForm({ onSubmit }: Props) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Catalog is loaded once on mount from /api/skills/catalog so this
  // form stays in sync with the skill catalog without hardcoding names.
  // Defaults to all-aesthetic-checked when the catalog arrives.
  const [aesthetic, setAesthetic] = useState<CatalogEntry[]>([]);
  const [activeSet, setActiveSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills/catalog")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: CatalogResponse) => {
        if (cancelled) return;
        const list = (j.skills ?? []).filter((e) => e.kind === "aesthetic");
        setAesthetic(list);
        setActiveSet(new Set(list.map((e) => e.name)));
      })
      .catch(() => { /* network blip — submit defaults to empty set, server falls back */ });
    return () => { cancelled = true; };
  }, []);

  const toggle = (name: string) => {
    setActiveSet((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // Preserve catalog order (display order) in the manifest array;
      // priority for name collisions is stable across reloads.
      const ordered = aesthetic.map((e) => e.name).filter((n) => activeSet.has(n));
      await onSubmit(name, ordered);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const errorId = "new-project-form-error";
  const allChecked = aesthetic.length > 0 && aesthetic.every((e) => activeSet.has(e.name));
  const noneChecked = activeSet.size === 0;
  const toggleAllLabel = useMemo(() => {
    if (allChecked) return "Clear";
    if (noneChecked) return "Select all";
    return "Select all";
  }, [allChecked, noneChecked]);
  const toggleAll = () => {
    if (allChecked) setActiveSet(new Set());
    else setActiveSet(new Set(aesthetic.map((e) => e.name)));
  };

  return (
    <form className={s.formWrap} onSubmit={submit} noValidate>
      <div className={s.formEyebrow}>New project</div>

      <label htmlFor="new-project-name" className={s.visuallyHidden}>
        Project name
      </label>
      <input
        id="new-project-name"
        data-testid="create-project-name"
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

      {aesthetic.length > 0 && (
        <div className={s.formSkills}>
          <div className={s.formSkillsHeader}>
            <span className={s.formSkillsLabel}>Design skills</span>
            <button
              type="button"
              className={s.formSkillsToggleAll}
              onClick={toggleAll}
              disabled={submitting}
            >
              {toggleAllLabel}
            </button>
          </div>
          <ul
            className={s.formSkillsList}
            role="group"
            aria-label="Aesthetic skills active for this project"
          >
            {aesthetic.map((entry) => {
              const checked = activeSet.has(entry.name);
              return (
                <li key={entry.name} className={s.formSkillsItem}>
                  <label className={s.formSkillsRow}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={submitting}
                      onChange={() => toggle(entry.name)}
                    />
                    <span className={s.formSkillsCheck} aria-hidden="true">
                      <CheckGlyph className={s.formSkillsCheckMark} />
                    </span>
                    <span className={s.formSkillsBody}>
                      <span className={s.formSkillsName}>{entry.display}</span>
                      <span className={s.formSkillsDesc}>{entry.description}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className={s.formSkillsHint}>
            Reversible any time in Settings → Skills.
          </div>
        </div>
      )}

      <button
        type="submit"
        data-testid="create-project-submit"
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
