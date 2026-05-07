/* ActiveSkillsStrip.tsx — visible reminder of which aesthetic skills
 * are guiding the agent for the current project, with a click-target
 * to change them.
 *
 * Surfaces the project's `manifest.design.active_skills` selection as
 * a compact chip strip rendered just above the chat composer. Without
 * this, users only see the selection in Settings → Skills, which is
 * easy to forget mid-conversation. With this strip the active set is
 * always one glance away.
 *
 * Click anywhere on the strip → opens Settings to the Skills section
 * (caller's responsibility, via the `onEdit` prop). Skills can be
 * toggled at any time, including mid-conversation — the agent picks
 * up the new selection on the next prompt (the prompt builder reads
 * manifest.design.active_skills per turn).
 *
 * Defensively self-contained: fetches its own catalog + manifest, no
 * shared store. Hides itself when:
 *   - No project id (rendered outside an active project)
 *   - Catalog or manifest fetch fails (network blip, offline)
 *   - Active set is empty (no aesthetic skills enabled)
 *
 * Hiding-on-empty avoids rendering an awkward "(none)" pill that
 * would take vertical space without communicating anything useful.
 */

import { useEffect, useState } from "react";

type CatalogEntry = {
  name: string;
  display: string;
  description: string;
  kind?: "aesthetic" | "capability";
};

type ManifestPartial = {
  design?: { active_skills?: string[] };
};

export function ActiveSkillsStrip({
  projectId,
  onEdit,
}: {
  projectId: string | undefined;
  /** Open Settings → Skills. Caller wires this up; the strip doesn't
   *  know how to open the dialog itself. */
  onEdit: () => void;
}) {
  const [catalog, setCatalog] = useState<Map<string, CatalogEntry>>(() => new Map());
  const [activeSkills, setActiveSkills] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills/catalog")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { skills: CatalogEntry[] }) => {
        if (cancelled) return;
        const map = new Map<string, CatalogEntry>();
        for (const e of j.skills ?? []) map.set(e.name, e);
        setCatalog(map);
      })
      .catch(() => { /* offline / 5xx — strip just hides */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!projectId) { setActiveSkills([]); return; }
    let cancelled = false;
    // Re-fetch on /api/projects/:id/__meta-events would be ideal so
    // toggling in Settings updates the strip live without a chat re-
    // render, but for v1 the manifest GET in <SkillsSection> gives us
    // freshness on next dialog open + the strip refetches when
    // projectId changes (i.e. user switches projects). Acceptable
    // staleness window.
    fetch(`/api/projects/${projectId}/manifest`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((m: ManifestPartial) => {
        if (cancelled) return;
        setActiveSkills(m.design?.active_skills ?? []);
      })
      .catch(() => { /* same — hide on failure */ });
    return () => { cancelled = true; };
  }, [projectId]);

  if (!projectId) return null;

  // Only show aesthetic skills as chips. Capabilities are always-on so
  // displaying them would be misleading — they're not toggleable.
  const aestheticActive = activeSkills.filter((name) => {
    const entry = catalog.get(name);
    return entry?.kind === "aesthetic";
  });
  if (aestheticActive.length === 0) return null;

  return (
    <button
      type="button"
      onClick={onEdit}
      title="Edit aesthetic skills (Settings → Skills)"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flexWrap: "wrap",
        margin: "8px 12px 4px",
        padding: "5px 8px 5px 10px",
        border: "1px solid var(--ink-08)",
        borderRadius: "6px",
        background: "var(--surface-warm)",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
        transition: "background 0.12s, border-color 0.12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--ink-04)";
        e.currentTarget.style.borderColor = "var(--ink-12)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--surface-warm)";
        e.currentTarget.style.borderColor = "var(--ink-08)";
      }}
    >
      <span
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 600,
          color: "var(--ink-55)",
        }}
      >
        Active
      </span>
      {aestheticActive.map((name) => {
        const entry = catalog.get(name);
        return (
          <span
            key={name}
            style={{
              fontSize: "11px",
              padding: "2px 7px",
              borderRadius: "999px",
              background: "var(--brand-bg)",
              color: "var(--brand-fg)",
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            {entry?.display ?? name}
          </span>
        );
      })}
      <span
        style={{
          marginLeft: "auto",
          fontSize: "11px",
          color: "var(--ink-55)",
          fontWeight: 500,
        }}
      >
        Edit ›
      </span>
    </button>
  );
}
