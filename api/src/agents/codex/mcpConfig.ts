/* codex/mcpConfig.ts — our 3 MCP servers as `codex exec -c` overrides.
 *
 * Codex reads MCP servers from `~/.codex/config.toml` under
 * `[mcp_servers.<name>]` (command / args / env). Rather than mutate the
 * user's global config, we inject per-spawn via repeated `-c key=value`
 * overrides (the value is parsed as TOML). Codex enables configured
 * stdio servers by default — no `enabled` flag needed (unlike opencode).
 *
 * Reuses the shared constructors (STARTERS / CAPABILITIES /
 * ASK_USER_HTTP), same as the opencode adapter. The ask-user server
 * uses the HTTP-bridge variant because the CLI can't surface MCP
 * elicitation to our UI over stdio (→ elicitationTransport:"http-bridge").
 *
 * FALLBACK: if a live `codex exec` rejects the nested `-c` TOML (this
 * couldn't be verified — the probe machine's codex token was revoked),
 * flip CODEX_MCP_ENABLED to false in adapter.ts to ship Codex without
 * MCP. Codex still reads/edits files fine; only starters + ask-user +
 * capabilities go dark, and elicitationTransport should become "none".
 */

import { STARTERS, CAPABILITIES, ASK_USER_HTTP } from "../shared/mcpServers.ts";

type ProtoServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/** Emit `-c mcp_servers.<name>.*` override pairs for one server. Each
 *  override is two argv entries: "-c" then "key=value". Values are
 *  JSON-encoded, which is valid TOML for strings and string arrays. */
function serverArgs(name: string, spec: ProtoServer): string[] {
  const out: string[] = [];
  const push = (key: string, value: string) => { out.push("-c", `mcp_servers.${name}.${key}=${value}`); };
  push("command", JSON.stringify(spec.command));
  if (spec.args && spec.args.length > 0) push("args", JSON.stringify(spec.args));
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) push(`env.${k}`, JSON.stringify(v));
  }
  return out;
}

/** Build the flat `-c` argument list wiring our MCP servers into a
 *  `codex exec` invocation. When baseUrl/streamId are missing (legacy /
 *  no-bridge spawn) only `starters` is wired — same conditional shape
 *  as the opencode adapter. */
export function buildCodexMcpArgs(
  rootDir: string,
  baseUrl: string | undefined,
  streamId: string | undefined,
): string[] {
  const args = serverArgs("starters", STARTERS(rootDir));
  if (baseUrl && streamId) {
    args.push(...serverArgs("ask_user", ASK_USER_HTTP(baseUrl, { streamId })));
    args.push(...serverArgs("capabilities", CAPABILITIES(baseUrl)));
  }
  return args;
}
