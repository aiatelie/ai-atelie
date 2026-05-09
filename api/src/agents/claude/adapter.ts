/* agents/claude/adapter.ts — Claude Code via @anthropic-ai/claude-agent-sdk.
 *
 * Thin wrapper. The actual SDK loop, env scrubbing (subscription OAuth
 * wins), Bun executable workaround, MCP server config, and session
 * auto-heal still live in services/claude.ts. Phase 3 will move the
 * shared bits (session-heal, MCP builder) into agents/shared/ and
 * leave only Claude-specific logic here.
 */

import { runClaude } from "../../services/claude.ts";
import { claudeComplete } from "./complete.ts";
import type { AgentAdapter } from "../types.ts";

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",
  capabilities: {
    surgicalEdit: true,
    elicitationTransport: "sdk-stdio",
    resume: true,
    bashAllowedInSandbox: false,
    supportsPrewarmPool: false,
    supportsCompletion: true,
  },
  async run({ payload, send, abortSignal, baseUrl, streamId }) {
    return runClaude(payload, send, abortSignal, baseUrl, streamId);
  },
  async complete(args) {
    return claudeComplete(args);
  },
};
