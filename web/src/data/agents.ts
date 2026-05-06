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
