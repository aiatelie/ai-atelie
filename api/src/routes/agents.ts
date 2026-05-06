/* agents.ts — GET /api/agents.
 *
 * Returns the registered adapter list with capability flags so the
 * frontend can gate UI features (e.g. comment-mode, silent watchdog
 * timing, model-picker availability) on what each adapter actually
 * supports — instead of hardcoding "kimi" | "claude" assumptions.
 *
 * Today's response is static (the registry is built at module load)
 * so this is effectively a one-shot fetch on the frontend. When
 * detection lands (PATH probe per CLI install, auth state), the
 * shape stays the same but values become dynamic per request.
 */

import { Hono } from "hono";
import { listAdapters } from "../agents/registry.ts";
import { probeAll, invalidateProbe } from "../agents/detection.ts";

export const agentsRoute = new Hono();

agentsRoute.get("/api/agents", async (c) => {
  // ?refresh=1 evicts the per-adapter probe cache before re-probing.
  // The Settings UI's Rescan button hits this — without it, a user who
  // just ran `opencode auth login` would wait up to 5 min for the TTL.
  if (c.req.query("refresh") === "1") {
    for (const a of listAdapters()) invalidateProbe(a.id);
  }
  const adapters = listAdapters();
  const probes = await probeAll(adapters);
  const out = adapters.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    capabilities: a.capabilities,
    installed: probes[a.id]?.installed ?? true,
    models: probes[a.id]?.models ?? [],
    authRequired: probes[a.id]?.authRequired ?? false,
    setupHint: probes[a.id]?.setupHint,
  }));
  return c.json({ adapters: out });
});
