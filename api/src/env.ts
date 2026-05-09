/* env.ts — single source of truth for filesystem paths and ports.
 *
 * Every other file imports from here instead of constructing paths
 * relative to its own location. This is what makes the app cloud-portable:
 * flip PROJECTS_ROOT and SHARED_ROOT in .env to a durable mount and
 * nothing else has to change.
 *
 * Defaults preserve the pre-extraction layout (everything under web/) so
 * no data migration is needed for local dev.
 */

import { dirname, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// /api/src/env.ts → repo root is two levels up.
const REPO_ROOT = resolvePath(HERE, "..", "..");

function envPath(name: string, fallback: string): string {
  const v = process.env[name];
  if (v && v.trim().length > 0) return resolvePath(v);
  return fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const ENV = {
  /** Port the Hono app binds. Vite proxies /api/* + /p/* to this. */
  API_PORT: envInt("API_PORT", 5174),

  /** Repo root, computed from this file's location. Used as the base for
   *  the *defaults* below — env vars override outright. */
  REPO_ROOT,

  /** Per-project sandbox content (manifest, files, .meta/, exports/, uploads/). */
  PROJECTS_ROOT: envPath("PROJECTS_ROOT", resolvePath(REPO_ROOT, "web/projects")),

  /** Workspace-wide shared blobs (assets.json, etc). */
  SHARED_ROOT: envPath("SHARED_ROOT", resolvePath(REPO_ROOT, "web/.data")),

  /** Legacy comment-edit fallback root (when payload has no projectId). */
  LEGACY_EDITOR_ROOT: envPath("LEGACY_EDITOR_ROOT", resolvePath(REPO_ROOT, "web")),

  /** Skills directory (Claude Code auto-discovery + kimi --skills-dir). */
  SKILLS_DIR: envPath("SKILLS_DIR", resolvePath(REPO_ROOT, "skills")),

  /** MCP server directory. */
  MCP_DIR: envPath("MCP_DIR", resolvePath(REPO_ROOT, "mcp")),

  /** Playwright tools directory (export-element.mjs, record-element.mjs,
   *  extract-element-html.mjs). Used by exportRender / exportVideo /
   *  exportOgraf to spawn headless Chromium with the project iframe. */
  PLAYWRIGHT_TOOLS_DIR: envPath("PLAYWRIGHT_TOOLS_DIR", resolvePath(REPO_ROOT, "playwright-tools")),

  /** Diagnostic screenshot scratch dir parent. Per-project subdirs are
   *  created on demand at <SCREENSHOT_TMP_ROOT>/<projectId|_workspace>/. */
  SCREENSHOT_TMP_ROOT: envPath("SCREENSHOT_TMP_ROOT", resolvePath(tmpdir(), "ai-atelie-comments")),

  /** Per-run log files (one per /api/comment-edit POST).
   *  /api/_debug/runs surfaces the path so you can `tail -f` a stuck turn. */
  RUN_LOGS_DIR: envPath("RUN_LOGS_DIR", resolvePath(tmpdir(), "ai-atelie-runs")),

  /** CORS origin. "*" in dev so the Vite proxy isn't strictly needed for
   *  cross-origin testing; tighten to a specific origin in prod. */
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "*",

  /** Background verifier subagent (api/src/services/verifier.ts).
   *
   *  Requires ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) — a direct
   *  Anthropic API call distinct from the main `claude` CLI OAuth path.
   *  When the variable is absent the verifier silently no-ops and logs
   *  a console.warn. Most local devs running via subscription auth will
   *  not have this set; the verifier is best-effort QA, not a gate.
   */
  // NOTE: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are read directly
  // by verifier.ts at call time (not exported here) because claude.ts
  // actively strips them for the SDK subprocess. They are intentionally
  // NOT listed in ENV to avoid leaking them through the ENV object.

  /** Kimi prewarm pool: when enabled, route turns through a long-lived
   *  `kimi --print --input-format stream-json` worker per (rootDir,
   *  sessionId) instead of spawning fresh per-turn. Subsequent turns of
   *  the same thread skip the spawn + MCP-server-boot tax (~5s saved
   *  vs cold). End-of-turn detected via wire.jsonl `TurnEnd` events
   *  (no heuristic silence wait).
   *
   *  Default on. Set KIMI_POOL_ENABLED=0 to disable if you suspect a
   *  pool-mode bug — that flips back to fresh-spawn-per-turn behavior. */
  KIMI_POOL_ENABLED: process.env.KIMI_POOL_ENABLED !== "0",

  /** Idle window before a worker is evicted. Bigger = better hit rate
   *  but more idle kimi processes resident. */
  KIMI_POOL_IDLE_MS: envInt("KIMI_POOL_IDLE_MS", 30 * 60 * 1000), // 30min
} as const;

/** Convenience: derived paths inside MCP_DIR. */
export const MCP_PATHS = {
  ASK_USER: resolvePath(ENV.MCP_DIR, "ask-user-server.mjs"),
  ASK_USER_HTTP: resolvePath(ENV.MCP_DIR, "ask-user-http-server.mjs"),
  STARTERS: resolvePath(ENV.MCP_DIR, "starters-server.mjs"),
  CAPABILITIES: resolvePath(ENV.MCP_DIR, "capabilities-server.mjs"),
} as const;

/** The kimi sandbox agent file lives next to the API source so its
 *  `extend: default` resolution is independent of repo layout. */
export const KIMI_SANDBOX_AGENT_PATH = resolvePath(HERE, "config", "kimi-agent-sandbox.yaml");

/** Per-project diagnostic screenshot dir. Scope-fenced so project A's
 *  agent can't read project B's screenshots via additionalDirectories. */
export function screenshotDirFor(projectId?: string): string {
  return resolvePath(ENV.SCREENSHOT_TMP_ROOT, projectId || "_workspace");
}
