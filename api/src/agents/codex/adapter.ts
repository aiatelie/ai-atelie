/* codex/adapter.ts — OpenAI Codex CLI (`codex exec --json`) via subprocess.
 *
 * Structurally mirrors the opencode adapter: spawn the CLI in non-
 * interactive JSON mode, stream-parse its NDJSON into AgentEvents,
 * inject our 3 MCP servers, and resume an in-flight conversation via a
 * process-local editor-uuid → codex-thread-id map.
 *
 * Spawn shape (fresh turn):
 *   codex exec --json --skip-git-repo-check -C <rootDir>
 *     -s workspace-write -c approval_policy=never
 *     [-c mcp_servers.*]  [--add-dir <screenshotDir>]  -
 *   (prompt is written to stdin; `-` tells codex to read it there.)
 *
 * No `-m` flag: with a ChatGPT-account login, Codex picks the model
 * server-side and REJECTS an explicit model override (e.g. `-m
 * gpt-5-codex` → "not supported when using Codex with a ChatGPT
 * account"). Model selection would only work under `--with-api-key`
 * auth, which this app doesn't use. So we let Codex choose.
 *
 * Resume turn:
 *   codex exec --json -c approval_policy=never resume <thread_id> -
 *   (model / sandbox / cwd are restored from the persisted session;
 *    cwd is also set on the child process for good measure.)
 *
 * Auth: the user's ChatGPT subscription via `codex login` — no API key,
 * matching the project's subscription-CLI philosophy. NOTE: a revoked
 * refresh token still reports "Logged in" from `codex login status`
 * but fails at runtime with a `turn.failed`/`error` event (surfaced
 * cleanly to the chat). Re-run `codex login` to fix.
 *
 * Sandbox: `-s workspace-write` confines edits/commands to the project
 * workspace; `approval_policy=never` keeps it non-interactive (mirrors
 * Claude's bypassPermissions posture). No full-disk access.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { screenshotDirFor } from "../../env.ts";
import { preparePromptForPayload, UUID_RE } from "../../services/promptBuilder.ts";
import { registerChild, unregisterChild } from "../../services/runRegistry.ts";
import type { AgentAdapter, AgentProbe } from "../types.ts";
import type { CommentPayload, Emitter } from "../../services/types.ts";
import { buildCodexMcpArgs } from "./mcpConfig.ts";
import { createCodexStreamParser } from "./streamParser.ts";
import { runCodexAppServer } from "./appServer.ts";

/** Use the app-server JSON-RPC transport (streams reasoning) over `exec`
 *  (hides it). Flip to false to fall back to the exec parser if a codex
 *  upgrade breaks the [experimental] app-server protocol. */
const CODEX_USE_APP_SERVER = true;

/** Per-turn silent-output watchdog (mirrors opencode/kimi at 5min). */
const CODEX_SILENT_LIMIT_MS = 300_000;

/** Kill switch for MCP injection. Flip to false to ship Codex without
 *  our MCP servers if a live `codex exec` rejects the nested `-c` TOML
 *  (see mcpConfig.ts). If false, also treat elicitation as "none". */
const CODEX_MCP_ENABLED = true;

/** editor-session-uuid → codex thread id (from `thread.started`).
 *  Process-local, same trade-off as the opencode/kimi/claude stores:
 *  a daemon restart starts conversations fresh (codex's own on-disk
 *  session store is the durable source). */
const editorToCodexThread = new Map<string, string>();

type CodexAttempt = {
  silentTimeout: boolean;
  exitCode: number | null;
  aborted: boolean;
  emittedError: boolean;
  capturedThreadId: string | null;
};

async function runCodex(
  payload: CommentPayload,
  send: Emitter,
  abortSignal?: AbortSignal,
  baseUrl?: string,
  streamId?: string,
): Promise<void> {
  const { prompt, rootDir } = await preparePromptForPayload(payload);
  const editorSid = payload.sessionId && UUID_RE.test(payload.sessionId) ? payload.sessionId : null;
  const codexThread = editorSid ? editorToCodexThread.get(editorSid) : undefined;

  console.log(
    `[runCodex] editorSid=${editorSid?.slice(0, 8) ?? "none"} ` +
    `codexThread=${codexThread?.slice(0, 8) ?? "(new)"} ` +
    `model=(account default) ` +
    `rootDir=${rootDir.split("/").slice(-3).join("/")}`,
  );

  // Screenshot dir must exist before codex can read from it (mirrors
  // the opencode/kimi mkdir pattern).
  const screenshotDir = screenshotDirFor(payload.projectId);
  await mkdir(screenshotDir, { recursive: true }).catch(() => { /* best-effort */ });

  const mcpArgs = CODEX_MCP_ENABLED ? buildCodexMcpArgs(rootDir, baseUrl, streamId) : [];

  // Surface the model's reasoning WHEN codex emits it (mapped to thinking
  // → the timeline's Reasoning block). This flag is free — it only
  // un-hides reasoning codex already produced; it doesn't force extra
  // reasoning. IMPORTANT: gpt-5-codex on a ChatGPT account reasons
  // internally (see `reasoning_output_tokens`) but OpenAI does NOT
  // reliably return the reasoning text on tool-using agentic turns — so
  // Codex reasoning is best-effort here. Claude streams thinking on every
  // turn (see services/claude.ts); for guaranteed reasoning, use Claude.
  const reasoningArgs = ["-c", "show_raw_agent_reasoning=true"];

  let args: string[];
  if (codexThread) {
    // Resume: model/sandbox/cwd restored from the persisted session.
    // `--json` is an exec-level flag applied ahead of the subcommand.
    args = ["exec", "--json", "-c", "approval_policy=never", ...reasoningArgs, "resume", codexThread, "-"];
  } else {
    args = [
      "exec", "--json", "--skip-git-repo-check",
      "-C", rootDir,
      "-s", "workspace-write",
      "-c", "approval_policy=never",
      ...reasoningArgs,
      ...mcpArgs,
      "--add-dir", screenshotDir,
      "-",
    ];
  }

  const result = await spawnCodex({
    args,
    rootDir,
    prompt,
    send,
    abortSignal,
    onThreadId: (tid) => {
      if (editorSid) editorToCodexThread.set(editorSid, tid);
    },
  });

  if (result.aborted) return;

  if (result.silentTimeout) {
    send("error", {
      message:
        `Codex produced no output for ${Math.round(CODEX_SILENT_LIMIT_MS / 1000)}s. ` +
        `Check that you're signed in (\`codex login\`) and try again.`,
    });
    return;
  }

  // An emitted `error`/`turn.failed` is the real failure signal even if
  // the process exits 0 — the parser already sent a normalized error.
  if (result.emittedError) return;
  if (result.exitCode === 0 || result.exitCode === null) return;

  send("error", { message: `codex exited with code ${result.exitCode}` });
}

type SpawnArgs = {
  args: string[];
  rootDir: string;
  prompt: string;
  send: Emitter;
  abortSignal: AbortSignal | undefined;
  onThreadId: (tid: string) => void;
};

function spawnCodex({ args, rootDir, prompt, send, abortSignal, onThreadId }: SpawnArgs): Promise<CodexAttempt> {
  return new Promise<CodexAttempt>((resolve) => {
    let silentTimeout = false;
    let aborted = false;
    let emittedError = false;
    let capturedThreadId: string | null = null;

    const child = spawn("codex", args, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      cwd: rootDir,
      // Prompt rides stdin (the `-` sentinel); stdout = JSONL, stderr =
      // codex's human-readable log lines (timestamps/errors).
      stdio: ["pipe", "pipe", "pipe"],
    });
    registerChild(child.pid);

    // Hand the prompt to codex via stdin, then close it.
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch { /* spawn-error path resolves below */ }

    let watchdog: NodeJS.Timeout | null = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        silentTimeout = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, CODEX_SILENT_LIMIT_MS);
      watchdog.unref?.();
    };
    const disarmWatchdog = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    };
    armWatchdog();

    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 1500).unref?.();
    };
    abortSignal?.addEventListener("abort", onAbort);

    const parser = createCodexStreamParser({
      onAgent: (evt) => send("agent", evt),
      onError: (msg) => {
        emittedError = true;
        send("error", { message: msg });
      },
      onSessionId: (tid) => {
        capturedThreadId = tid;
        onThreadId(tid);
        console.log(`[runCodex] thread captured tid=${tid}`);
      },
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      armWatchdog();
      parser.feed(chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      armWatchdog();
      // Codex logs progress / timestamped errors to stderr. Forward
      // non-empty chunks as diagnostic text (stream:"stderr"), matching
      // the opencode adapter, so the chat can show status without
      // mistaking it for assistant output.
      if (chunk.trim()) send("text", { text: chunk, stream: "stderr" });
    });

    child.on("error", (err) => {
      disarmWatchdog();
      unregisterChild(child.pid);
      abortSignal?.removeEventListener("abort", onAbort);
      send("error", {
        message:
          `codex spawn failed: ${err.message}. ` +
          `Is the Codex CLI installed and in PATH? Install: \`npm i -g @openai/codex\` ` +
          `or see https://github.com/openai/codex.`,
      });
      resolve({ silentTimeout: false, exitCode: null, aborted, emittedError: true, capturedThreadId });
    });

    child.on("close", (code) => {
      disarmWatchdog();
      unregisterChild(child.pid);
      abortSignal?.removeEventListener("abort", onAbort);
      parser.flush();
      resolve({ silentTimeout, exitCode: code, aborted, emittedError, capturedThreadId });
    });
  });
}

type ProbeResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; code: string | null; message: string };

function runProbe(args: string[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("codex", args, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve({ ok: false, code: "ETIMEDOUT", message: `codex ${args.join(" ")} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    t.unref?.();
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ ok: false, code: err.code ?? null, message: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else resolve({ ok: false, code: String(code), message: stderr.trim() || stdout.trim() || `exit ${code}` });
    });
  });
}

/** Probe `codex` on PATH + auth. Models are curated as static presets
 *  (modelPresets.ts), so we return none dynamically. */
async function probeCodex(): Promise<AgentProbe> {
  const version = await runProbe(["--version"], 5_000);
  if (!version.ok) {
    return {
      installed: false,
      setupHint:
        version.code === "ENOENT"
          ? "Install Codex: `npm i -g @openai/codex` or see https://github.com/openai/codex"
          : `codex --version failed: ${version.message}`,
    };
  }

  // `codex login status` prints "Logged in using ChatGPT" when authed —
  // to STDERR, not stdout (exit 0 either way), so check both channels.
  // (A revoked refresh token can still report this and only fail at
  // runtime — best cheap signal available; the chat error-bubble
  // "Sign in to Codex" button handles that recovery.)
  const login = await runProbe(["login", "status"], 8_000);
  const authed = login.ok && /logged in/i.test(`${login.stdout}\n${login.stderr}`);
  if (!authed) {
    return {
      installed: true,
      authRequired: true,
      setupHint: "Run `codex login` in a terminal to sign in with ChatGPT, then refresh.",
    };
  }

  return { installed: true };
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  capabilities: {
    surgicalEdit: true, // codex edits via apply_patch
    elicitationTransport: CODEX_MCP_ENABLED ? "http-bridge" : "none",
    resume: true,
    bashAllowedInSandbox: false, // codex's own -s workspace-write sandbox governs commands
    silentTimeoutMs: CODEX_SILENT_LIMIT_MS,
    supportsPrewarmPool: false,
    supportsCompletion: true,
    // exec hides reasoning text on tool turns (reasoning_output_tokens>0,
    // app-server streams reasoning summaries; exec hides them on tool turns.
    reasoning: CODEX_USE_APP_SERVER
      ? { mode: "streams", enablement: "app-server reasoning summaries (detailed)" }
      : { mode: "hidden-but-present", note: "hidden by provider on tool turns (exec)" },
  },
  async run({ payload, send, abortSignal, baseUrl, streamId }) {
    return CODEX_USE_APP_SERVER
      ? runCodexAppServer(payload, send, abortSignal, baseUrl, streamId)
      : runCodex(payload, send, abortSignal, baseUrl, streamId);
  },
  async complete(args) {
    const { codexComplete } = await import("./complete.ts");
    return codexComplete(args);
  },
  probe: probeCodex,
};
