/* agents/registry.ts — adapter selection and listing.
 *
 * The route layer calls `pickAdapter(modelId)` instead of the old
 * `pickProvider() + if/else` dispatch. Adding a third adapter is a
 * matter of declaring one new file under agents/<id>/adapter.ts and
 * appending it to the ADAPTERS array — no route changes needed.
 *
 * Phase 4 will expose `listAdapters()` at GET /api/agents so the
 * frontend can replace its hard-coded "claude" | "kimi" Provider
 * type with a dynamic registry lookup.
 */

import { claudeAdapter } from "./claude/adapter.ts";
import { kimiAdapter } from "./kimi/adapter.ts";
import { opencodeAdapter } from "./opencode/adapter.ts";
import { codexAdapter } from "./codex/adapter.ts";
import type { AgentAdapter } from "./types.ts";

const ADAPTERS: AgentAdapter[] = [claudeAdapter, kimiAdapter, opencodeAdapter, codexAdapter];

/** Pick the right adapter for a given model id.
 *
 *    - empty modelId                                 → claude (default)
 *    - "opus" | "sonnet" | "haiku"                   → claude
 *    - starts with "claude"                          → claude
 *    - starts with "codex" ("codex:gpt-5-codex")      → codex
 *    - contains "/"  (provider/model — OpenCode shape) → opencode
 *    - everything else                               → kimi
 *
 *  The "contains /" rule matches OpenCode's `provider/model` ids
 *  (`anthropic/claude-sonnet-4-5`, `openai/gpt-5`,
 *  `google/gemini-2.5-pro`, etc.) and is checked before the kimi
 *  fallback so an opencode-shaped id never accidentally routes
 *  through the kimi adapter. Kimi's own multi-segment ids
 *  (`kimi-code/kimi-for-coding`) collide with this rule, so they
 *  hit the opencode adapter — which is wrong. We special-case
 *  kimi's known prefixes first to keep them on kimi.
 *
 *  When a 4th adapter lands, refactor this into a declarative
 *  prefix→adapter table on each AgentAdapter. */
export function pickAdapter(modelId: string | undefined): AgentAdapter {
  if (!modelId) return claudeAdapter;
  if (modelId === "opus" || modelId === "sonnet" || modelId === "haiku") return claudeAdapter;
  if (modelId.startsWith("claude")) return claudeAdapter;
  if (modelId.startsWith("kimi") || modelId.startsWith("moonshot")) return kimiAdapter;
  // Codex ids carry a "codex:" prefix (no "/", so this must come before
  // the opencode `provider/model` rule). Adapter strips it → real -m.
  if (modelId.startsWith("codex")) return codexAdapter;
  if (modelId.includes("/")) return opencodeAdapter;
  return kimiAdapter;
}

/** Read-only snapshot of all registered adapters. Used by the upcoming
 *  GET /api/agents route. */
export function listAdapters(): readonly AgentAdapter[] {
  return ADAPTERS;
}
