/* agents/types.ts — provider-agnostic adapter interface.
 *
 * Each AgentAdapter wraps one CLI / SDK behind a uniform `run()`
 * method and a static `capabilities` block. The route layer never
 * branches on provider id — it picks an adapter from the registry
 * and calls run().
 *
 * Capability flags are data, not branches. Phase 4 will surface
 * them at GET /api/agents so the frontend can gate UI features
 * (e.g. hide comment mode if surgicalEdit is false).
 */

import type { CommentPayload, Emitter } from "../services/types.ts";

export type AgentRunArgs = {
  payload: CommentPayload;
  send: Emitter;
  abortSignal?: AbortSignal;
  baseUrl?: string;
  streamId?: string;
};

export type AgentCapabilities = {
  /** Provider supports targeted edits to a region of a file (Edit tool)
   *  rather than regenerating whole files. Comment-mode (surgical refine)
   *  needs this. */
  surgicalEdit: boolean;
  /** How the provider transports MCP elicitation (ask_user). The SDK
   *  uses stdio + onElicitation callback; kimi --print can't do that
   *  in non-interactive mode and falls back to an HTTP bridge. */
  elicitationTransport: "sdk-stdio" | "http-bridge" | "none";
  /** Whether the provider can resume an existing conversation by id. */
  resume: boolean;
  /** True if Bash should remain available even in sandbox mode.
   *  Defaults false — sandbox projects should not run shell commands. */
  bashAllowedInSandbox: boolean;
  /** Per-turn silent watchdog (ms). When the provider goes this long
   *  without emitting a stream event, the run is killed as wedged.
   *  Undefined means no per-turn watchdog (only the route-level
   *  RUN_MAX_DURATION_MS cap applies). */
  silentTimeoutMs?: number;
  /** True if the adapter has an opt-in long-lived prewarmed worker
   *  pool that drops first-byte latency. */
  supportsPrewarmPool: boolean;
};

export type AgentProbe = {
  /** Adapter is reachable on this machine. For SDK-backed adapters
   *  (Claude) this is always true. For spawn-CLI adapters this is a
   *  PATH probe. */
  installed: boolean;
  /** When installed, the list of model ids the adapter can dispatch
   *  to. Empty / undefined when the adapter has an implicit or static
   *  model menu (Claude / Kimi). Populated dynamically for OpenCode
   *  via `opencode models`. */
  models?: string[];
  /** Human-readable hint surfaced to the user when `installed:false`
   *  or `authRequired:true`. The frontend renders this verbatim in
   *  the setup banner. */
  setupHint?: string;
  /** True when the adapter is installed but credentials are missing
   *  or stale. Frontend hides the adapter from the picker when set. */
  authRequired?: boolean;
};

export interface AgentAdapter {
  /** Stable id used by the registry, log lines, and the started-status
   *  SSE event. Currently "claude" or "kimi". */
  readonly id: string;
  /** Human-readable label for UI / logs. */
  readonly displayName: string;
  /** Static capability flags. May become a method when detection lands
   *  in Phase 4 (different installs of the same CLI can support
   *  different features). */
  readonly capabilities: AgentCapabilities;
  /** Run one turn. Streams `agent` events through `send`. Resolves
   *  when the turn ends (cleanly or via abort). Throws on
   *  unrecoverable errors after emitting a normalized "error" event
   *  on `send`. */
  run(args: AgentRunArgs): Promise<void>;
  /** Optional install/auth/models probe. Called from GET /api/agents
   *  with results memoized in the registry layer (see
   *  agents/detection.ts). When omitted, the registry assumes
   *  `installed:true` with no dynamic model list — matches Claude /
   *  Kimi today, where the CLI presence is taken on faith because
   *  the spawn fails clearly when missing. */
  probe?(): Promise<AgentProbe>;
}
