/* NewProjectForm.tsx — sidebar-resident form for spawning a new
 * project.
 *
 * Submission delegates to the `onSubmit` prop with three pieces of
 * intent: the project name, the aesthetic-skill selection, and the
 * project-type payload from the active tab (Prototype / Slide deck /
 * From template / Other). The agent reads `projectType` on first turn
 * so intake is grounded in what the user said they were making
 * instead of asking from zero.
 *
 * Tab anatomy:
 *
 *   ┌─[Prototype][Slide deck][From template][Other]──────────┐
 *   │ <Project name input>                                    │
 *   │ <Design System select>                                  │
 *   │                                                          │
 *   │ <tab-specific area>                                     │
 *   │   • Prototype  → Wireframe / High-fidelity buttons      │
 *   │   • Slide deck → Speaker notes / Less text on slides    │
 *   │   • Template   → radio list ("No templates yet")        │
 *   │   • Other      → (nothing extra)                        │
 *   │                                                          │
 *   │ <Design skills picker>                                  │
 *   │ <Create / Create from template>                         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The skills section + import button stay where they were; the tab
 * strip is additive on top so existing callers (and tests using
 * `data-testid="create-project-name"` / `create-project-submit`)
 * keep working without code changes.
 */

import { useEffect, useMemo, useState } from "react";
import s from "./projects.module.css";
import type { ProjectTypePayload } from "../../lib/projects";

type DesignSystemSummary = { id: string; name: string; published: boolean };

/** Fetch the workspace's design systems from the API. Returns an empty array
 *  when the API is unavailable (e.g. before PR #103 lands) so the picker
 *  degrades to "None only" rather than erroring. */
async function fetchDesignSystems(): Promise<DesignSystemSummary[]> {
  try {
    const r = await fetch("/api/design-systems");
    if (!r.ok) return [];
    const list = await r.json();
    return Array.isArray(list) ? list as DesignSystemSummary[] : [];
  } catch {
    return [];
  }
}

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

type ProjectKind = ProjectTypePayload["kind"];
type PrototypeFidelity = NonNullable<ProjectTypePayload["prototypeFidelity"]>;
type SlideStyle = NonNullable<ProjectTypePayload["slideStyle"]>;

type Props = {
  /** May be async — the form enters a busy state until it resolves.
   *  `activeSkills` is the user's aesthetic-skill picks at creation
   *  time; `projectType` is the tab + tab-specific answers. */
  onSubmit: (
    name: string,
    activeSkills: string[],
    projectType?: ProjectTypePayload,
  ) => Promise<void>;
};

const TABS: Array<{ id: ProjectKind; label: string }> = [
  { id: "prototype", label: "Prototype" },
  { id: "slide_deck", label: "Slide deck" },
  { id: "template", label: "From template" },
  { id: "other", label: "Other" },
];

export function NewProjectForm({ onSubmit }: Props) {
  const [tab, setTab] = useState<ProjectKind>("prototype");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-tab state. Each is independent so flipping tabs doesn't lose
  // the user's earlier picks — matches how multi-tab pickers work
  // elsewhere in the app.
  const [prototypeFidelity, setPrototypeFidelity] = useState<PrototypeFidelity>("high_fidelity");
  const [slideStyle, setSlideStyle] = useState<SlideStyle>("speaker_notes");
  // templateId is always "" today — no templates exist yet. canSubmit
  // blocks submission while the template tab is active and templateId is
  // empty, so the "Coming soon" tab body is the honest state.
  const templateId = "";
  const [designSystem, setDesignSystem] = useState<string>("none");

  // Design-system list: fetched from /api/design-systems on mount.
  // Falls back to [] gracefully when the API is not yet available.
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[]>([]);
  useEffect(() => {
    void fetchDesignSystems().then(setDesignSystems);
  }, []);

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

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !submitting && (tab !== "template" || templateId.length > 0);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      // Preserve catalog order (display order) in the manifest array;
      // priority for name collisions is stable across reloads.
      const ordered = aesthetic.map((e) => e.name).filter((n) => activeSet.has(n));

      const payload: ProjectTypePayload = { kind: tab };
      if (tab === "prototype") payload.prototypeFidelity = prototypeFidelity;
      else if (tab === "slide_deck") payload.slideStyle = slideStyle;
      else if (tab === "template" && templateId) payload.templateId = templateId;
      if (designSystem && designSystem !== "none") payload.designSystem = designSystem;

      await onSubmit(name, ordered, payload);
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

  // Template tab is currently non-functional (no templates exist);
  // canSubmit blocks the button. Label it "Coming soon" to be honest.
  const ctaLabel = submitting
    ? "Creating…"
    : tab === "template"
      ? "Coming soon"
      : "Create";

  return (
    <form className={s.formWrap} onSubmit={submit} noValidate>
      <div className={s.formEyebrow}>New project</div>

      <div className={s.tabRow} role="tablist" aria-label="New project type">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-active={tab === t.id ? "true" : "false"}
            data-testid={`new-project-tab-${t.id}`}
            className={s.tabBtn}
            onClick={() => setTab(t.id)}
            disabled={submitting}
          >
            {t.label}
          </button>
        ))}
      </div>

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
        placeholder="Project name"
        disabled={submitting}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
      />

      <label htmlFor="new-project-design-system" className={s.formLabel}>
        Design system
      </label>
      <select
        id="new-project-design-system"
        data-testid="new-project-design-system"
        className={s.formSelect}
        value={designSystem}
        onChange={(e) => setDesignSystem(e.target.value)}
        disabled={submitting}
      >
        <option value="none">None — generic visual defaults</option>
        {designSystems.map((ds) => (
          <option key={ds.id} value={ds.id}>
            {ds.name}{ds.published ? "" : " (draft)"}
          </option>
        ))}
      </select>

      {/* Tab-specific area */}
      {tab === "prototype" && (
        <div className={s.tabPane} role="tabpanel" aria-label="Prototype options">
          <div className={s.tabPaneLabel}>Fidelity</div>
          <div className={s.optionGrid}>
            <button
              type="button"
              className={s.optionBtn}
              data-active={prototypeFidelity === "wireframe" ? "true" : "false"}
              data-testid="new-project-fidelity-wireframe"
              onClick={() => setPrototypeFidelity("wireframe")}
              disabled={submitting}
            >
              <span className={s.optionGlyph} aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="1.5" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="9" y1="9" x2="9" y2="20" />
                </svg>
              </span>
              <span className={s.optionTitle}>Wireframe</span>
              <span className={s.optionDesc}>Low-fidelity layout, greyscale boxes, structure first.</span>
            </button>
            <button
              type="button"
              className={s.optionBtn}
              data-active={prototypeFidelity === "high_fidelity" ? "true" : "false"}
              data-testid="new-project-fidelity-high"
              onClick={() => setPrototypeFidelity("high_fidelity")}
              disabled={submitting}
            >
              <span className={s.optionGlyph} aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <circle cx="8" cy="11" r="1.6" />
                  <path d="M3 17l5-4 4 3 4-2 5 3" />
                </svg>
              </span>
              <span className={s.optionTitle}>High fidelity</span>
              <span className={s.optionDesc}>Real type, color, components — production-grade visuals.</span>
            </button>
          </div>
        </div>
      )}

      {tab === "slide_deck" && (
        <div className={s.tabPane} role="tabpanel" aria-label="Slide deck options">
          <div className={s.tabPaneLabel}>Style</div>
          <label className={s.toggleRow}>
            <input
              type="radio"
              name="slide-style"
              value="speaker_notes"
              checked={slideStyle === "speaker_notes"}
              onChange={() => setSlideStyle("speaker_notes")}
              disabled={submitting}
            />
            <span className={s.toggleBody}>
              <span className={s.toggleTitle}>Use speaker notes</span>
              <span className={s.toggleDesc}>Slides stay clean; the deeper detail rides in the speaker notes.</span>
            </span>
          </label>
          <label className={s.toggleRow}>
            <input
              type="radio"
              name="slide-style"
              value="less_text"
              checked={slideStyle === "less_text"}
              onChange={() => setSlideStyle("less_text")}
              disabled={submitting}
            />
            <span className={s.toggleBody}>
              <span className={s.toggleTitle}>Less text on slides</span>
              <span className={s.toggleDesc}>Big visuals and short statements, no walls of bullets.</span>
            </span>
          </label>
        </div>
      )}

      {tab === "template" && (
        <div className={s.tabPane} role="tabpanel" aria-label="Template options">
          <div className={s.tabPaneLabel}>Template</div>
          <div className={s.templateEmpty}>
            Templates are coming soon. For now, start with a blank project and
            describe what you want to build — the AI will scaffold from there.
          </div>
          <div className={s.helperLink} aria-hidden="true" style={{ color: "var(--ink-40, #aaa)", fontSize: "12px", marginTop: 4 }}>
            Switch to Prototype or Other to create a project.
          </div>
        </div>
      )}

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
        disabled={!canSubmit}
      >
        {ctaLabel}
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
