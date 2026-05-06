/* SettingsDialog.tsx — global Settings shell with sidebar nav.
 *
 * Sections:
 *   - Appearance — theme picker (System / Light / Dark / Retro), live preview
 *   - Adapters    — existing per-CLI cards (ported from AdaptersDialog)
 *   - About       — read-only version + runtime info for bug reports
 *
 * The dialog deliberately mirrors the old AdaptersDialog modal/backdrop
 * so the surface feels familiar; the structural addition is the left
 * sidebar. ModelPicker still routes "⚙ Manage adapters" through this
 * dialog — it just opens directly to the Adapters section. */

import { useState } from "react";
import s from "./settingsDialog.module.css";
import { useAgents, rescanAgents, type AgentInfo } from "../../data/agents";
import { getTheme, setTheme, themes, type ThemePreference } from "../../lib/theme";

type SectionId = "appearance" | "adapters" | "about";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "adapters", label: "Adapters" },
  { id: "about", label: "About" },
];

export function SettingsDialog({
  open,
  onClose,
  initialSection = "appearance",
}: {
  open: boolean;
  onClose: () => void;
  initialSection?: SectionId;
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
