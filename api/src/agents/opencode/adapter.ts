/* opencode/adapter.ts — sst/opencode (https://opencode.ai) via subprocess.
 *
 * Pattern verified against nexu-io/open-design's reference adapter
 * (apps/daemon/src/agents.ts and json-event-stream.ts) and three
 * other production integrators (multica-ai/multica, BloopAI/vibe-
 * kanban, openagents-org/openagents). All converge on the same
 * NDJSON event shape.
 *
 * Spawn shape:
 *   opencode run --format json --dangerously-skip-permissions
 *               [--model <id>] [--session <uuid>] "<prompt>"
 *
 * The prompt is passed as a positional arg. opencode 1.4.x's `run`
 * subcommand accepts the message as `[message..]` — it does NOT
 * read from stdin via a `-` sentinel. (Open-design's reference
 * adapter targets a different/newer opencode version that may.)
 * For typical AI Atelie prompts (8-15KB after persona +
 * context + skill bodies) this fits cleanly under Linux argv limit
 * (~128KB) and macOS limit (~256KB). If we ever ship Windows
 * support we'll revisit — Windows CreateProcess caps at ~32KB.
 *
 * MCP servers (ask-user, starters, capabilities) are injected via
 * OPENCODE_CONFIG_CONTENT — opencode's highest-priority config
 * source. See mcpConfig.ts for the schema shim.
 *
 * Resume: opencode's `--session <id>` requires an opencode-internal
 * id (format `ses_<base32>`); passing a foreign uuid (the editor's
 * `payload.sessionId`) silently fails — opencode rejects it and
 * exits 0 with no JSON output, looking exactly like a hung turn
 * from our side. We resolve this with a process-local mapping:
 * `editor-uuid → ses_id`. First turn passes no `--session` (fresh
 * opencode session); the streamParser captures the returned
 * `sessionID` and stores it under the editor's uuid; subsequent
 * turns in the same editor conversation pass the real `ses_id`.
 * Map is in-memory only — daemon restart starts conversations
 * fresh, same trade-off as the kimi/claude session-heal store.
 *
 * Auto-heal: deferred. The kimi/claude orphan+retry-on-exit-1
 * pattern hinges on knowing the wire-corruption signature; we don't
 * have that for opencode yet. v1 surfaces failures cleanly; if a
 * specific corruption mode shows up in real use we'll add a
 * targeted retry then.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { screenshotDirFor } from "../../env.ts";
import { preparePromptForPayload, UUID_RE } from "../../services/promptBuilder.ts";
import { registerChild, unregisterChild } from "../../services/runRegistry.ts";
import type { AgentAdapter, AgentProbe } from "../types.ts";
import type { CommentPayload, Emitter } from "../../services/types.ts";
import { buildOpenCodeConfigContent } from "./mcpConfig.ts";
import { createOpenCodeStreamParser } from "./streamParser.ts";

/** Per-turn silent-output watchdog. OpenCode can stall when an MCP
 *  server hangs or auth is stale; without this, the run leaks until
 *  the route-level RUN_MAX_DURATION_MS fires (10min). 5min mirrors
 *  kimi's value. */
const OPENCODE_SILENT_LIMIT_MS = 300_000;

/** editor-session-uuid → opencode-internal session id (`ses_*`).
 *  Populated by the streamParser's onSessionId callback after
 *  opencode emits its first event. Read on subsequent turns to
 *  resume the same opencode conversation. Process-local; daemon
 *  restart wipes it (intentional — opencode's own session store
 *  on disk is the durable source). */
const editorToOpencodeSession = new Map<string, string>();

type OpenCodeAttempt = {
  silentTimeout: boolean;
  exitCode: number | null;
  aborted: boolean;
  emittedError: boolean;
  /** SessionID captured from the first event, for log/debug. v1
   *  doesn't persist this for resume; the user's payload sessionId
   *  is the source of truth on subsequent turns. */
  capturedSessionId: string | null;
};

async function runOpenCode(
  payload: CommentPayload,
  send: Emitter,
  abortSignal?: AbortSignal,
  baseUrl?: string,
  streamId?: string,
): Promise<void> {
  const { prompt, rootDir } = await preparePromptForPayload(payload);
  const editorSid = payload.sessionId && UUID_RE.test(payload.sessionId) ? payload.sessionId : null;
  // Translate editor uuid → opencode-internal session id. First turn
  // for a conversation has no mapping; opencode generates a new one
  // and our parser captures it via onSessionId.
  const opencodeSid = editorSid ? editorToOpencodeSession.get(editorSid) : undefined;

  console.log(
    `[runOpenCode] editorSid=${editorSid?.slice(0, 8) ?? "none"} ` +
    `opencodeSid=${opencodeSid ?? "(new)"} ` +
    `model=${payload.modelId ?? "(default)"} ` +
    `rootDir=${rootDir.split("/").slice(-3).join("/")}`,
  );

  // Pre-create the screenshot dir — opencode skills/tools may want
  // to write there, and the directory must exist before the agent
  // can `Read` from it (mirrors the kimi mkdir pattern).
  const screenshotDir = screenshotDirFor(payload.projectId);
  await mkdir(screenshotDir, { recursive: true }).catch(() => { /* best-effort */ });

  const args: string[] = ["run", "--format", "json", "--dangerously-skip-permissions"];
  if (payload.modelId) args.push("--model", payload.modelId);
  if (opencodeSid) args.push("--session", opencodeSid);
  // Prompt rides argv as the final positional. See header note.
  args.push(prompt);

  const result = await spawnOpenCode({
    args,
    rootDir,
    send,
    abortSignal,
    baseUrl,
    streamId,
    onSessionId: (sid) => {
      if (editorSid && sid.startsWith("ses_")) {
        editorToOpencodeSession.set(editorSid, sid);
      }
    },
  });

  if (result.aborted) return;

  if (result.silentTimeout) {
    send("error", {
      message:
        `OpenCode produced no output for ${Math.round(OPENCODE_SILENT_LIMIT_MS / 1000)}s. ` +
        `Check that the chosen model+provider is authenticated (\`opencode auth list\`) ` +
        `and try again.`,
    });
    return;
  }

  // Treat opencode's emitted `error` events as the real failure
  // signal even if the process exits 0 — the parser already sent
  // a normalized error to the client, so we just bail without
  // double-emitting.
  if (result.emittedError) return;

  if (result.exitCode === 0 || result.exitCode === null) return;

  send("error", { message: `opencode exited with code ${result.exitCode}` });
}

type SpawnArgs = {
  args: string[];
  rootDir: string;
  send: Emitter;
  abortSignal: AbortSignal | undefined;
  baseUrl: string | undefined;
  streamId: string | undefined;
  /** Called once with opencode's first emitted sessionID, so the caller
   *  can persist `editor-uuid → ses_*` mapping for resume. */
  onSessionId: (sid: string) => void;
};

function spawnOpenCode({
  args,
  rootDir,
  send,
  abortSignal,
  baseUrl,
  streamId,
  onSessionId,
}: SpawnArgs): Promise<OpenCodeAttempt> {
  return new Promise<OpenCodeAttempt>((resolve) => {
    let silentTimeout = false;
    let aborted = false;
    let emittedError = false;
    let capturedSessionId: string | null = null;

    const child = spawn("opencode", args, {
      env: {
        ...process.env,
        // Highest-priority opencode config source. Overrides any
        // user-level opencode.json so our 3 MCP servers are always
        // wired without touching the user's setup.
        OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(rootDir, baseUrl, streamId),
        // Force ANSI off — opencode auto-detects no-TTY but we
        // belt-and-suspenders to keep the JSON stream pristine.
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TERM: "dumb",
      },
      cwd: rootDir,
      // Prompt is passed via argv (see runOpenCode), so stdin stays
      // closed. stdout/stderr piped for parser + diagnostics.
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerChild(child.pid);

    // Silent-output watchdog. Reset on every chunk on stdout/stderr.
    let watchdog: NodeJS.Timeout | null = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        silentTimeout = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, OPENCODE_SILENT_LIMIT_MS);
      watchdog.unref?.();
    };
    const disarmWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    armWatchdog();

    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      // Hard-kill if it doesn't exit promptly (mirrors kimi's pattern).
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 1500).unref?.();
    };
    abortSignal?.addEventListener("abort", onAbort);

    const parser = createOpenCodeStreamParser({
      onAgent: (evt) => {
        send("agent", evt);
      },
      onError: (msg) => {
        emittedError = true;
        send("error", { message: msg });
      },
      onSessionId: (sid) => {
        capturedSessionId = sid;
        onSessionId(sid);
        console.log(`[runOpenCode] session captured sid=${sid}`);
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
      // OpenCode logs human-readable progress to stderr (e.g.
      // "thinking…", "running tool…"). Forward as `text` events
      // with stream:"stderr" so the chat can show diagnostic
      // text without confusing it with assistant output. Skip
      // empty/whitespace chunks.
      if (chunk.trim()) send("text", { text: chunk, stream: "stderr" });
    });

    child.on("error", (err) => {
      disarmWatchdog();
      unregisterChild(child.pid);
      abortSignal?.removeEventListener("abort", onAbort);
      send("error", {
        message:
          `opencode spawn failed: ${err.message}. ` +
          `Is OpenCode installed? \`brew install opencode\` or see https://opencode.ai/docs/install/.`,
      });
      resolve({
        silentTimeout: false,
        exitCode: null,
        aborted,
        emittedError: true,
        capturedSessionId,
      });
    });

    child.on("close", (code) => {
      disarmWatchdog();
      unregisterChild(child.pid);
      abortSignal?.removeEventListener("abort", onAbort);
      // Drain any buffered partial line at EOF.
      parser.flush();
      resolve({
        silentTimeout,
        exitCode: code,
        aborted,
        emittedError,
        capturedSessionId,
      });
    });

  });
}

/** Probe `opencode` on PATH, version it, and list its models. Wrapped
 *  in a single promise so detection.ts memoizes one CLI roundtrip per
 *  TTL window. Returns `installed:false` cleanly on ENOENT — opencode
 *  is optional. */
async function probeOpenCode(): Promise<AgentProbe> {
  const version = await runProbe(["--version"], 5_000);
  if (!version.ok) {
    return {
      installed: false,
      setupHint:
        version.code === "ENOENT"
          ? "Install OpenCode: `brew install opencode` or see https://opencode.ai/docs/install/"
          : `opencode --version failed: ${version.message}`,
    };
  }

  const models = await runProbe(["models"], 8_000);
  // `opencode models` prints `provider/model` per line. Empty / non-
  // zero exit means we have opencode but auth is missing or stale —
  // surface a hint and let the user run `opencode auth login`.
  const lines = models.ok
    ? models.stdout.split("\n").map((l) => l.trim()).filter((l) => l && l.includes("/"))
    : [];

  if (!models.ok || lines.length === 0) {
    return {
      installed: true,
      authRequired: true,
      setupHint:
        "Run `opencode auth login` in a terminal to add provider credentials, then refresh.",
    };
  }

  return { installed: true, models: lines };
}

type ProbeResult =
  | { ok: true; stdout: string }
  | { ok: false; code: string | null; message: string };

function runProbe(args: string[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("opencode", args, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve({ ok: false, code: "ETIMEDOUT", message: `opencode ${args.join(" ")} timed out after ${timeoutMs}ms` });
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
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, code: String(code), message: stderr.trim() || `exit ${code}` });
    });
  });
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  capabilities: {
    surgicalEdit: true, // OpenCode has Edit/Write/Bash tools natively
    elicitationTransport: "http-bridge", // ask-user routes through MCP HTTP bridge
    resume: true,
    bashAllowedInSandbox: false,
    silentTimeoutMs: OPENCODE_SILENT_LIMIT_MS,
    supportsPrewarmPool: false,
  },
  async run({ payload, send, abortSignal, baseUrl, streamId }) {
    return runOpenCode(payload, send, abortSignal, baseUrl, streamId);
  },
  probe: probeOpenCode,
};
