/* opencode/mcpConfig.ts — OPENCODE_CONFIG_CONTENT JSON for our 3 MCP servers.
 *
 * OpenCode reads its config from `~/.config/opencode/opencode.json` by
 * default. The OPENCODE_CONFIG_CONTENT env var is documented as the
 * highest-priority override (priority 6 in opencode/packages/core/src/
 * flag/flag.ts) — its contents take precedence over every on-disk
 * source. We use that to inject our MCP servers per-spawn without
 * touching the user's global config.
 *
 * Schema differences vs Claude SDK / kimi --mcp-config:
 *   - OpenCode uses one `command: ["node", path, ...args]` array
 *     (not separate `command` + `args` fields).
 *   - The env block is named `environment`, not `env`.
 *   - Each server must declare `"type": "local"` and `"enabled": true`
 *     (the default is disabled — easy to miss).
 *
 * We rely on the same shared constructors as the other adapters
 * (STARTERS / CAPABILITIES / ASK_USER_HTTP) and just shim their output
 * into OpenCode's shape — adding a fourth adapter that talks any of
 * these MCPs is now a one-line shim away.
 */

import { STARTERS, CAPABILITIES, ASK_USER_HTTP } from "../shared/mcpServers.ts";

type ProtoServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

function toOpenCodeLocal(spec: ProtoServer): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: "local",
    enabled: true,
    command: [spec.command, ...(spec.args ?? [])],
  };
  if (spec.env && Object.keys(spec.env).length > 0) {
    out.environment = spec.env;
  }
  return out;
}

/** Build the JSON string we hand to OpenCode via OPENCODE_CONFIG_CONTENT.
 *  Returns the raw string ready for env-var assignment.
 *
 *  When baseUrl/streamId are missing (legacy / no-bridge spawn), only
 *  the `starters` server is wired — same conditional shape kimi
 *  single-shot uses, so the agent still gets project templates but
 *  not bidirectional elicitation. */
export function buildOpenCodeConfigContent(
  rootDir: string,
  baseUrl: string | undefined,
  streamId: string | undefined,
): string {
  const mcp: Record<string, unknown> = {
    starters: toOpenCodeLocal(STARTERS(rootDir)),
  };
  if (baseUrl && streamId) {
    mcp["ask-user"] = toOpenCodeLocal(ASK_USER_HTTP(baseUrl, { streamId }));
    mcp.capabilities = toOpenCodeLocal(CAPABILITIES(baseUrl));
  }
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp,
  });
}
