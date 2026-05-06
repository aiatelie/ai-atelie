/* AdaptersDialog.tsx — settings panel for AI adapters.
 *
 * One card per adapter from /api/agents:
 *   - Claude Code (SDK-backed, always installed)
 *   - Kimi      (CLI on PATH, always assumed)
 *   - OpenCode  (PATH-detected; lists `provider/model` ids)
 *
 * Shows install state + auth state + a copyable setup command when
 * something needs the user's attention. Inspired by nexu-io/open-
 * design's SettingsDialog card grid, but condensed for our 3-adapter
 * footprint and — crucially — surfaces auth state, which they don't.
 *
 * Open via the model picker's "⚙ Manage adapters" footer item.
 * Trigger a rescan after running `opencode auth login` in a terminal
 * to pick up newly available models without waiting on the 5-min
 * probe cache TTL.
 */

import { useState } from "react";
import s from "./adaptersDialog.module.css";
import { useAgents, rescanAgents, type AgentInfo } from "../../data/agents";

export function AdaptersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agents = useAgents();
  const [rescanning, setRescanning] = useState(false);
  const [rescanNotice, setRescanNotice] = useState<string | null>(null);

  if (!open) return null;

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
    <div
      className={s.backdrop}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={s.dialog} role="dialog" aria-modal="true" aria-label="Adapters">
        <div className={s.header}>
          <span className={s.title}>Adapters</span>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={s.intro}>
          AI providers detected on this machine. Each adapter is a separate CLI;
          authentication lives inside each one — run the setup command in a
          terminal, then click Rescan.
        </div>

        <div className={s.cards}>
          {agents.length === 0 ? (
            <div className={s.empty}>Loading adapter list…</div>
          ) : (
            agents.map((a) => <AdapterCard key={a.id} agent={a} />)
          )}
        </div>

        <div className={s.footer}>
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
      </div>
    </div>
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

/** Pull the first backtick-quoted command out of a setupHint string,
 *  if any — `Run \`opencode auth login\` in a terminal…` → `opencode auth login`.
 *  Returns null when no backtick is present. */
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
