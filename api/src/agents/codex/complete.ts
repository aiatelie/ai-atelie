/* codex/complete.ts — one-shot text completion via the Codex CLI.
 * Used by /api/artifacts/complete (window.ai.complete()) when the
 * project's modelId routes to the codex adapter.
 *
 * Spawns `codex exec --json -s read-only --skip-git-repo-check -` with
 * the prompt on stdin: no MCP servers, no workspace writes, no session
 * resume. Reuses the shared stream parser to harvest assistant text +
 * token usage, so the exec-JSON schema mapping lives in one place.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { AgentCompleteArgs, AgentCompleteResult } from "../types.ts";
import { createCodexStreamParser } from "./streamParser.ts";

const CODEX_COMPLETE_TIMEOUT_MS = 60_000;

function flattenMessages(messages: AgentCompleteArgs["messages"]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export async function codexComplete(args: AgentCompleteArgs): Promise<AgentCompleteResult> {
  const { messages, abortSignal } = args;
  if (messages.length === 0) {
    throw new Error("messages must contain at least one entry");
  }
  const prompt = flattenMessages(messages);

  // No `-m`: ChatGPT-account Codex picks the model server-side and
  // rejects explicit overrides (see adapter.ts). Let Codex choose.
  const cliArgs = [
    "exec", "--json", "--skip-git-repo-check", "-s", "read-only",
    "-",
  ];

  return new Promise<AgentCompleteResult>((resolve, reject) => {
    const child = spawn("codex", cliArgs, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let text = "";
    let totalTokens = 0;
    let errorMsg: string | null = null;
    let stderrBuf = "";
    let aborted = false;

    const parser = createCodexStreamParser({
      onAgent: (e) => {
        if (e.type === "text") text += e.chunk;
        else if (e.type === "usage") {
          totalTokens += (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0);
        }
      },
      onError: (msg) => { errorMsg = msg; },
    });

    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 1000).unref();
      reject(new Error("codex completion timed out"));
    }, CODEX_COMPLETE_TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error("aborted"));
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch { /* error path handles it */ }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => parser.feed(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderrBuf += chunk; });

    child.on("error", (err) => {
      if (timer) { clearTimeout(timer); timer = null; }
      abortSignal?.removeEventListener("abort", onAbort);
      reject(new Error(`codex spawn failed: ${err.message}. Is the Codex CLI installed and in PATH?`));
    });

    child.on("close", (code) => {
      if (timer) { clearTimeout(timer); timer = null; }
      abortSignal?.removeEventListener("abort", onAbort);
      if (aborted) return;
      parser.flush();
      if (errorMsg) { reject(new Error(errorMsg)); return; }
      if (code === 0) {
        resolve({ text, tokens: totalTokens > 0 ? totalTokens : undefined });
        return;
      }
      const stderrTail = stderrBuf.slice(-500).trim();
      reject(new Error(`codex exited with code ${code}${stderrTail ? `: ${stderrTail}` : ""}`));
    });
  });
}
