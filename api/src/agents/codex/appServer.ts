/* codex/appServer.ts — Codex via the `codex app-server` JSON-RPC daemon.
 *
 * WHY: `codex exec --json` HIDES the model's reasoning text on tool-using
 * agentic turns (reasoning_output_tokens>0, no item). The app-server
 * transport STREAMS it — live-proven: `item/reasoning/summaryTextDelta`
 * fires token-by-token alongside `item/agentMessage/delta`, on the user's
 * ChatGPT auth with NO API key. So Codex finally shows its thoughts.
 *
 * Protocol (verified live, codex-cli 0.134, newline-delimited JSON over
 * stdio — NOT LSP Content-Length framing):
 *   → initialize {clientInfo,capabilities}            ← {userAgent,…}
 *   → (notif) initialized {}
 *   → thread/start {cwd,sandbox,approvalPolicy,config} ← {thread:{id}}
 *      (or thread/resume {threadId} to continue a conversation)
 *   → turn/start {threadId, input:[{type:"text",text,text_elements:[]}]}
 *   ← (notifs) item/started · item/reasoning/summaryTextDelta ·
 *      item/agentMessage/delta · item/completed · thread/tokenUsage/updated
 *      · turn/completed · error
 *   → turn/interrupt {threadId}   (Stop)
 *   ← (server requests) execCommandApproval / *requestApproval — auto-OK
 *
 * Per-turn spawn (mirrors the exec adapter's lifecycle): handshake +
 * thread/start|resume + turn/start, stream notifications → AgentEvents,
 * resolve on turn/completed, kill. The exec parser stays as a flagged
 * fallback (adapter.ts) so a codex upgrade can't brick chat.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { screenshotDirFor } from "../../env.ts";
import { preparePromptForPayload, UUID_RE } from "../../services/promptBuilder.ts";
import { registerChild, unregisterChild } from "../../services/runRegistry.ts";
import { buildCodexMcpArgs } from "./mcpConfig.ts";
import type { AgentEvent, CommentPayload, Emitter } from "../../services/types.ts";

/** codex-cli the app-server protocol was verified against. A mismatch
 *  just logs a warning (method names can shift between [experimental]
 *  versions — the exec fallback is the safety net). */
export const CODEX_PINNED_VERSION = "0.134.0";

const SILENT_LIMIT_MS = 300_000;

/** editor-session-uuid → codex app-server thread id, for resume. */
const editorToThread = new Map<string, string>();

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try { return JSON.stringify(v); } catch { return String(v); }
}

type Item = {
  type?: string;
  id?: string;
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number | null;
  status?: string;
  text?: string;
  server?: string;
  tool?: string;
  result?: unknown;
  output?: unknown;
  changes?: unknown;
};

function mapUsage(tu: unknown): AgentEvent | null {
  if (!tu || typeof tu !== "object") return null;
  // ThreadTokenUsage { last, total } — prefer `last` (this turn). Field
  // names vary camel/snake across builds; read both defensively.
  const obj = tu as Record<string, unknown>;
  const b = (obj.last ?? obj.total ?? obj) as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) { const v = b[k]; if (typeof v === "number") return v; }
    return undefined;
  };
  return {
    type: "usage",
    usage: {
      inputTokens: num("inputTokens", "input_tokens"),
      outputTokens: num("outputTokens", "output_tokens"),
      cacheReadInputTokens: num("cachedInputTokens", "cached_input_tokens"),
      reasoningTokens: num("reasoningOutputTokens", "reasoning_output_tokens"),
    },
  };
}

/** PURE: one app-server notification → 0+ AgentEvents. Unit-tested in
 *  appServer.test.ts against recorded notifications. */
export function mapAppServerNotification(method: string, params: Record<string, unknown>): AgentEvent[] {
  switch (method) {
    case "item/agentMessage/delta": {
      const delta = params.delta;
      return typeof delta === "string" && delta ? [{ type: "text", chunk: delta }] : [];
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const delta = params.delta;
      return typeof delta === "string" && delta ? [{ type: "thinking", chunk: delta }] : [];
    }
    case "item/started": {
      const item = params.item as Item | undefined;
      if (!item?.id) return [];
      if (item.type === "commandExecution") {
        return [{ type: "tool", tool: { id: item.id, name: "command", input: { command: item.command ?? "" } } }];
      }
      if (item.type === "fileChange") {
        return [{ type: "tool", tool: { id: item.id, name: "apply_patch", input: item.changes ? { changes: item.changes } : undefined } }];
      }
      if (item.type === "mcpToolCall") {
        return [{ type: "tool", tool: { id: item.id, name: `${item.server ?? "mcp"}/${item.tool ?? "tool"}` } }];
      }
      return [];
    }
    case "item/completed": {
      const item = params.item as Item | undefined;
      if (!item?.id) return [];
      if (item.type === "commandExecution") {
        const isError = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0);
        return [{ type: "toolResult", id: item.id, content: item.aggregatedOutput ?? "", isError }];
      }
      if (item.type === "fileChange") {
        return [{ type: "toolResult", id: item.id, content: "applied", isError: item.status === "failed" }];
      }
      if (item.type === "mcpToolCall") {
        return [{ type: "toolResult", id: item.id, content: stringify(item.result ?? item.output), isError: item.status === "failed" }];
      }
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
        // finalText is deduped by the canonical converter against deltas.
        return [{ type: "finalText", chunk: item.text }];
      }
      return [];
    }
    case "thread/tokenUsage/updated": {
      const u = mapUsage(params.tokenUsage);
      return u ? [u] : [];
    }
    case "turn/completed": {
      const turn = params.turn as Record<string, unknown> | undefined;
      const u = turn ? mapUsage(turn.tokenUsage ?? turn.usage) : null;
      return u ? [u] : [];
    }
    default:
      return [];
  }
}

type Attempt = { aborted: boolean; emittedError: boolean };

export async function runCodexAppServer(
  payload: CommentPayload,
  send: Emitter,
  abortSignal?: AbortSignal,
  baseUrl?: string,
  streamId?: string,
): Promise<void> {
  const { prompt, rootDir } = await preparePromptForPayload(payload);
  const editorSid = payload.sessionId && UUID_RE.test(payload.sessionId) ? payload.sessionId : null;
  const resumeThreadId = editorSid ? editorToThread.get(editorSid) : undefined;
  await mkdir(screenshotDirFor(payload.projectId), { recursive: true }).catch(() => {});

  console.log(
    `[runCodexAppServer] editorSid=${editorSid?.slice(0, 8) ?? "none"} ` +
    `resumeThread=${resumeThreadId?.slice(0, 8) ?? "(new)"} ` +
    `rootDir=${rootDir.split("/").slice(-3).join("/")}`,
  );

  // MCP servers MUST go through spawn-level `-c` overrides, NOT the
  // thread/start `config` object: passing `config.mcp_servers` silently
  // SUPPRESSES reasoning streaming (verified — summaryTextDelta drops to
  // 0). Via spawn `-c`, both MCP startup AND reasoning summaries work.
  const mcpArgs = buildCodexMcpArgs(rootDir, baseUrl, streamId);

  const result = await new Promise<Attempt>((resolve) => {
    const child = spawn("codex", ["app-server", ...mcpArgs], {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    registerChild(child.pid);

    let nextId = 1;
    let threadId: string | null = null;
    let aborted = false;
    let emittedError = false;
    let settled = false;
    let buf = "";

    const rpc = (method: string, params: unknown): number => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return id;
    };
    const notify = (method: string, params: unknown) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    };

    // Silent-output watchdog (mirrors exec/opencode).
    let watchdog: NodeJS.Timeout | null = null;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* */ } }, SILENT_LIMIT_MS);
      watchdog.unref?.();
    };
    const disarm = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };

    const finish = () => {
      if (settled) return;
      settled = true;
      disarm();
      unregisterChild(child.pid);
      abortSignal?.removeEventListener("abort", onAbort);
      try { child.kill("SIGTERM"); } catch { /* */ }
      resolve({ aborted, emittedError });
    };

    const onAbort = () => {
      aborted = true;
      if (threadId) { try { notify("turn/interrupt", { threadId }); rpc("turn/interrupt", { threadId }); } catch { /* */ } }
      setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* */ } }, 500).unref?.();
      setTimeout(finish, 1200).unref?.();
    };
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); }
      else abortSignal.addEventListener("abort", onAbort);
    }

    const handle = (msg: Record<string, unknown>) => {
      // server → client request: auto-approve to stay non-interactive.
      if (typeof msg.method === "string" && msg.id !== undefined) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { decision: "approved" } }) + "\n");
        return;
      }
      // notification
      if (typeof msg.method === "string") {
        const method = msg.method;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        if (method === "error") {
          const m = (params.message as string) ?? (params.error as { message?: string })?.message ?? "Codex error";
          emittedError = true;
          send("error", { message: m });
          finish();
          return;
        }
        for (const ev of mapAppServerNotification(method, params)) send("agent", ev);
        if (method === "turn/completed") finish();
        return;
      }
      // response to our request
      if (msg.id !== undefined) {
        if (msg.error) {
          const e = msg.error as { message?: string };
          // thread/resume can fail (thread gone) → start fresh.
          if (resumeThreadId && !threadId) { rpc("thread/start", threadStartParams()); return; }
          emittedError = true;
          send("error", { message: `codex app-server: ${e.message ?? "request failed"}` });
          finish();
          return;
        }
        const res = msg.result as Record<string, unknown> | undefined;
        if (msg.id === 1) {
          notify("initialized", {});
          if (resumeThreadId) rpc("thread/resume", { threadId: resumeThreadId });
          else rpc("thread/start", threadStartParams());
          return;
        }
        const thread = res?.thread as { id?: string } | undefined;
        if (thread?.id && !threadId) {
          threadId = thread.id;
          if (editorSid) editorToThread.set(editorSid, threadId);
          rpc("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
          });
        }
      }
    };

    function threadStartParams() {
      // Reasoning ONLY in the thread config — MCP is wired via spawn `-c`
      // above (mixing them here kills reasoning streaming).
      return {
        cwd: rootDir,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        config: {
          model_reasoning_summary: "detailed",
          model_reasoning_effort: "high",
        },
      };
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      arm();
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { continue; }
        handle(msg);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { arm(); if (c.trim()) send("text", { text: c, stream: "stderr" }); });
    child.on("error", (err) => {
      emittedError = true;
      send("error", {
        message: `codex app-server spawn failed: ${err.message}. Is the Codex CLI installed? \`npm i -g @openai/codex\`.`,
      });
      finish();
    });
    child.on("close", () => finish());

    arm();
    rpc("initialize", { clientInfo: { name: "ai-atelie", title: null, version: "0.1.8" }, capabilities: null });
  });

  if (result.aborted || result.emittedError) return;
}
