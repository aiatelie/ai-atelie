/* claude.ts — Claude Code via @anthropic-ai/claude-agent-sdk's `query()`.
 *
 * The SDK spawns the `claude` CLI internally. We pass:
 *   - cwd / env: stripped of ANTHROPIC_API_KEY etc. so subscription OAuth
 *     wins over a stale key (see disler/max-your-cc-sub).
 *   - additionalDirectories: SKILLS_DIR + per-project screenshot dir.
 *   - mcpServers: ask-user (elicitation), starters, capabilities.
 *   - executable: "bun" (per claude-agent-sdk #266 — when our parent is
 *     Bun, the spawned CLI inherits the runtime; otherwise it crashes
 *     with `ReferenceError: Bun is not defined` inside its own utils).
 *   - permissionMode: bypassPermissions; sandbox runs disallow Bash.
 *
 * Session corruption auto-heal mirrors runKimi: detect the per-cwd JSONL,
 * orphan + remap on exit-1 after a resume, retry once.
 */

import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ENV, screenshotDirFor } from "../env.ts";
import { preparePromptForPayload, UUID_RE } from "./promptBuilder.ts";
import { createPending } from "./elicitBus.ts";
import { sdkMessageToAgentEvents, newAgentEventState } from "./agentEvents.ts";
import { ASK_USER_STDIO, STARTERS, CAPABILITIES } from "../agents/shared/mcpServers.ts";
import { effectiveSessionId, orphanSession, sessionRemapSize } from "../agents/shared/sessionStore.ts";
import type { CommentPayload, Emitter } from "./types.ts";

const CLAUDE_PROJECTS_DIR = resolvePath(homedir(), ".claude/projects");

function claudeSlug(rootDir: string): string {
  return rootDir.replace(/[^a-zA-Z0-9-]/g, "-");
}

async function claudeSessionExists(sessionId: string, rootDir: string): Promise<boolean> {
  try {
    await access(resolvePath(CLAUDE_PROJECTS_DIR, claudeSlug(rootDir), `${sessionId}.jsonl`));
    return true;
  } catch {
    return false;
  }
}


function buildClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export async function runClaude(
  payload: CommentPayload,
  send: Emitter,
  abortSignal?: AbortSignal,
  baseUrl?: string,
  streamId?: string,
): Promise<void> {
  const { prompt, rootDir } = await preparePromptForPayload(payload);
  const isSandbox = !!payload.projectId;
  const originalSid = payload.sessionId && UUID_RE.test(payload.sessionId) ? payload.sessionId : null;
  const abortController = new AbortController();
  abortSignal?.addEventListener("abort", () => {
    abortController.abort();
  });

  let sid = effectiveSessionId("claude", rootDir, originalSid);
  let sessionExists = sid ? await claudeSessionExists(sid, rootDir) : false;
  let attempt = 0;

  console.log(
    `[runClaude] originalSid=${originalSid?.slice(0, 8) ?? "none"} ` +
    `effectiveSid=${sid?.slice(0, 8) ?? "none"} ` +
    `sessionExists=${sessionExists} ` +
    `remapSize=${sessionRemapSize()} ` +
    `rootDir=${rootDir.split("/").slice(-3).join("/")}`,
  );

  // Loop runs at most twice: once for the normal try, once after we
  // detect a corrupt-session crash and orphan it.
  while (true) {
    attempt += 1;
    const triedResume = !!sid && sessionExists;

    const sessionOpts = sid
      ? sessionExists
        ? { resume: sid }
        : { sessionId: sid }
      : {};

    // Track in-flight ask_user tool_uses in FIFO order so each
    // onElicitation pairs with its originating tool_use even when the
    // model emits two ask_user blocks in one assistant message. Single
    // `let lastAskUserToolUseId` would lose the first id when the
    // second block's start event arrived; the SDK then awaits the
    // elicit callbacks serially in block order, so a queue (pushed on
    // preview start, shifted on onElicitation) lines up correctly.
    const pendingAskUserToolUseIds: string[] = [];

    const q = query({
      prompt,
      options: {
        cwd: rootDir,
        env: buildClaudeEnv(),
        // Tell the SDK to spawn `claude` under Bun. Without this, the
        // spawned CLI crashes with `ReferenceError: Bun is not defined`
        // when our parent is Bun (see claude-agent-sdk #266).
        executable: "bun" as const,
        additionalDirectories: [
          ENV.SKILLS_DIR,
          screenshotDirFor(payload.projectId),
        ],
        model: payload.modelId || undefined,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Skills come from `additionalDirectories` only — never from cwd's
        // `.claude/` or `~/.claude/`. Empty `settingSources` makes that
        // explicit and prevents an adapter cwd that happens to contain a
        // `.claude/skills/` from silently bleeding into product runtime.
        settingSources: [],
        // Disallowed tools — force MCP ask-user, tighten toolbox to relevant tools.
        // Claude Code's native AskUserQuestion has no UI surface in our chat sidebar;
        // force the model onto mcp__ask-user__ask_user which routes through the
        // editor's ElicitForm. The rest are SDK tools irrelevant to a sandbox
        // web-design editor (no cron, no worktrees, no notebooks, no remote
        // triggers, no scheduling, no LSP, no subagent-spawning).
        disallowedTools: [
          "AskUserQuestion",
          "CronCreate", "CronDelete", "CronList",
          "EnterWorktree", "ExitWorktree",
          "Monitor",
          "NotebookEdit",
          "PushNotification",
          "RemoteTrigger",
          "ScheduleWakeup",
          "Task", "TaskOutput", "TaskStop",
          "LSP",
          ...(isSandbox ? ["Bash"] : []),
        ] as string[],
        abortController,
        ...sessionOpts,
        mcpServers: {
          "ask-user":  { type: "stdio", ...ASK_USER_STDIO() },
          "starters":  { type: "stdio", ...STARTERS(rootDir) },
          ...(baseUrl
            ? { "capabilities": { type: "stdio" as const, ...CAPABILITIES(baseUrl) } }
            : {}),
        },
        onElicitation: async (req: any) => {
          const { id, promise } = createPending(streamId);
          send("elicit", {
            id,
            // FIFO match against the queue of in-flight ask_user
            // tool_uses. The SDK invokes onElicitation in the same
            // order the content blocks completed, so the oldest
            // queued id is the one this elicit corresponds to.
            previewToolUseId: pendingAskUserToolUseIds.shift(),
            serverName: req.serverName,
            message: req.message,
            mode: req.mode,
            schema: req.requestedSchema,
            title: req.title,
            displayName: req.displayName,
            description: req.description,
          });
          const result = await promise;
          return result as any;
        },
      },
    });

    // Per-call state for content_block index tracking. A module-level
    // Map would cross-contaminate concurrent runs (two tabs, two
    // projects) since their content-block indices both start at 0.
    const agentState = newAgentEventState();
    try {
      for await (const msg of q) {
        for (const evt of sdkMessageToAgentEvents(msg, agentState)) {
          if (evt.type === "elicitPreviewStart") {
            pendingAskUserToolUseIds.push(evt.toolUseId);
          }
          send("agent", evt);
        }
      }
      return; // success
    } catch (err) {
      if (abortController.signal.aborted) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[runClaude] attempt=${attempt} triedResume=${triedResume} ` +
        `sid=${sid?.slice(0, 8) ?? "none"} ERROR: ${msg}`,
      );
      if (err instanceof Error && err.stack) {
        console.error(err.stack.split("\n").slice(0, 5).join("\n"));
      }
      if (
        attempt === 1 &&
        triedResume &&
        originalSid &&
        /exited with code 1/i.test(msg)
      ) {
        sid = orphanSession("claude", rootDir, originalSid);
        sessionExists = false;
        console.log(`[runClaude] auto-healing → orphan + retry with sid=${sid.slice(0, 8)}`);
        send("status", { phase: "retry", reason: "session-corrupted" });
        continue;
      }
      send("error", { message: `claude SDK error: ${msg}` });
      return;
    }
  }
}

