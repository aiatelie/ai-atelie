/* CodexSignInButton — one-click `codex login` from the UI.
 *
 * Calls loginCodex() (agents.ts), which POSTs to the backend; the
 * backend spawns `codex login`, opening the user's browser for the
 * ChatGPT OAuth flow, and streams progress back. On success the agent
 * list is rescanned automatically. Used in two places: the Adapters
 * settings card and the chat error bubble (codex auth errors).
 *
 * `className` overrides the button class so it can match the host
 * context (e.g. the chat bubble's Retry button). `onAuthed` fires once
 * the user is signed in (e.g. to nudge a retry).
 */

import { useState } from "react";
import { loginCodex } from "../../data/agents";
import s from "./codexSignIn.module.css";

export function CodexSignInButton({
  className,
  label = "Sign in to Codex",
  onAuthed,
}: {
  className?: string;
  label?: string;
  onAuthed?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setStatus("Starting…");
    setUrl(null);
    setErr(null);
    setDone(false);
    try {
      const ok = await loginCodex((e) => {
        if (e.type === "status") setStatus(e.message);
        else if (e.type === "url") setUrl(e.url);
        else if (e.type === "error") { setErr(e.message); setStatus(null); }
        else if (e.type === "done") { setDone(e.authed); setStatus(null); }
      });
      if (ok) onAuthed?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={s.wrap}>
      <button
        type="button"
        className={className ?? s.btn}
        onClick={start}
        disabled={busy}
        title="Open the ChatGPT sign-in flow in your browser"
      >
        {busy ? "Signing in…" : done ? "Signed in ✓" : label}
      </button>
      {status && !err && <span className={s.status}>{status}</span>}
      {url && !done && (
        <a className={s.url} href={url} target="_blank" rel="noreferrer noopener">
          Open sign-in page ↗
        </a>
      )}
      {done && <span className={s.ok}>Signed in — try again</span>}
      {err && <span className={s.err}>{err}</span>}
    </span>
  );
}
