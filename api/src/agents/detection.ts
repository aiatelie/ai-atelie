/* agents/detection.ts — install / auth / models probing for adapters.
 *
 * Each adapter optionally declares a `probe()` method (see
 * agents/types.ts). This module gives the registry one shared,
 * cached entry point: `probeAll()` runs every adapter's probe in
 * parallel, caches the result, and serves /api/agents reads from
 * the cache so the frontend isn't paying for `opencode --version`
 * on every page load.
 *
 * Cache strategy:
 *   - Module-level Map keyed by adapter id.
 *   - 5min TTL — long enough that the model picker stays snappy,
 *     short enough that installing/uninstalling a CLI in another
 *     terminal becomes visible without restarting the daemon.
 *   - Hot-reload safe: the Map is process-local. On `bun --hot`
 *     dispose, a fresh module instance starts with an empty cache,
 *     which is the correct behavior.
 *
 * Adapters without a probe() method get a static
 * `{ installed: true }` answer — matches Claude/Kimi which we
 * assume to be present (their spawn errors out clearly otherwise).
 */

import type { AgentAdapter, AgentProbe } from "./types.ts";

type CachedProbe = { at: number; probe: AgentProbe };

const PROBE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedProbe>();

/** Run probe() for every adapter in parallel. Cached per id. */
export async function probeAll(adapters: readonly AgentAdapter[]): Promise<Record<string, AgentProbe>> {
  const now = Date.now();
  const tasks = adapters.map(async (a) => {
    const hit = cache.get(a.id);
    if (hit && now - hit.at < PROBE_TTL_MS) return [a.id, hit.probe] as const;

    const probe = a.probe
      ? await a.probe().catch((err): AgentProbe => ({
          installed: false,
          setupHint: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
        }))
      : { installed: true };

    cache.set(a.id, { at: now, probe });
    return [a.id, probe] as const;
  });
  const entries = await Promise.all(tasks);
  return Object.fromEntries(entries);
}

/** Force-evict the cached probe for one adapter. Useful when the user
 *  has just authenticated and wants the picker to refresh without
 *  waiting for TTL expiry. Currently unused; will land with the
 *  Settings dialog in Phase 5c. */
export function invalidateProbe(adapterId: string): void {
  cache.delete(adapterId);
}
