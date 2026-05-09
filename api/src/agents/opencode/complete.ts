/* agents/opencode/complete.ts — one-shot text completion via the
 * opencode CLI. Used by /api/artifacts/complete (window.ai.complete())
 * when the project's modelId routes to the opencode adapter.
 *
 * Spawns `opencode run --format json --dangerously-skip-permissions
 *   --model <id> "<prompt>"` and parses NDJSON for assistant text.
 * Stripped of OPENCODE_CONFIG_CONTENT (no MCP servers — artifact
 * completions are tool-less by design) and --session (every call is
 * fresh, no resume).
 *
 * The whole point of routing through opencode is that opencode is
 * itself a fan-out: its own config maps `provider/model` ids to
 * Anthropic, OpenAI, Google, local Ollama, etc. So a single artifact
 * authored against `window.ai.complete()` automatically targets
 * whatever the user pointed opencode at — no per-provider code in
 * this codebase.
 *
 * Auth is whatever opencode already has (its own config file +
 * provider keys). The host never sees the key.
 */

import { spawn } from "node:child_process";
import type { AgentCompleteArgs, AgentCompleteResult } from "../types.ts";

const OPENCODE_COMPLETE_TIMEOUT_MS = 60_000;

function flattenMessages(messages: AgentCompleteArgs["messages"]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

/** OpenCode's --format json emits NDJSON events of the form
 *  `{ type, sessionID, properties: { ... } }`. Assistant text rides
 *  inside `properties.part.text` for `message.part.updated` events
 *  whose part.type === "text". This mirrors what
 *  agents/opencode/streamParser.ts already extracts for the agent
 *  path; we re-implement the minimal slice here to avoid pulling
 *  the full streamParser (with its session-id capture and tool
 *  shaping) into the completion path. */
function extractAssistantText(line: unknown): string {
  if (!line || typeof line !== "object") return "";
  const obj = line as {
    type?: string;
    properties?: { part?: { type?: string; text?: string } };
  };
  if (obj.type === "message.part.updated" && obj.properties?.part) {
    const p = obj.properties.part;
    if (p.type === "text" && typeof p.text === "string") return p.text;
  }
  return "";
}

export async function opencodeComplete(
  args: AgentCompleteArgs,
): Promise<AgentCompleteResult> {
  const { messages, abortSignal, modelId } = args;
  if (messages.length === 0) {
    throw new Error("messages must contain at least one entry");
  }
  const prompt = flattenMessages(messages);

  const cliArgs: string[] = ["run", "--format", "json", "--dangerously-skip-permissions"];
  if (modelId) cliArgs.push("--model", modelId);
  cliArgs.push(prompt);

  return new Promise<AgentCompleteResult>((resolve, reject) => {
    const child = spawn("opencode", cliArgs, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // OpenCode emits the assistant's text in incremental updates; the
    // final value is the full text. We track the latest seen text and
    // resolve with that on close. (Building text by appending deltas
    // would double-count since each update re-emits the cumulative
    // string, not a delta — verified against streamParser.ts shape.)
    let latestText = "";
    let stderrBuf = "";
    let stdoutBuf = "";
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 1000).unref();
      reject(new Error("opencode completion timed out"));
    }, OPENCODE_COMPLETE_TIMEOUT_MS);

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
          const t = extractAssistantText(JSON.parse(line));
          if (t) latestText = t;
        } catch {
          // Non-JSON — opencode sometimes prints status. Ignore.
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });
    child.on("error", (err) => {
      if (timer) { clearTimeout(timer); timer = null; }
      abortSignal?.removeEventListener("abort", onAbort);
      reject(new Error(`opencode spawn failed: ${err.message}. Is the opencode CLI installed and in PATH?`));
    });
    child.on("close", (code) => {
      if (timer) { clearTimeout(timer); timer = null; }
      abortSignal?.removeEventListener("abort", onAbort);
      if (aborted) return;
      if (code === 0) {
        resolve({ text: latestText });
        return;
      }
      const stderrTail = stderrBuf.slice(-500).trim();
      reject(new Error(
        `opencode exited with code ${code}${stderrTail ? `: ${stderrTail}` : ""}`,
      ));
    });
  });
}
