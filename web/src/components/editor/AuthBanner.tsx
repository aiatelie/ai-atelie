/* AuthBanner.tsx — sticky banner that surfaces Claude Code login state.
 *
 * The editor relies on the local `claude` CLI being authenticated
 * (subscription OAuth in macOS Keychain or ~/.claude/credentials.json).
 * When the token is missing, malformed, or expired, every agent turn
 * 5-seconds-later 401s with a generic "Failed to authenticate" — confusing
 * if you didn't realize the token had lapsed.
 *
 * This banner fixes the UX in three ways:
 *   1. Polls /api/health/claude-auth on mount + every 5 min so we
 *      preemptively warn (with a few-minute heads-up before expiry).
 *   2. Listens for stream errors carrying code="auth_required" so a
 *      mid-turn 401 swaps the user from a generic error to the same
 *      banner, with the same fix instructions.
 *   3. Renders a copy-able `claude /login` instruction so the user
 *      doesn't have to remember the command.
 *
 * The banner is dismissable (per-session). After /login, the next poll
 * will see ok=true and the banner re-hides itself.
 */

import { useCallback, useEffect, useState } from "react";

type AuthState =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: "missing" | "malformed" }
  | { ok: false; reason: "expired"; expiresAt: number; hasRefresh: boolean };

const POLL_INTERVAL_MS = 5 * 60 * 1000;

const banner: React.CSSProperties = {
  position: "sticky",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 10000,
  background: "var(--brand, #D97757)",
  color: "var(--brand-fg, #FBF7EE)",
  padding: "10px 14px",
  fontSize: 13,
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  boxShadow: "0 1px 0 rgba(0,0,0,0.08)",
};

const code: React.CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  background: "rgba(0,0,0,0.18)",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 12,
  letterSpacing: 0.2,
};

const button: React.CSSProperties = {
  background: "rgba(255,255,255,0.18)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.4)",
  padding: "4px 10px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const dismissBtn: React.CSSProperties = {
  ...button,
  marginLeft: "auto",
  background: "transparent",
};

type Props = {
  /** Force the banner visible — used when a runtime stream error
   *  arrives with code="auth_required". Without this signal the banner
   *  only re-evaluates on its 5-min poll, leaving the user staring at
   *  a generic error until the next tick. */
  forceShown?: boolean;
  /** Caller acks the forced-shown state (e.g. clear the latched
   *  error after the user dismisses). Optional. */
  onForcedShownDismissed?: () => void;
};

export function AuthBanner({ forceShown, onForcedShownDismissed }: Props) {
  const [state, setState] = useState<AuthState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/health/claude-auth");
      if (!r.ok) return; // 5xx: leave previous state alone
      const j = (await r.json()) as AuthState;
      setState(j);
      // Reset dismissed if state transitions back to broken — we want
      // to re-warn on a NEW expiry even after a prior dismiss.
      if (!j.ok) setDismissed(false);
    } catch {
      /* network error — ignore */
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // Re-poll whenever forceShown flips on — a 401 from a live turn
  // means the keychain state changed (or was already broken and we
  // missed it). Refresh so the banner reason reflects ground truth.
  useEffect(() => {
    if (forceShown) {
      void poll();
      setDismissed(false);
    }
  }, [forceShown, poll]);

  const shouldShow = (forceShown || (state && !state.ok)) && !dismissed;
  if (!shouldShow) return null;

  // Build the body copy from the most-specific known reason. forceShown
  // overrides — it means the agent JUST 401'd, which is more credible
  // than a stale poll result.
  const reason: "missing" | "malformed" | "expired" | "live_401" =
    forceShown ? "live_401" : (state as Exclude<AuthState, { ok: true }>).reason;

  const headlineByReason: Record<typeof reason, string> = {
    missing: "Claude Code isn't signed in",
    malformed: "Claude Code credentials look broken",
    expired: "Your Claude Code session has expired",
    live_401: "Claude Code returned a 401 — your session needs a refresh",
  };

  const detailByReason: Record<typeof reason, string> = {
    missing:
      "No Claude credentials found on this machine. Sign in to start using the agent.",
    malformed:
      "Found credentials, but they don't parse. Try signing in again to write a fresh token.",
    expired:
      "The token in Keychain has expired. Sign in again to issue a fresh one.",
    live_401:
      "The agent just hit a 401 mid-turn. Sign in again so the next message goes through.",
  };

  const copyCommand = () => {
    try {
      void navigator.clipboard.writeText("claude /login");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable — silent */
    }
  };

  return (
    <div role="alert" aria-live="polite" style={banner}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <strong style={{ fontWeight: 600 }}>{headlineByReason[reason]}</strong>
        <span style={{ opacity: 0.92 }}>{detailByReason[reason]}</span>
      </div>
      <span style={{ marginLeft: 4, opacity: 0.92 }}>
        Run <span style={code}>claude /login</span> in your terminal, then retry.
      </span>
      <button
        type="button"
        style={button}
        onClick={copyCommand}
        aria-label="Copy claude /login command"
      >
        {copied ? "Copied ✓" : "Copy command"}
      </button>
      <button
        type="button"
        style={button}
        onClick={() => void poll()}
        aria-label="Re-check Claude auth"
      >
        Re-check
      </button>
      <button
        type="button"
        style={dismissBtn}
        onClick={() => {
          setDismissed(true);
          onForcedShownDismissed?.();
        }}
        aria-label="Dismiss banner"
      >
        ×
      </button>
    </div>
  );
}
