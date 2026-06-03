/* modelPresets.ts — runtime model picker config.
 *
 * Three providers:
 *   • claude   — Anthropic subscription via the claude CLI
 *   • kimi     — kimi.com subscription via the kimi CLI
 *   • opencode — sst/opencode (multi-vendor: Anthropic, OpenAI,
 *                Google, OpenRouter, etc., per-provider auth via
 *                `opencode auth login`)
 *
 * The server-side adapter registry picks the right CLI to spawn
 * from the model id prefix. The frontend mirror logic here exists
 * only to color the picker's status dot — it must stay in sync
 * with api/src/agents/registry.ts:pickAdapter().
 *
 * Static vs dynamic presets:
 *   - Claude / Kimi: hardcoded MODEL_PRESETS array below. Subscription
 *     CLIs with stable model lineups; we curate.
 *   - OpenCode: hydrated at runtime from `GET /api/agents`'s `models`
 *     field (sourced from `opencode models`). Use mergeAgentModels()
 *     to combine static + dynamic into one list for the picker.
 *
 * Three tiers in the UI:
 *   tier=primary    → top of the dropdown (recommended)
 *   tier=secondary  → middle (still current, less common)
 *   tier=legacy     → "Show older models" expandable group
 */

import type { AgentInfo } from "./agents";

export type Provider = "kimi" | "claude" | "opencode" | "codex";
export type ModelTier = "primary" | "secondary" | "legacy";

export type ModelPreset = {
  id: string;
  label: string;
  description?: string;
  provider: Provider;
  tier: ModelTier;
  /** Renders the "thinking" badge in the picker. Set on models that
   *  decide their own thinking depth (e.g. the Opus 4.8 Ultra preset). */
  supportsAdaptiveThinking?: boolean;
};

export const MODEL_PRESETS: ModelPreset[] = [
  // ─── Claude (Anthropic CLI) ─────────────────────────────────
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    description: "Anthropic · most capable",
    provider: "claude",
    tier: "primary",
  },
  {
    // The "-ultra" suffix is a routing sentinel: the claude adapter
    // strips it back to "claude-opus-4-8" and flips on xhigh effort +
    // subagent workflow orchestration. See api/src/services/claude.ts
    // resolveClaudeModel().
    id: "claude-opus-4-8-ultra",
    label: "Claude Opus 4.8 Ultra",
    description: "Anthropic · xhigh effort + workflow",
    provider: "claude",
    tier: "primary",
    supportsAdaptiveThinking: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    description: "Anthropic · balanced, 1M context",
    provider: "claude",
    tier: "primary",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    description: "Anthropic · fastest",
    provider: "claude",
    tier: "secondary",
  },
  // ─── Codex (OpenAI CLI) ─────────────────────────────────────
  // Bare "codex" id (no "/", so it never collides with the opencode
  // rule). No model is sent: with a ChatGPT-account login, Codex picks
  // the model server-side and rejects explicit `-m` overrides. Auth via
  // the "Sign in to Codex" button (or `codex login`).
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI · ChatGPT subscription",
    provider: "codex",
    tier: "primary",
  },
  // ─── Kimi (Moonshot CLI) ────────────────────────────────────
  // The id is the real model id from ~/.kimi/config.toml, which is what
  // `kimi -m <id>` accepts. Display name comes from the same config
  // (display_name = "Kimi-k2.6"). Older presets used fake ids like
  // "kimi-k2.5"/"kimi-k2" — kimi rejected them, so we silently skipped
  // -m and the picker was decorative. Now it's wired.
  {
    id: "kimi-code/kimi-for-coding",
    label: "Kimi K2.6",
    description: "Moonshot · Kimi for coding",
    provider: "kimi",
    tier: "primary",
  },
];

export const DEFAULT_MODEL_ID = "claude-opus-4-8";

/** Mirror of api/src/agents/registry.ts:pickAdapter(). Used only for
 *  the picker dot color — the server is the source of truth for
 *  routing. Must be kept in sync. */
export function providerOf(modelId: string | undefined): Provider {
  if (!modelId) return "claude";
  if (modelId === "opus" || modelId === "sonnet" || modelId === "haiku") return "claude";
  if (modelId.startsWith("claude")) return "claude";
  if (modelId.startsWith("kimi") || modelId.startsWith("moonshot")) return "kimi";
  if (modelId.startsWith("codex")) return "codex";
  if (modelId.includes("/")) return "opencode";
  return "kimi";
}

/** Convert a `provider/model` id from `opencode models` into a
 *  prettier label. Examples:
 *    "anthropic/claude-sonnet-4-5" → "Claude Sonnet 4 5", "OpenCode · anthropic"
 *    "opencode/gpt-5-nano"          → "GPT 5 Nano", "OpenCode · free tier"
 *    "openrouter/x-ai/grok-2"       → "Grok 2", "OpenCode · openrouter"
 *  The "opencode/*" namespace is opencode's bundled free models — we
 *  surface that as "free tier" so the user knows it's a no-auth lane
 *  rather than a real provider called "opencode". */
function labelOpencodeModel(id: string): { label: string; description: string } {
  const slash = id.indexOf("/");
  const vendor = slash >= 0 ? id.slice(0, slash) : "";
  const model = slash >= 0 ? id.slice(slash + 1) : id;
  // For nested ids like `openrouter/x-ai/grok-2`, drop the middle
  // segment — the leading vendor is what auth/billing routes through.
  const lastSeg = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  // Title-case, keep dashes/underscores/dots readable.
  const pretty = lastSeg
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const desc = vendor === "opencode"
    ? "OpenCode · free tier"
    : vendor
      ? `OpenCode · ${vendor}`
      : "OpenCode";
  return { label: pretty, description: desc };
}

/** Build a ModelPreset list that merges the hardcoded MODEL_PRESETS
 *  with the dynamic per-adapter `models` arrays from /api/agents.
 *  Today only OpenCode contributes dynamic models; future adapters
 *  with their own model lineups can be added by extending the loop. */
export function mergeAgentModels(agents: AgentInfo[]): ModelPreset[] {
  const dynamic: ModelPreset[] = [];
  const opencode = agents.find((a) => a.id === "opencode");
  if (opencode?.installed && !opencode.authRequired) {
    for (const id of opencode.models) {
      const { label, description } = labelOpencodeModel(id);
      dynamic.push({
        id,
        label,
        description,
        provider: "opencode",
        // Keep dynamic models out of the "primary" hero slot until
        // the user has actively picked one — secondary tier puts
        // them in the second group, visible without expanding.
        tier: "secondary",
      });
    }
  }
  return [...MODEL_PRESETS, ...dynamic];
}

export function getModel(id: string, presets: ModelPreset[] = MODEL_PRESETS): ModelPreset | undefined {
  return presets.find((m) => m.id === id);
}

export function presetsByTier(presets: ModelPreset[] = MODEL_PRESETS): Record<ModelTier, ModelPreset[]> {
  return {
    primary: presets.filter((m) => m.tier === "primary"),
    secondary: presets.filter((m) => m.tier === "secondary"),
    legacy: presets.filter((m) => m.tier === "legacy"),
  };
}
