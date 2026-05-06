/* agents/kimi/adapter.ts — kimi.com subscription via the kimi CLI.
 *
 * Thin wrapper. The spawn loop, --print stream-json parser, MCP HTTP-
 * bridge config (kimi --print has no stdio MCP elicitation), worker
 * pool, and session auto-heal still live in services/kimi.ts and
 * services/kimiWorkerPool.ts. Phase 3 will move shared bits into
 * agents/shared/.
 */

import { runKimi } from "../../services/kimi.ts";
import { ENV } from "../../env.ts";
import type { AgentAdapter } from "../types.ts";

const KIMI_SILENT_TIMEOUT_MS = 300_000;

export const kimiAdapter: AgentAdapter = {
  id: "kimi",
  displayName: "Kimi",
  capabilities: {
    surgicalEdit: true,
    elicitationTransport: "http-bridge",
    resume: true,
    bashAllowedInSandbox: false,
    silentTimeoutMs: KIMI_SILENT_TIMEOUT_MS,
    supportsPrewarmPool: ENV.KIMI_POOL_ENABLED,
  },
  async run({ payload, send, abortSignal, baseUrl, streamId }) {
    return runKimi(payload, send, abortSignal, baseUrl, streamId);
  },
};
