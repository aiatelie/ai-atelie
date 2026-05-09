/* agents/claude/complete.ts — one-shot text completion via the Claude
 * Code SDK. Used by /api/artifacts/complete (window.ai.complete()).
 *
 * Reuses the same `query()` entrypoint as the agent path so we inherit
 * the user's subscription OAuth (env scrubbed of ANTHROPIC_API_KEY so
 * the keychain wins — see services/claude.ts buildClaudeEnv). No new
 * key required.
 *
 * Stripped to the bone:
 *   • no MCP servers (no ask-user, no starters, no capabilities)
 *   • no skills / additionalDirectories
 *   • all tools disallowed (Read/Edit/Write/Bash/Grep/Glob/etc)
 *   • no session resume (every artifact call is fresh)
 *
 * The SDK still spawns the `claude` CLI internally, so first-call
 * latency is in the 1–3s range. Subsequent calls reuse warm node_modules
 * but each spawn is independent. If artifact completion latency becomes
 * a real problem, the unlock is a per-process pool — same shape as
 * kimiWorkerPool — but for v1 we keep it simple.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCompleteArgs, AgentCompleteResult } from "../types.ts";

function buildClaudeEnv(): NodeJS.ProcessEnv {
  // Mirrors services/claude.ts: scrubbing ANTHROPIC_API_KEY makes the
  // CLI fall back to subscription OAuth from the keychain.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const ALL_DISALLOWED_TOOLS = [
  "Bash", "Edit", "Write", "Read", "Grep", "Glob",
  "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch",
  "Task", "TaskOutput", "TaskStop", "TaskList", "TaskGet",
  "AskUserQuestion",
  "CronCreate", "CronDelete", "CronList",
  "EnterWorktree", "ExitWorktree",
  "Monitor", "PushNotification", "RemoteTrigger", "ScheduleWakeup",
  "LSP",
] as const;

/** Flatten messages[] into a single prompt the SDK can take.
 *  query() accepts a string prompt; multi-turn shaping happens via
 *  the conversation transcript. For one-shot completions we just
 *  hand it the last user message; if more turns are present we
 *  inline them as plain text so context isn't lost. */
function flattenMessages(messages: AgentCompleteArgs["messages"]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export async function claudeComplete(
  args: AgentCompleteArgs,
): Promise<AgentCompleteResult> {
  const { messages, abortSignal, modelId } = args;
  if (messages.length === 0) {
    throw new Error("messages must contain at least one entry");
  }
  const prompt = flattenMessages(messages);

  const abortController = new AbortController();
  abortSignal?.addEventListener("abort", () => abortController.abort());

  const q = query({
    prompt,
    options: {
      env: buildClaudeEnv(),
      executable: "bun" as const,
      model: modelId || undefined,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      disallowedTools: ALL_DISALLOWED_TOOLS as unknown as string[],
      mcpServers: {},
      abortController,
    },
  });

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for await (const msg of q) {
      const m = msg as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        for (const block of m.message!.content!) {
          if (block?.type === "text" && typeof block.text === "string") {
            text += block.text;
          }
        }
      }
      // Some SDK versions emit a final "result" message with usage.
      if (m.usage) {
        inputTokens += m.usage.input_tokens ?? 0;
        outputTokens += m.usage.output_tokens ?? 0;
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new Error("aborted");
    }
    throw err;
  }

  const tokens = inputTokens + outputTokens;
  return { text, tokens: tokens > 0 ? tokens : undefined };
}
