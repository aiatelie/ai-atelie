/* agents/kimi/complete.ts — one-shot text completion via the kimi CLI.
 * Used by /api/artifacts/complete (window.ai.complete()) when the
 * project's modelId routes to the kimi adapter.
 *
 * Spawns `kimi --print -p <prompt>` with stream-json output and
 * extracts the assistant's text. Stripped of the agent path's MCP
 * config, --add-dir flags, --skills-dir, and --agent-file: this is a
 * pure text completion, not an editing turn. No session resume — every
 * artifact call is fresh.
 *
 * Auth is whatever kimi already has (env vars, OAuth via the kimi CLI's
 * own keychain). The host never sees the key.
 *
 * Latency: cold spawn ~3-5s. The kimi worker pool exists for the agent
 * path but we don't reuse it here — pool turns carry editor state
 * (--mcp-config, --add-dir) we explicitly don't want for artifacts.
 * If artifact latency proves painful, a separate "completion pool"
 * with a stripped flag set is the right unlock.
 */

import { spawn } from "node:child_process";
import type { AgentCompleteArgs, AgentCompleteResult } from "../types.ts";

const KIMI_COMPLETE_TIMEOUT_MS = 60_000; // 1 minute hard cap

function flattenMessages(messages: AgentCompleteArgs["messages"]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

/** Walk a kimi stream-json line and return any assistant text it
 *  contains. Real shape (verified against kimi 1.39 --print output):
 *
 *    { "role": "assistant",
 *      "content": [
 *        { "type": "think", "think": "...", "encrypted": null },
 *        { "type": "text", "text": "Hello there, friend!" }
 *      ] }
 *
 *  We pull text blocks only — `think` blocks are the model's chain-of-
 *  thought and not part of the answer the artifact wants. */
function extractAssistantText(line: unknown): string {
  if (!line || typeof line !== "object") return "";
  const obj = line as {
    role?: string;
    content?: unknown;
  };
  if (obj.role === "assistant" && Array.isArray(obj.content)) {
    let out = "";
    for (const block of obj.content as Array<{ type?: string; text?: string }>) {
      if (block?.type === "text" && typeof block.text === "string") out += block.text;
    }
    return out;
  }
  return "";
}

export async function kimiComplete(
  args: AgentCompleteArgs,
): Promise<AgentCompleteResult> {
  const { messages, abortSignal, modelId } = args;
  if (messages.length === 0) {
    throw new Error("messages must contain at least one entry");
  }
  const prompt = flattenMessages(messages);

  const cliArgs = ["--print", "-p", prompt, "--output-format", "stream-json"];
  if (modelId) cliArgs.unshift("-m", modelId);

  return new Promise<AgentCompleteResult>((resolve, reject) => {
    const child = spawn("kimi", cliArgs, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let text = "";
    let stderrBuf = "";
    let stdoutBuf = "";
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 1000).unref();
      reject(new Error("kimi completion timed out"));
    }, KIMI_COMPLETE_TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error("aborted"));
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          text += extractAssistantText(JSON.parse(line));
        } catch {
          // Non-JSON line — kimi sometimes prefixes with status lines.
          // Ignore: stream-json wraps real content.
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });
    child.on("error", (err) => {
      if (timer) { clearTimeout(timer); timer = null; }
      abortSignal?.removeEventListener("abort", onAbort);
      reject(new Error(`kimi spawn failed: ${err.message}. Is the kimi CLI installed and in PATH?`));
    });
    child.on("close", (code) => {
      if (timer) { clearTimeout(timer); timer = null; }
      abortSignal?.removeEventListener("abort", onAbort);
      if (aborted) return; // already rejected
      if (code === 0) {
        resolve({ text });
        return;
      }
      const stderrTail = stderrBuf.slice(-500).trim();
      reject(new Error(
        `kimi exited with code ${code}${stderrTail ? `: ${stderrTail}` : ""}`,
      ));
    });
  });
}
