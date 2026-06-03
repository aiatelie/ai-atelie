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
import { sdkMessageToAgentEvents } from "./agentEvents.ts";
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

/* ── Ultra mode ──────────────────────────────────────────────────────
 * The "Claude Opus 4.8 Ultra" picker preset rides as a model id with a
 * `-ultra` suffix (the chat wire only carries modelId). We strip the
 * suffix back to the real model and flip on workflow + xhigh effort:
 *   - allow Task/TaskOutput/TaskStop so the agent can spawn subagents
 *   - effort "xhigh" (matches the `ultracode` harness level)
 *   - adaptive thinking + forwardSubagentText, so the nested subagent
 *     transcript surfaces through the same agentEvents mappers.
 * Normal turns keep the tighter, no-subagent toolbox unchanged. */
const ULTRA_SUFFIX = "-ultra";

export function resolveClaudeModel(modelId?: string): { model?: string; ultra: boolean } {
  if (!modelId) return { ultra: false };
  if (modelId.endsWith(ULTRA_SUFFIX)) {
    return { model: modelId.slice(0, -ULTRA_SUFFIX.length), ultra: true };
  }
  return { model: modelId, ultra: false };
}

/** Subagent-spawning / background-task tools. Disallowed on normal
 *  turns; allowed only in Ultra mode. */
const WORKFLOW_TOOLS = ["Task", "TaskOutput", "TaskStop"];

/** Minimal subagent menu for Ultra mode. The Task tool needs at least
 *  one agent definition to spawn — settingSources:[] means no built-in
 *  subagents are inherited. A read-only researcher covers the common
 *  "go look across the project, then come back" workflow without
 *  letting a subagent mutate files behind the main turn's back. */
const ULTRA_AGENTS = {
  explore: {
    description:
      "Read-only research subagent. Use to search across the project's files and report findings; it cannot edit.",
    prompt:
      "You are a read-only research subagent inside a web-design editor. Search the project's files to answer the delegated question, then report concise findings with file paths and short excerpts. Never edit, create, or delete files.",
    tools: ["Read", "Grep", "Glob"],
  },
};

/** Extra query() options merged in only for Ultra turns. */
const ULTRA_OPTIONS = {
  effort: "xhigh" as const,
  thinking: { type: "adaptive" as const },
  agents: ULTRA_AGENTS,
  forwardSubagentText: true,
};

export async function runClaude(
  payload: CommentPayload,
  send: Emitter,
  abortSignal?: AbortSignal,
  baseUrl?: string,
  streamId?: string,
): Promise<void> {
  const { prompt, rootDir } = await preparePromptForPayload(payload);
  const isSandbox = !!payload.projectId;
  const { model: claudeModel, ultra } = resolveClaudeModel(payload.modelId);
  // Disallowed tools — force MCP ask-user, tighten the toolbox. The
  // workflow tools (Task*) are stripped only on normal turns; Ultra
  // mode keeps them so the agent can orchestrate the `explore` subagent.
  const disallowedTools: string[] = [
    "AskUserQuestion",
    "CronCreate", "CronDelete", "CronList",
    "EnterWorktree", "ExitWorktree",
    "Monitor",
    "NotebookEdit",
    "PushNotification",
    "RemoteTrigger",
    "ScheduleWakeup",
    "LSP",
    ...(ultra ? [] : WORKFLOW_TOOLS),
    ...(isSandbox ? ["Bash"] : []),
  ];
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
    `model=${claudeModel ?? "default"} ultra=${ultra} ` +
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

    try {
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
          model: claudeModel || undefined,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          // Stream partial messages so reasoning + text arrive as live
          // deltas — without this, thinking is never emitted as
          // thinking_delta and the timeline shows no thoughts.
          includePartialMessages: true,
          // Adaptive thinking on EVERY turn (not just Ultra) so the
          // model's reasoning is captured and shown in the timeline. The
          // model decides how much to think; simple turns stay fast.
          // Ultra raises effort to xhigh on top of this.
          thinking: { type: "adaptive" as const },
          // Ultra mode (Opus 4.8 Ultra preset): xhigh effort, adaptive
          // thinking, subagent orchestration. {} on normal turns.
          ...(ultra ? ULTRA_OPTIONS : {}),
          // Skills come from `additionalDirectories` only — never from cwd's
          // `.claude/` or `~/.claude/`. Empty `settingSources` makes that
          // explicit and prevents an adapter cwd that happens to contain a
          // `.claude/skills/` from silently bleeding into product runtime.
          settingSources: [],
          // Disallowed tools — force MCP ask-user, tighten the toolbox.
          // Claude Code's native AskUserQuestion has no UI surface in our
          // chat sidebar; forcing mcp__ask-user__ask_user routes through
          // the editor's ElicitForm. The rest are SDK tools irrelevant to
          // a sandbox web-design editor. Computed above so Ultra mode can
          // re-enable the workflow (Task*) tools. See `disallowedTools`.
          disallowedTools,
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

      for await (const msg of q) {
        for (const evt of sdkMessageToAgentEvents(msg)) send("agent", evt);
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

