/* agents/shared/mcpServers.ts — common MCP server constructors.
 *
 * Three callers used to hand-roll near-identical configs:
 *   - services/claude.ts (stdio MCP via Claude SDK; type:"stdio" required)
 *   - services/kimi.ts (HTTP-bridge ask-user; STREAM_ID at spawn time)
 *   - services/kimiWorkerPool.ts (HTTP-bridge ask-user; WORKER_KEY for
 *     a long-lived worker that sees many streamIds)
 *
 * Each caller still composes its own outer shape (Claude prepends the
 * type:"stdio" tag; Kimi wraps in `{ mcpServers: … }` for --mcp-config)
 * — only the per-server { command, args, env } payloads are shared
 * here. Adding a third adapter = one more caller composing these
 * constructors, no new MCP path constants.
 */

import { MCP_PATHS } from "../../env.ts";

/** Project-scope starter templates. The MCP server reads/writes
 *  starter files under STARTERS_TARGET_DIR. */
export const STARTERS = (rootDir: string) => ({
  command: "node",
  args: [MCP_PATHS.STARTERS],
  env: { STARTERS_TARGET_DIR: rootDir } as Record<string, string>,
});

/** Per-project capability/permission probe. Only useful when baseUrl
 *  is set so the MCP server can reach back to /api/capabilities. */
export const CAPABILITIES = (baseUrl: string) => ({
  command: "node",
  args: [MCP_PATHS.CAPABILITIES],
  env: {
    CAP_BRIDGE_URL: `${baseUrl}/api/capabilities`,
    CAP_BASE_URL: baseUrl,
  } as Record<string, string>,
});

/** ask_user MCP server, stdio variant. Claude Code's SDK consumes
 *  elicitations through onElicitation directly and only needs the
 *  command + args; no env required. */
export const ASK_USER_STDIO = () => ({
  command: "node",
  args: [MCP_PATHS.ASK_USER],
});

/** ask_user MCP server, HTTP-bridge variant. Used by kimi --print
 *  which can't surface MCP elicitations natively in non-interactive
 *  mode. The MCP server posts elicit requests to ELICIT_BRIDGE_URL
 *  and identifies the target stream by either:
 *    - STREAM_ID (single-shot kimi: one stream per spawn)
 *    - WORKER_KEY (pooled kimi: long-lived worker, current stream
 *      is looked up via /api/_internal/current-stream/:workerKey)
 *  Pass exactly one identity. */
export const ASK_USER_HTTP = (
  baseUrl: string,
  identity: { streamId: string } | { workerKey: string },
) => ({
  command: "node",
  args: [MCP_PATHS.ASK_USER_HTTP],
  env: {
    ELICIT_BRIDGE_URL: baseUrl,
    ...("streamId" in identity
      ? { STREAM_ID: identity.streamId }
      : { WORKER_KEY: identity.workerKey }),
  } as Record<string, string>,
});
