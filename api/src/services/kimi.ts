/* kimi.ts — kimi.com subscription via OAuth, spawned as child of this server.
 *
 * - Single-attempt spawn: spawnKimi() spawns the kimi CLI with --print,
 *   feeds it our prompt, parses stream-json line-by-line, and emits each
 *   line back through the SSE bus.
 * - Top-level orchestrator: runKimi() owns the session-corruption auto-
 *   heal loop (mirrors runClaude) and the silent-watchdog handling.
 *
 * Notes captured during the kimi 1.39 verification round:
 * - `-S <uuid>` accepts both new and existing UUIDs (no resume/create
 *   split).
 * - `-m kimi-code/kimi-for-coding` is the real model id; the legacy
 *   "kimi-k2.6" was fictitious.
 * - `--print` mode does NOT support MCP elicitation/create — we use
 *   the HTTP-bridge MCP (`ask-user-http-server.mjs`) instead.
 * - `--add-dir` paths must exist on disk before kimi starts.
 */

import { spawn } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { ENV, KIMI_SANDBOX_AGENT_PATH, screenshotDirFor } from "../env.ts";
import { preparePromptForPayload, UUID_RE } from "./promptBuilder.ts";
import { registerChild, unregisterChild } from "./runRegistry.ts";
import { runOnPool } from "./kimiWorkerPool.ts";
import { kimiLineToAgentEvents } from "./agentEvents.ts";
import { STARTERS, CAPABILITIES, ASK_USER_HTTP } from "../agents/shared/mcpServers.ts";
import { effectiveSessionId, orphanSession } from "../agents/shared/sessionStore.ts";
import type { CommentPayload, Emitter } from "./types.ts";

const KIMI_SILENT_LIMIT_MS = 300_000; // 5 minutes
const KIMI_SESSIONS_DIR = resolvePath(homedir(), ".kimi/sessions");

function kimiWorkdirHash(rootDir: string): string {
  return createHash("md5").update(rootDir).digest("hex");
}

async function kimiSessionExists(sid: string, rootDir: string): Promise<boolean> {
  try {
    await access(resolvePath(KIMI_SESSIONS_DIR, kimiWorkdirHash(rootDir), sid, "wire.jsonl"));
    return true;
  } catch {
    return false;
  }
}

function buildKimiMcpConfig(
  rootDir: string,
  baseUrl: string | undefined,
  streamId: string | undefined,
): unknown {
  const servers: Record<string, unknown> = { starters: STARTERS(rootDir) };
  if (baseUrl && streamId) {
    servers["ask-user"] = ASK_USER_HTTP(baseUrl, { streamId });
    servers.capabilities = CAPABILITIES(baseUrl);
  }
  return { mcpServers: servers };
}

type KimiAttempt = {
  silentTimeout: boolean;
  exitCode: number | null;
  aborted: boolean;
};

async function spawnKimi(
  payload: CommentPayload,
  prompt: string,
  send: Emitter,
  rootDir: string,
  abortSignal: AbortSignal | undefined,
  baseUrl: string | undefined,
  streamId: string | undefined,
): Promise<KimiAttempt> {
  const isSandbox = !!payload.projectId;
  const screenshotDir = screenshotDirFor(payload.projectId);
  await mkdir(screenshotDir, { recursive: true }).catch(() => { /* best-effort */ });
  const args = [
    "--print",
    "-p", prompt,
    "-w", rootDir,
    "--add-dir", rootDir,
    "--add-dir", ENV.SKILLS_DIR,
    "--add-dir", screenshotDir,
    "--skills-dir", ENV.SKILLS_DIR,
    "--output-format", "stream-json",
  ];
  if (isSandbox) {
    args.push("--agent-file", KIMI_SANDBOX_AGENT_PATH);
  }
  if (payload.sessionId && UUID_RE.test(payload.sessionId)) {
    args.unshift("-S", payload.sessionId);
  }
  if (payload.modelId && payload.modelId.includes("/")) {
    args.unshift("-m", payload.modelId);
  }
  const mcpConfig = buildKimiMcpConfig(rootDir, baseUrl, streamId);
  args.push("--mcp-config", JSON.stringify(mcpConfig));

  return new Promise<KimiAttempt>((resolve) => {
    const child = spawn("kimi", args, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Register PID so a hot reload or graceful shutdown can find and
    // SIGTERM this child if its parent goes away unexpectedly.
    registerChild(child.pid);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let silentTimeout = false;
    let aborted = false;

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000).unref();
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        silentTimeout = true;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, KIMI_SILENT_LIMIT_MS);
    };
    const disarmWatchdog = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    };
    armWatchdog();

    let stdoutBuf = "";
    child.stdout.on("data", (chunk: string) => {
      armWatchdog();
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          for (const evt of kimiLineToAgentEvents(obj)) send("agent", evt);
        } catch {
          send("text", { text: line + "\n" });
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      armWatchdog();
      send("text", { text: chunk, stream: "stderr" });
    });
    child.on("error", (err) => {
      disarmWatchdog();
      unregisterChild(child.pid);
      abortSignal?.removeEventListener("abort", onAbort);
      send("error", { message: `kimi spawn failed: ${err.message}. Is the kimi CLI installed and in PATH?` });
      resolve({ silentTimeout: false, exitCode: null, aborted });
    });
    child.on("close", (code) => {
      disarmWatchdog();
      unregisterChild(child.pid);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({ silentTimeout, exitCode: code, aborted });
    });
  });
}

export async function runKimi(
  payload: CommentPayload,
  send: Emitter,
  abortSignal?: AbortSignal,
  baseUrl?: string,
  streamId?: string,
): Promise<void> {
  const { prompt, rootDir } = await preparePromptForPayload(payload);

  // Pool path: long-lived worker per (rootDir, sessionId). Drops first-
  // byte latency from 5–8s to <1s on subsequent turns. Opt-in via
  // KIMI_POOL_ENABLED=1 until proven stable.
  if (ENV.KIMI_POOL_ENABLED && baseUrl && streamId) {
    console.log(`[runKimi:pool] sid=${payload.sessionId?.slice(0, 8) ?? "none"} model=${payload.modelId ?? "(default)"}`);
    const result = await runOnPool(
      { ...payload, sessionId: payload.sessionId },
      prompt,
      send,
      rootDir,
      abortSignal,
      baseUrl,
      streamId,
    );
    if (result.aborted) return;
    if (result.silentTimeout) {
      send("error", { message: `kimi worker turn exceeded the hard timeout (5min). Try again.` });
      return;
    }
    if (result.exitCode !== null && result.exitCode !== 0) {
      send("error", { message: `kimi worker exited with code ${result.exitCode}` });
    }
    return;
  }

  const originalSid = payload.sessionId && UUID_RE.test(payload.sessionId) ? payload.sessionId : null;
  let sid = effectiveSessionId("kimi", rootDir, originalSid);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const triedResume = !!sid && (await kimiSessionExists(sid, rootDir));

    console.log(
      `[runKimi] attempt=${attempt} originalSid=${originalSid?.slice(0, 8) ?? "none"} ` +
      `effectiveSid=${sid?.slice(0, 8) ?? "none"} triedResume=${triedResume} ` +
      `model=${payload.modelId ?? "(default)"} ` +
      `rootDir=${rootDir.split("/").slice(-3).join("/")}`,
    );

    const result = await spawnKimi(
      { ...payload, sessionId: sid ?? undefined },
      prompt,
      send,
      rootDir,
      abortSignal,
      baseUrl,
      streamId,
    );

    if (result.aborted) return;

    if (result.silentTimeout) {
      send("error", {
        message:
          `kimi produced no output for ${Math.round(KIMI_SILENT_LIMIT_MS / 1000)}s. ` +
          `In a terminal: \`pkill -fi kimi\` (kills the Kimi Code GUI if it's holding the OAuth lock), ` +
          `then \`kimi\` to refresh auth, then try again.`,
      });
      return;
    }

    if (result.exitCode === 0 || result.exitCode === null) return;

    if (attempt === 1 && triedResume && originalSid && result.exitCode === 1) {
      sid = orphanSession("kimi", rootDir, originalSid);
      console.log(`[runKimi] auto-healing → orphan + retry with sid=${sid.slice(0, 8)}`);
      send("status", { phase: "retry", reason: "session-corrupted" });
      continue;
    }

    send("error", { message: `kimi exited with code ${result.exitCode}` });
    return;
  }
}
