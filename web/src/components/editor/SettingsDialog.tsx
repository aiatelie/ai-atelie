/* SettingsDialog.tsx — global Settings shell with sidebar nav.
 *
 * Sections:
 *   - Appearance    — theme picker (System / Light / Dark / Retro)
 *   - Design        — decorative palette overlay (12 swatch cards)
 *   - Notifications — completion sound + desktop ping prefs (#5)
 *   - Adapters      — existing per-CLI cards (ported from AdaptersDialog)
 *   - About         — read-only version + runtime info for bug reports
 *
 * The dialog deliberately mirrors the old AdaptersDialog modal/backdrop
 * so the surface feels familiar; the structural addition is the left
 * sidebar. ModelPicker still routes "⚙ Manage adapters" through this
 * dialog — it just opens directly to the Adapters section. */

import { useEffect, useState } from "react";
import s from "./settingsDialog.module.css";
import { useAgents, rescanAgents, type AgentInfo } from "../../data/agents";
import {
  getTheme, setTheme, themes, type ThemePreference,
  getDesign, setDesign, clearDesign, designs, type Design, type DesignMeta,
} from "../../lib/theme";
import {
  loadNotifPrefs,
  saveNotifPrefs,
  playSuccess,
  playFailure,
  currentPermission,
  requestNotificationPermission,
  sendTestNotification,
  SUCCESS_SOUNDS,
  FAILURE_SOUNDS,
  type NotifPrefs,
  type SuccessSoundId,
  type FailureSoundId,
} from "../../lib/notifications";

type SectionId = "appearance" | "design" | "skills" | "notifications" | "adapters" | "about";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "design", label: "Design" },
  { id: "skills", label: "Skills" },
  { id: "notifications", label: "Notifications" },
  { id: "adapters", label: "Adapters" },
  { id: "about", label: "About" },
];

export function SettingsDialog({
  open,
  onClose,
  initialSection = "appearance",
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  initialSection?: SectionId;
  /** Active project the dialog should scope project-level sections to
   *  (currently: Skills). Optional — when absent, project-level
   *  sections render an empty-state. */
  projectId?: string;
}) {
  const [section, setSection] = useState<SectionId>(initialSection);

  if (!open) return null;

  return (
    <div
      className={s.backdrop}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={s.dialog} role="dialog" aria-modal="true" aria-label="Settings">
        <div className={s.header}>
          <span className={s.title}>Settings</span>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={s.body}>
          <nav className={s.sidebar} aria-label="Settings sections">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                className={`${s.navBtn} ${section === sec.id ? s.navBtnActive : ""}`}
                onClick={() => setSection(sec.id)}
                aria-current={section === sec.id ? "page" : undefined}
              >
                {sec.label}
              </button>
            ))}
          </nav>

          <div className={s.content}>
            {section === "appearance" && <AppearanceSection />}
            {section === "design" && <DesignSection />}
            {section === "skills" && <SkillsSection projectId={projectId} />}
            {section === "notifications" && <NotificationsSection />}
            {section === "adapters" && <AdaptersSection />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const [active, setActive] = useState<ThemePreference>(() => getTheme());
  const onPick = (pref: ThemePreference) => {
    setTheme(pref);
    setActive(pref);
  };
  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>Appearance</h3>
      <p className={s.sectionDesc}>
        Theme preference for the editor chrome. <strong>System</strong> follows
        your OS Light/Dark setting and flips live. <strong>Retro</strong> is a
        decorative cream-and-navy skin.
      </p>
      <div
        className={s.segControl}
        role="group"
        aria-label="Theme"
        style={{ ["--seg-cols" as string]: themes.length } as React.CSSProperties}
      >
        {themes.map((th) => (
          <button
            key={th.name}
            type="button"
            className={`${s.segBtn} ${th.name === active ? s.segBtnActive : ""}`}
            aria-pressed={th.name === active}
            onClick={() => onPick(th.name)}
          >
            {th.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function DesignSection() {
  const [active, setActive] = useState<Design | null>(() => getDesign());
  const onPick = (d: Design) => {
    setDesign(d);
    setActive(d);
  };
  const onReset = () => {
    clearDesign();
    setActive(null);
  };

  const lights = designs.filter((d) => d.kind === "light");
  const darks = designs.filter((d) => d.kind === "dark");

  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>Design</h3>
      <p className={s.sectionDesc}>
        A decorative palette overlay on top of your <strong>Appearance</strong>
        choice. Designs sit independently of Light/Dark — pick one to repaint
        the chrome with a different identity, or reset to revert to the
        underlying theme.
      </p>

      <div className={s.designStatus}>
        <span className={s.designStatusLabel}>
          {active ? (
            <>
              Design: <strong>{designs.find((d) => d.name === active)?.label}</strong>
            </>
          ) : (
            <>No design — using your Appearance theme.</>
          )}
        </span>
        <button
          type="button"
          className={s.designResetBtn}
          onClick={onReset}
          disabled={!active}
        >
          Reset to theme
        </button>
      </div>

      <div className={s.themeGroup} role="group" aria-label="Light designs">
        <div className={s.themeGroupLabel}>Light</div>
        <div className={s.themeGrid}>
          {lights.map((d) => (
            <DesignSwatchCard
              key={d.name}
              design={d}
              active={d.name === active}
              onPick={() => onPick(d.name)}
            />
          ))}
        </div>
      </div>

      <div className={s.themeGroup} role="group" aria-label="Dark designs">
        <div className={s.themeGroupLabel}>Dark</div>
        <div className={s.themeGrid}>
          {darks.map((d) => (
            <DesignSwatchCard
              key={d.name}
              design={d}
              active={d.name === active}
              onPick={() => onPick(d.name)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function DesignSwatchCard({
  design,
  active,
  onPick,
}: {
  design: DesignMeta;
  active: boolean;
  onPick: () => void;
}) {
  const [bg, surface, brand, ink] = design.swatch;
  return (
    <button
      type="button"
      className={`${s.themeCard} ${active ? s.themeCardActive : ""}`}
      aria-pressed={active}
      onClick={onPick}
      title={design.label}
    >
      <span
        className={s.themeSwatch}
        aria-hidden="true"
        style={{ background: bg, borderColor: surface }}
      >
        <span className={s.themeSwatchSurface} style={{ background: surface }} />
        <span className={s.themeSwatchBrand} style={{ background: brand }} />
        <span className={s.themeSwatchInk} style={{ background: ink }} />
      </span>
      <span className={s.themeCardLabel}>{design.label}</span>
    </button>
  );
}

/* SkillsSection — per-project skill catalog viewer.
 *
 * Two groups:
 *   - Aesthetic skills (kind: "aesthetic") — toggleable; persisted to
 *     manifest.design.active_skills via PATCH /api/projects/:id/manifest.
 *     These govern HOW the agent designs (frontend-design, presets,
 *     critique, DESIGN.md author).
 *   - Capabilities (kind: "capability") — read-only display. The agent
 *     reaches for these when the user asks for the matching action
 *     (export, make-tweakable). Always-on; no user toggle.
 *
 * Stubs (no `kind` field, body_status: "stub") are intentionally
 * hidden — they're working-theory placeholders, not user-facing yet.
 *
 * Reads `<SKILLS_DIR>/index.json` via /api/skills/catalog. The catalog
 * ships pre-baked with the app; per-project aesthetic selection is the
 * user's choice. */
type CatalogEntry = {
  name: string;
  display: string;
  description: string;
  kind?: "aesthetic" | "capability";
  body_status: "verbatim" | "reconstructed" | "stub" | "original";
  body_sources: string[];
};

type CatalogResponse = { skills: CatalogEntry[] };

type ManifestDesign = { active_skills?: string[]; design_md?: string };

function SkillsSection({ projectId }: { projectId?: string }) {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [active, setActive] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Fetch the catalog once — it's stable per app build.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills/catalog")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: CatalogResponse) => { if (!cancelled) setCatalog(j.skills ?? []); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  // Fetch the project's current selection. Re-runs when projectId changes.
  useEffect(() => {
    if (!projectId) { setActive(null); return; }
    let cancelled = false;
    fetch(`/api/projects/${projectId}/manifest`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((m: { design?: ManifestDesign }) => {
        if (cancelled) return;
        setActive(m.design?.active_skills ?? ["frontend-design"]);
      })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [projectId]);

  const toggle = async (name: string) => {
    if (!projectId || !active) return;
    const next = active.includes(name)
      ? active.filter((s) => s !== name)
      : [...active, name];
    // Optimistic update — restore on error.
    const previous = active;
    setActive(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/manifest`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ design: { active_skills: next } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setActive(previous);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!projectId) {
    return (
      <section className={s.section}>
        <h3 className={s.sectionTitle}>Skills</h3>
        <p className={s.sectionDesc}>
          Open a project to choose which design skills are active for it.
        </p>
      </section>
    );
  }

  const aestheticSkills = catalog?.filter((e) => e.kind === "aesthetic") ?? [];
  const capabilitySkills = catalog?.filter((e) => e.kind === "capability") ?? [];

  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>Skills</h3>
      <p className={s.sectionDesc}>
        Pick which <strong>aesthetic skills</strong> the agent prefers when
        generating into this project's canvas. Capabilities below are always
        available — the agent invokes them when you ask for the matching
        action. Saved to <code>manifest.json</code> as
        <code> design.active_skills</code>.
      </p>

      {loadError && (
        <p className={s.sectionDesc} style={{ color: "var(--danger-fg)" }}>
          {loadError}
        </p>
      )}

      {!catalog || !active ? (
        <p className={s.sectionDesc}>Loading…</p>
      ) : (
        <>
          <div style={{ marginBottom: "20px" }}>
            <div style={{ fontSize: "0.78em", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-65)", fontWeight: 600, marginBottom: "8px" }}>
              Aesthetic direction
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
              {aestheticSkills.map((entry) => {
                const isActive = active.includes(entry.name);
                return (
                  <li key={entry.name}>
                    <label style={{ display: "flex", gap: "12px", padding: "10px 12px", border: "1px solid var(--ink-08)", borderRadius: "8px", cursor: "pointer", background: isActive ? "var(--brand-bg)" : "var(--surface-2)" }}>
                      <input
                        type="checkbox"
                        checked={isActive}
                        disabled={saving}
                        onChange={() => toggle(entry.name)}
                        style={{ marginTop: "2px" }}
                      />
                      <span style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <span style={{ fontWeight: 600, color: "var(--ink-92)" }}>
                          {entry.display}
                        </span>
                        <span style={{ color: "var(--ink-65)", fontSize: "0.92em" }}>
                          {entry.description}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>

          {capabilitySkills.length > 0 && (
            <div>
              <div style={{ fontSize: "0.78em", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-65)", fontWeight: 600, marginBottom: "8px" }}>
                Capabilities (always on)
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
                {capabilitySkills.map((entry) => (
                  <li
                    key={entry.name}
                    style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "8px 12px", border: "1px solid var(--ink-08)", borderRadius: "8px", background: "var(--surface-warm)" }}
                  >
                    <span style={{ fontWeight: 600, color: "var(--ink-85)", fontSize: "0.95em" }}>
                      {entry.display}
                    </span>
                    <span style={{ color: "var(--ink-65)", fontSize: "0.88em" }}>
                      {entry.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotifPrefs>(() => loadNotifPrefs());
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(
    () => currentPermission(),
  );

  const update = (patch: Partial<NotifPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveNotifPrefs(next);
  };

  const toggleDesktop = async () => {
    if (!prefs.desktopEnabled) {
      // Off → On: request permission inline. If the user denies, we leave
      // the toggle off but still surface the denied state below.
      const p = await requestNotificationPermission();
      setPerm(p);
      if (p !== "granted") return;
    }
    update({ desktopEnabled: !prefs.desktopEnabled });
  };

  const desktopHint =
    perm === "unsupported"
      ? "Your browser doesn't expose the Notification API."
      : perm === "denied"
        ? "Permission was denied — re-enable in your browser's site settings, then toggle this back on."
        : prefs.desktopEnabled
          ? "Active — completion pings will fire when this tab loses focus."
          : "Off — flip on to ping when an agent run finishes while you're tabbed away.";

  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>Notifications</h3>
      <p className={s.sectionDesc}>
        Ping when an agent turn or long render finishes while you're tabbed
        away. Both channels respect a focus guard — neither fires if the
        editor tab is already in front.
      </p>

      <div className={s.notifRow}>
        <div className={s.notifLabel}>
          <span className={s.notifTitle}>Sound</span>
          <span className={s.notifDesc}>
            Synthesized via the WebAudio API — no audio assets ship with the app.
          </span>
        </div>
        <button
          type="button"
          className={`${s.toggleBtn} ${prefs.soundEnabled ? s.toggleBtnActive : ""}`}
          aria-pressed={prefs.soundEnabled}
          onClick={() => update({ soundEnabled: !prefs.soundEnabled })}
        >
          {prefs.soundEnabled ? "Active" : "Off"}
        </button>
      </div>

      {prefs.soundEnabled && (
        <>
          <div className={s.subLabel}>Success sound</div>
          <div
            className={s.segControl}
            role="group"
            aria-label="Success sound"
            style={{ ["--seg-cols" as string]: SUCCESS_SOUNDS.length } as React.CSSProperties}
          >
            {SUCCESS_SOUNDS.map((sound) => (
              <button
                key={sound.id}
                type="button"
                className={`${s.segBtn} ${prefs.successSoundId === sound.id ? s.segBtnActive : ""}`}
                aria-pressed={prefs.successSoundId === sound.id}
                onClick={() => {
                  update({ successSoundId: sound.id as SuccessSoundId });
                  playSuccess(sound.id as SuccessSoundId);
                }}
              >
                {sound.label}
              </button>
            ))}
          </div>

          <div className={s.subLabel}>Failure sound</div>
          <div
            className={s.segControl}
            role="group"
            aria-label="Failure sound"
            style={{ ["--seg-cols" as string]: FAILURE_SOUNDS.length } as React.CSSProperties}
          >
            {FAILURE_SOUNDS.map((sound) => (
              <button
                key={sound.id}
                type="button"
                className={`${s.segBtn} ${prefs.failureSoundId === sound.id ? s.segBtnActive : ""}`}
                aria-pressed={prefs.failureSoundId === sound.id}
                onClick={() => {
                  update({ failureSoundId: sound.id as FailureSoundId });
                  playFailure(sound.id as FailureSoundId);
                }}
              >
                {sound.label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className={s.notifRow}>
        <div className={s.notifLabel}>
          <span className={s.notifTitle}>Desktop notification</span>
          <span className={s.notifDesc}>{desktopHint}</span>
        </div>
        <button
          type="button"
          className={`${s.toggleBtn} ${prefs.desktopEnabled ? s.toggleBtnActive : ""}`}
          aria-pressed={prefs.desktopEnabled}
          disabled={perm === "unsupported" || perm === "denied"}
          onClick={() => { void toggleDesktop(); }}
        >
          {prefs.desktopEnabled ? "Active" : "Off"}
        </button>
      </div>

      {(prefs.soundEnabled || prefs.desktopEnabled) && (
        <button
          type="button"
          className={s.testBtn}
          onClick={() => { void sendTestNotification(); }}
        >
          Send test
        </button>
      )}
    </section>
  );
}

function AdaptersSection() {
  const agents = useAgents();
  const [rescanning, setRescanning] = useState(false);
  const [rescanNotice, setRescanNotice] = useState<string | null>(null);

  const handleRescan = async () => {
    setRescanning(true);
    setRescanNotice(null);
    try {
      const list = await rescanAgents();
      const ok = list.filter((a) => a.installed && !a.authRequired).length;
      setRescanNotice(`Rescan complete · ${ok}/${list.length} ready`);
    } catch {
      setRescanNotice("Rescan failed — server unreachable.");
    } finally {
      setRescanning(false);
    }
  };

  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>Adapters</h3>
      <p className={s.sectionDesc}>
        AI providers detected on this machine. Each adapter is a separate CLI;
        authentication lives inside each one — run the setup command in a
        terminal, then click Rescan.
      </p>
      <div className={s.cards}>
        {agents.length === 0 ? (
          <div className={s.empty}>Loading adapter list…</div>
        ) : (
          agents.map((a) => <AdapterCard key={a.id} agent={a} />)
        )}
      </div>
      <div className={s.adapterFooter}>
        {rescanNotice && <span className={s.notice}>{rescanNotice}</span>}
        <button
          type="button"
          className={s.rescanBtn}
          onClick={handleRescan}
          disabled={rescanning}
        >
          {rescanning ? "Rescanning…" : "↻ Rescan"}
        </button>
      </div>
    </section>
  );
}

function AboutSection() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "—";
  const platform =
    typeof navigator !== "undefined" ? (navigator.platform || "—") : "—";
  return (
    <section className={s.section}>
      <h3 className={s.sectionTitle}>About</h3>
      <p className={s.sectionDesc}>
        Paste this block into bug reports so the maintainer can match it
        against a known build.
      </p>
      <dl className={s.aboutList}>
        <div className={s.aboutRow}>
          <dt>Version</dt>
          <dd>{__APP_VERSION__}</dd>
        </div>
        <div className={s.aboutRow}>
          <dt>Runtime</dt>
          <dd>Browser SPA</dd>
        </div>
        <div className={s.aboutRow}>
          <dt>Platform</dt>
          <dd>{platform}</dd>
        </div>
        <div className={s.aboutRow}>
          <dt>User agent</dt>
          <dd className={s.aboutLong}>{ua}</dd>
        </div>
      </dl>
      <div className={s.aboutLinks}>
        <a
          href="https://github.com/aiatelie/ai-atelie"
          target="_blank"
          rel="noreferrer noopener"
        >
          GitHub repo ↗
        </a>
        <a
          href="https://github.com/aiatelie/ai-atelie/issues"
          target="_blank"
          rel="noreferrer noopener"
        >
          Report an issue ↗
        </a>
      </div>
    </section>
  );
}

function AdapterCard({ agent }: { agent: AgentInfo }) {
  const status: "ok" | "auth" | "missing" =
    !agent.installed ? "missing" : agent.authRequired ? "auth" : "ok";
  const statusLabel =
    status === "ok" ? "Ready" : status === "auth" ? "Needs auth" : "Not installed";

  const hint = agent.setupHint ?? null;
  const command = hint ? extractCommand(hint) : null;

  return (
    <div className={s.card} data-status={status}>
      <div className={s.cardHead}>
        <span className={s.dot} data-status={status} />
        <span className={s.cardName}>{agent.displayName}</span>
        <span className={s.cardStatus} data-status={status}>{statusLabel}</span>
      </div>
      <div className={s.cardMeta}>
        {agent.models.length > 0
          ? `${agent.models.length} model${agent.models.length === 1 ? "" : "s"}`
          : "static menu"}
        {" · "}
        <span title="how the adapter handles user-elicitation tools">
          {agent.capabilities.elicitationTransport === "sdk-stdio"
            ? "stdio MCP"
            : agent.capabilities.elicitationTransport === "http-bridge"
              ? "HTTP-bridge MCP"
              : "no MCP"}
        </span>
      </div>
      {hint && (
        <div className={s.hint}>
          <div className={s.hintText}>{hint}</div>
          {command && <CopyButton command={command} />}
        </div>
      )}
    </div>
  );
}

function extractCommand(hint: string): string | null {
  const m = hint.match(/`([^`]+)`/);
  return m ? m[1] : null;
}

function CopyButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  };
  return (
    <button type="button" className={s.copyBtn} onClick={onCopy} title="Copy command">
      <code>{command}</code>
      <span className={s.copyLabel}>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
