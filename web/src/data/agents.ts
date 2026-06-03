/* agents.ts — read-only client for GET /api/agents.
 *
 * One fetch per page load, cached as a singleton promise. The shape
 * mirrors the AgentAdapter interface in api/src/agents/types.ts; both
 * sides are kept in sync by hand for now (Phase 4). When the wire
 * format stabilizes we should generate one type from the other.
 *
 * Phase 4 ships only the plumbing; UI gating (comment-mode availability,
 * model-picker filtering, watchdog tuning per silentTimeoutMs) will
 * land as future phases need it. modelPresets.ts is intentionally
 * untouched here.
 */

import { useEffect, useState } from "react";

export type AgentCapabilities = {
  surgicalEdit: boolean;
  elicitationTransport: "sdk-stdio" | "http-bridge" | "none";
  resume: boolean;
  bashAllowedInSandbox: boolean;
  silentTimeoutMs?: number;
  supportsPrewarmPool: boolean;
  /** How this adapter surfaces reasoning — mirrors api AgentCapabilities.
   *  Optional here so an older server (no field) doesn't break the UI. */
  reasoning?: {
    mode: "streams" | "hidden-but-present" | "none";
    enablement?: string;
    note?: string;
  };
};

export type AgentInfo = {
  id: string;
  displayName: string;
  capabilities: AgentCapabilities;
  /** Server detected the CLI on PATH (or, for SDK-backed adapters,
   *  is always true). When false, the model picker hides this
   *  adapter's models and surfaces `setupHint`. */
  installed: boolean;
  /** Dynamic model list, populated by the server probe. Empty for
   *  adapters with implicit/static menus (Claude, Kimi). For
   *  OpenCode, contains `provider/model` ids from `opencode models`. */
  models: string[];
  /** Adapter is installed but credentials missing — typically
   *  recoverable by running a one-line CLI command (see setupHint). */
  authRequired: boolean;
  /** Short user-facing instruction when `installed:false` or
   *  `authRequired:true`. */
  setupHint?: string;
};

let cached: Promise<AgentInfo[]> | null = null;
const subscribers = new Set<(list: AgentInfo[]) => void>();

/** Fetch the adapter list from the server. Cached for the lifetime
 *  of the page — the registry doesn't change at runtime unless the
 *  user manually rescans. Errors are swallowed and an empty list is
 *  returned, so callers can fall back to defaults rather than
 *  blocking on a missing API. Pass `refresh:true` to force the
 *  server to re-probe (clears its 5min probe cache). */
export function fetchAgents(opts: { refresh?: boolean } = {}): Promise<AgentInfo[]> {
  if (!cached || opts.refresh) {
    cached = fetch(`/api/agents${opts.refresh ? "?refresh=1" : ""}`)
      .then((r) => r.ok ? r.json() : { adapters: [] })
      .then((data: { adapters?: AgentInfo[] }) => data.adapters ?? [])
      .catch(() => []);
    cached.then((list) => {
      for (const sub of subscribers) {
        try { sub(list); } catch { /* ignore */ }
      }
    });
  }
  return cached;
}

/** Force the next `fetchAgents()` call to re-hit the server. Used by
 *  the Adapters dialog when the user has just authed an adapter. */
export function invalidateAgentsCache(): void {
  cached = null;
}

/** Look up one adapter's capabilities by id. Returns undefined when
 *  the id is unknown (e.g. the server doesn't have that adapter
 *  installed in this build). */
export async function getAgentCapabilities(id: string): Promise<AgentCapabilities | undefined> {
  const list = await fetchAgents();
  return list.find((a) => a.id === id)?.capabilities;
}

/** React hook returning the cached agent list. Re-renders once when
 *  the fetch resolves AND on any subsequent rescan triggered via
 *  `fetchAgents({ refresh: true })` from anywhere in the app.
 *  Returns an empty array initially so consumers can render their
 *  static fallback (hardcoded Claude/Kimi presets) without flicker. */
export function useAgents(): AgentInfo[] {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAgents().then((list) => { if (!cancelled) setAgents(list); });
    const sub = (list: AgentInfo[]) => { if (!cancelled) setAgents(list); };
    subscribers.add(sub);
    return () => {
      cancelled = true;
      subscribers.delete(sub);
    };
  }, []);
  return agents;
}

/** Trigger a fresh probe (clears server-side cache too) and broadcast
 *  the new list to every active useAgents() subscriber. The dialog
 *  awaits the returned promise so it can show pending UI. */
export async function rescanAgents(): Promise<AgentInfo[]> {
  invalidateAgentsCache();
  return fetchAgents({ refresh: true });
}

export type CodexLoginEvent =
  | { type: "status"; message: string }
  | { type: "url"; url: string }
  | { type: "done"; authed: boolean }
  | { type: "error"; message: string };

/** Kick off `codex login` on the backend (which opens the user's
 *  browser for the ChatGPT OAuth flow) and stream progress. The
 *  endpoint is POST + SSE, so we read the response body directly
 *  rather than via EventSource (which is GET-only). On a successful
 *  sign-in we rescanAgents() so the picker/adapter list refreshes.
 *  Resolves true when codex reports authed. */
export async function loginCodex(onEvent: (e: CodexLoginEvent) => void): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch("/api/agents/codex/login", { method: "POST" });
  } catch {
    onEvent({ type: "error", message: "Couldn't reach the API server." });
    return false;
  }
  if (res.status === 409) {
    onEvent({ type: "error", message: "A sign-in is already in progress." });
    return false;
  }
  if (!res.ok || !res.body) {
    onEvent({ type: "error", message: `Sign-in failed (HTTP ${res.status}).` });
    return false;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let authed = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    // SSE frames are separated by a blank line.
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed: { message?: string; url?: string; authed?: boolean };
      try { parsed = JSON.parse(data); } catch { continue; }
      if (event === "status" && parsed.message) onEvent({ type: "status", message: parsed.message });
      else if (event === "url" && parsed.url) onEvent({ type: "url", url: parsed.url });
      else if (event === "done") { authed = !!parsed.authed; onEvent({ type: "done", authed }); }
      else if (event === "error") onEvent({ type: "error", message: parsed.message ?? "Sign-in failed." });
    }
  }

  if (authed) await rescanAgents();
  return authed;
}
