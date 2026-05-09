/* kimiWorkerPool.ts — long-lived kimi workers per (rootDir, sessionId).
 *
 * Why: spawning kimi fresh per turn pays 5–8s of cold-start (process
 * boot + auth + model planning) every time. Holding one worker open and
 * feeding turns through stdin drops that to <1s for subsequent turns.
 *
 * Worker lifecycle:
 *   • Lazy-spawn on first turn for a given key.
 *   • Per-worker busy lock: turns serialize through one in-flight at a time.
 *   • Idle eviction at KIMI_POOL_IDLE_MS (default 30min).
 *   • Crash recovery: child close removes the worker from the map; next
 *     turn spawns a fresh one.
 *   • Abort: SIGTERM the worker (loses prewarm benefit but is correct).
 *
 * End-of-turn detection (since kimi --print does NOT emit explicit
 * TurnEnd events on stdout): we watch for an `assistant` message whose
 * `content` is a non-empty string AND has no `tool_calls`. That shape
 * is only emitted when the model has finished its reasoning chain. We
 * then wait a brief silence window for safety before resolving.
 *
 * MCP streamId problem solved by /api/_internal/current-stream/:workerKey:
 * the MCP `ask-user-http` server is spawned with WORKER_KEY in env and
 * fetches the *current* turn's streamId per tool call instead of using
 * a stale STREAM_ID baked at spawn time. See currentStreamByWorker.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, stat, open as openFile, type FileHandle } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { ENV, KIMI_SANDBOX_AGENT_PATH, screenshotDirFor } from "../env.ts";
import { registerChild, unregisterChild } from "./runRegistry.ts";
import { kimiLineToAgentEvents } from "./agentEvents.ts";
import { STARTERS, CAPABILITIES, ASK_USER_HTTP } from "../agents/shared/mcpServers.ts";
import type { CommentPayload, Emitter } from "./types.ts";

const KIMI_SESSIONS_DIR = resolvePath(homedir(), ".kimi/sessions");

/** Compute the path to a session's wire.jsonl. Same hashing the session-
 *  exists check uses elsewhere — md5(rootDir) lower-case hex. */
function wireJsonlPathFor(rootDir: string, sessionId: string): string {
  const h = createHash("md5").update(rootDir).digest("hex");
  return resolvePath(KIMI_SESSIONS_DIR, h, sessionId, "wire.jsonl");
}

/** End-of-turn silence window — fallback only. Used when wire.jsonl
 *  tailing fails (file never appeared, lost track of position, etc.).
 *  Primary detection is the wire.jsonl `TurnEnd` event which fires
 *  exactly when kimi finishes a turn. */
const END_OF_TURN_SILENCE_MS = 4000;

/** How often we poll wire.jsonl for new bytes. Cheap stat call; 100ms
 *  is plenty fast for human-perceived latency. */
const WIRE_TAIL_POLL_MS = 100;

/** How long we wait for kimi to create the wire.jsonl file after spawn
 *  before giving up and falling back to silence detection. */
const WIRE_TAIL_OPEN_TIMEOUT_MS = 10_000;

/** Hard wall-clock cap on a single turn (mirrors RUN_MAX_DURATION_MS). */
const TURN_MAX_DURATION_MS = 5 * 60 * 1000;

/** Worker key per (rootDir, sessionId). Sessions are CLI-flag-scoped at
 *  spawn time, so different sessions need different workers. */
function workerKeyOf(rootDir: string, sessionId: string | undefined): string {
  return `${rootDir}::${sessionId ?? "-"}`;
}

type Worker = {
  key: string;
  rootDir: string;
  sessionId: string | undefined;
  child: ChildProcess;
  busy: boolean;
  /** Last successful turn timestamp; used by the idle sweeper. */
  lastUsedAt: number;
  /** Per-line dispatcher for the in-flight turn. Null when idle. */
  onLine: ((line: string) => void) | null;
  /** TurnEnd dispatcher (called when wire.jsonl tail sees a TurnEnd). */
  onTurnEnd: (() => void) | null;
  /** Resolve the in-flight turn promise (called by end-of-turn timer
   *  or close handler). */
  resolveTurn: (() => void) | null;
  /** Path to the worker's wire.jsonl (same for all turns of this
   *  session). Set after the file first appears post-spawn. */
  wireFilePath: string | null;
  /** Bytes already read from wire.jsonl; advances each turn. */
  wireOffset: number;
  /** Tail polling interval for wire.jsonl. */
  wireTailTimer: ReturnType<typeof setInterval> | null;
};

/** Pinned to globalThis so a `bun --hot` reload doesn't lose track of
 *  the workers — they keep running and the new module reattaches. */
const KEY = Symbol.for("ai-atelie.kimiWorkerPool");
type Slot = {
  workers: Map<string, Worker>;
  currentStreamByWorker: Map<string, string>;
  idleSweeper: NodeJS.Timeout | null;
};
function getSlot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  if (!g[KEY]) {
    g[KEY] = {
      workers: new Map(),
      currentStreamByWorker: new Map(),
      idleSweeper: null,
    };
  }
  return g[KEY]!;
}

const slot = getSlot();
export const workers: Map<string, Worker> = slot.workers;
export const currentStreamByWorker: Map<string, string> = slot.currentStreamByWorker;

/** Periodic idle sweeper — kills workers that have been idle longer
 *  than KIMI_POOL_IDLE_MS. Started lazily on first spawn. */
function ensureIdleSweeper() {
  if (slot.idleSweeper) return;
  slot.idleSweeper = setInterval(() => {
    const cutoff = Date.now() - ENV.KIMI_POOL_IDLE_MS;
    for (const [key, w] of workers) {
      if (w.busy) continue;
      if (w.lastUsedAt > cutoff) continue;
      console.log(`[kimiPool] evicting idle worker key=${key.slice(0, 30)} idleSec=${Math.round((Date.now() - w.lastUsedAt) / 1000)}`);
      try { w.child.kill("SIGTERM"); } catch { /* ignore */ }
      workers.delete(key);
      currentStreamByWorker.delete(key);
    }
  }, 60_000);
  slot.idleSweeper.unref?.();
}

function buildPoolMcpConfig(rootDir: string, baseUrl: string, workerKey: string): unknown {
  // No STREAM_ID — the HTTP-bridge MCP server resolves the active
  // streamId per tool call via /api/_internal/current-stream/:workerKey.
  return {
    mcpServers: {
      starters:    STARTERS(rootDir),
      "ask-user":  ASK_USER_HTTP(baseUrl, { workerKey }),
      capabilities: CAPABILITIES(baseUrl),
    },
  };
}

async function spawnWorker(
  rootDir: string,
  sessionId: string | undefined,
  modelId: string | undefined,
  isSandbox: boolean,
  baseUrl: string,
): Promise<Worker> {
  const screenshotDir = screenshotDirFor(undefined);
  await mkdir(screenshotDir, { recursive: true }).catch(() => { /* best-effort */ });

  const key = workerKeyOf(rootDir, sessionId);
  const args: string[] = [];
  if (sessionId) args.push("-S", sessionId);
  if (modelId && modelId.includes("/")) args.push("-m", modelId);
  args.push(
    "--print",
    "-w", rootDir,
    "--add-dir", rootDir,
    "--add-dir", ENV.SKILLS_DIR,
    "--add-dir", screenshotDir,
    "--skills-dir", ENV.SKILLS_DIR,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
  );
  if (isSandbox) args.push("--agent-file", KIMI_SANDBOX_AGENT_PATH);
  args.push("--mcp-config", JSON.stringify(buildPoolMcpConfig(rootDir, baseUrl, key)));

  const child = spawn("kimi", args, {
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
    cwd: rootDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  registerChild(child.pid);

  const w: Worker = {
    key,
    rootDir,
    sessionId,
    child,
    busy: false,
    lastUsedAt: Date.now(),
    onLine: null,
    onTurnEnd: null,
    resolveTurn: null,
    wireFilePath: null,
    wireOffset: 0,
    wireTailTimer: null,
  };

  // Start tailing wire.jsonl (lazy — file doesn't exist yet at spawn).
  // The handler resolves the turn the moment kimi writes a `TurnEnd`
  // event, which is the canonical end-of-turn signal that print-mode
  // stream-json output deliberately omits.
  if (sessionId) {
    void startWireTail(w, sessionId).catch((err) => {
      console.warn(`[kimiPool] wire-tail setup failed for ${key.slice(0, 30)}: ${err?.message ?? err} — falling back to silence detection`);
    });
  }

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      // The "To resume this session" line at process exit is non-JSON
      // and only appears when stdin closes — not during multi-turn.
      // For belt-and-suspenders, skip non-JSON.
      if (!line.startsWith("{")) continue;
      w.onLine?.(line);
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    // stderr from kimi is usually warnings; forward as a system-style
    // notification line so the SSE stream sees it. Wrap in JSON shape
    // the existing chatStream parser ignores (no role:assistant).
    w.onLine?.(JSON.stringify({ _stderr: chunk }));
  });
  child.on("error", (err) => {
    console.warn(`[kimiPool] worker error key=${key.slice(0, 30)} err=${err.message}`);
    workers.delete(key);
    currentStreamByWorker.delete(key);
    unregisterChild(child.pid);
    w.resolveTurn?.();
  });
  child.on("close", (code) => {
    console.log(`[kimiPool] worker closed key=${key.slice(0, 30)} code=${code}`);
    if (w.wireTailTimer) { clearInterval(w.wireTailTimer); w.wireTailTimer = null; }
    workers.delete(key);
    currentStreamByWorker.delete(key);
    unregisterChild(child.pid);
    w.resolveTurn?.();
  });

  workers.set(key, w);
  ensureIdleSweeper();
  console.log(`[kimiPool] spawned worker key=${key.slice(0, 30)} pid=${child.pid} totalWorkers=${workers.size}`);
  return w;
}

/** Tail wire.jsonl, calling onTurnEnd for every `TurnEnd` event. We
 *  poll-stat the file every WIRE_TAIL_POLL_MS, read any new bytes from
 *  our last offset, parse as JSONL, and dispatch. The print-mode JSON
 *  printer drops Turn boundary events, but they're plumbed through the
 *  wire log unfiltered — that's our source of truth. */
async function startWireTail(w: Worker, sessionId: string): Promise<void> {
  const path = wireJsonlPathFor(w.rootDir, sessionId);
  // Wait for kimi to create the file post-spawn.
  const deadline = Date.now() + WIRE_TAIL_OPEN_TIMEOUT_MS;
  let st;
  while (Date.now() < deadline) {
    try { st = await stat(path); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!st) throw new Error(`wire.jsonl never appeared at ${path}`);
  w.wireFilePath = path;
  w.wireOffset = 0; // start reading from the beginning so historical resumes don't miss events

  let fh: FileHandle | null = null;
  let lineBuf = "";
  try { fh = await openFile(path, "r"); }
  catch (err) { throw err; }

  const readNew = async () => {
    if (!fh || !w.wireFilePath) return;
    let curSize: number;
    try { curSize = (await stat(w.wireFilePath)).size; } catch { return; }
    if (curSize <= w.wireOffset) return;
    const len = curSize - w.wireOffset;
    const buf = Buffer.alloc(len);
    try {
      const r = await fh.read(buf, 0, len, w.wireOffset);
      if (!r.bytesRead) return;
      w.wireOffset += r.bytesRead;
      lineBuf += buf.subarray(0, r.bytesRead).toString("utf8");
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          // Wire format: { timestamp, message: { type, payload } }
          // Top-level metadata line has shape { type: "metadata", … } — skip.
          const msgType = evt?.message?.type;
          if (msgType === "TurnEnd") {
            w.onTurnEnd?.();
          }
        } catch { /* malformed line — skip */ }
      }
    } catch { /* file vanished or permission flip — give up */ }
  };

  w.wireTailTimer = setInterval(readNew, WIRE_TAIL_POLL_MS);
  w.wireTailTimer.unref?.();
}

export type WorkerTurnResult = {
  silentTimeout: boolean;
  exitCode: number | null;
  aborted: boolean;
};

/** Run one turn through the pool. Spawns a worker if none exists for
 *  this (rootDir, sessionId), awaits any in-flight turn, sends the
 *  prompt, and resolves on end-of-turn detection. */
export async function runOnPool(
  payload: CommentPayload,
  prompt: string,
  send: Emitter,
  rootDir: string,
  abortSignal: AbortSignal | undefined,
  baseUrl: string,
  streamId: string,
): Promise<WorkerTurnResult> {
  const isSandbox = !!payload.projectId;
  const key = workerKeyOf(rootDir, payload.sessionId);

  // Wait for any in-flight turn on this key before grabbing the worker.
  // Simple busy-wait poll; turns are rare enough that this is fine.
  while (true) {
    const w = workers.get(key);
    if (!w || !w.busy) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  let worker = workers.get(key);
  if (!worker || worker.child.killed || worker.child.exitCode !== null) {
    worker = await spawnWorker(rootDir, payload.sessionId, payload.modelId, isSandbox, baseUrl);
  }

  worker.busy = true;
  // Map this worker to the current request's streamId so the
  // ask-user-http MCP server can fetch it on each tool call.
  currentStreamByWorker.set(key, streamId);

  return new Promise<WorkerTurnResult>((resolve) => {
    let endOfTurnTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;
    let resolved = false;

    const finalize = (result: WorkerTurnResult) => {
      if (resolved) return;
      resolved = true;
      if (endOfTurnTimer) clearTimeout(endOfTurnTimer);
      if (hardTimer) clearTimeout(hardTimer);
      worker!.busy = false;
      worker!.lastUsedAt = Date.now();
      worker!.onLine = null;
      worker!.onTurnEnd = null;
      worker!.resolveTurn = null;
      currentStreamByWorker.delete(key);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const armEndOfTurnTimer = () => {
      if (endOfTurnTimer) clearTimeout(endOfTurnTimer);
      endOfTurnTimer = setTimeout(() => {
        console.log(`[kimiPool] end-of-turn detected key=${key.slice(0, 30)}`);
        finalize({ silentTimeout: false, exitCode: 0, aborted: false });
      }, END_OF_TURN_SILENCE_MS);
    };

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      // Killing the worker on abort is correct (otherwise an aborted
      // turn would still produce output later) but loses the prewarm
      // benefit. The next turn just spawns a new worker.
      console.log(`[kimiPool] abort key=${key.slice(0, 30)} — killing worker`);
      try { worker!.child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { worker!.child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000).unref();
      finalize({ silentTimeout: false, exitCode: null, aborted: true });
    };
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); return; }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // Hard timeout — paranoid safety net if end-of-turn detection
    // misses and the worker also doesn't go silent.
    hardTimer = setTimeout(() => {
      console.warn(`[kimiPool] hard turn timeout key=${key.slice(0, 30)}`);
      // Don't kill the worker; just resolve. Next turn will use it.
      finalize({ silentTimeout: true, exitCode: 0, aborted: false });
    }, TURN_MAX_DURATION_MS);

    // Primary detection: kimi writes a `TurnEnd` event to wire.jsonl
    // exactly when it finishes processing a turn. The wire-tail loop
    // (started at spawn) parses this and calls onTurnEnd.
    worker!.onTurnEnd = () => {
      if (resolved) return;
      console.log(`[kimiPool] TurnEnd received key=${key.slice(0, 30)}`);
      finalize({ silentTimeout: false, exitCode: 0, aborted: false });
    };

    worker!.onLine = (line: string) => {
      let json: any;
      try { json = JSON.parse(line); }
      catch { return; }
      // Forward as normalized agent events. The end-of-turn detection
      // below still inspects the raw json shape (string vs array, tool
      // calls present) since that signal isn't visible from the
      // normalized event union — that's a worker-pool concern, not a
      // chat-display concern.
      for (const evt of kimiLineToAgentEvents(json)) send("agent", evt);

      // End-of-turn detection: an `assistant` message that contains
      // user-visible text AND has no pending tool_calls. Kimi emits
      // this shape only when the model finished its reasoning chain
      // and produced a final answer.
      //
      // Two flavors of "final" content shape based on whether the
      // model is in thinking mode:
      //   • plain:    content: "alpha"
      //   • thinking: content: [{type:"think",...}, {type:"text",text:"alpha"}]
      // Either way, "has at least one user-visible text" + "no tool
      // calls pending" is the signal.
      const hasNoToolCalls = !(Array.isArray(json?.tool_calls) && json.tool_calls.length > 0);
      let hasFinalText = false;
      if (json?.role === "assistant" && hasNoToolCalls) {
        if (typeof json.content === "string" && json.content.length > 0) {
          hasFinalText = true;
        } else if (Array.isArray(json.content)) {
          for (const part of json.content) {
            if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
              hasFinalText = true;
              break;
            }
          }
        }
      }
      if (hasFinalText) {
        armEndOfTurnTimer();
      } else if (endOfTurnTimer) {
        // More work happening — cancel the silence timer.
        clearTimeout(endOfTurnTimer);
        endOfTurnTimer = null;
      }
    };
    worker!.resolveTurn = () => {
      // Worker died unexpectedly during the turn.
      if (resolved) return;
      send("error", { message: "kimi worker died unexpectedly" });
      finalize({ silentTimeout: false, exitCode: worker!.child.exitCode, aborted: false });
    };

    // Send the prompt as one stream-json line.
    const inputLine = JSON.stringify({ role: "user", content: prompt }) + "\n";
    try {
      worker!.child.stdin?.write(inputLine);
    } catch (err) {
      console.warn(`[kimiPool] stdin write failed key=${key.slice(0, 30)}`);
      finalize({ silentTimeout: false, exitCode: null, aborted: false });
      return;
    }
  });
}

/** Looked up by the /api/_internal/current-stream/:workerKey endpoint
 *  so the ask-user-http MCP server can fetch the live streamId per
 *  tool call. */
export function getCurrentStreamForWorker(workerKey: string): string | undefined {
  return currentStreamByWorker.get(workerKey);
}
