/* agentEvents.ts — provider-frame → AgentEvent mappers.
 *
 * Server-side normalization. Keeps the wire format (and the frontend
 * decoder) provider-agnostic so adding a third adapter doesn't make
 * the editor learn a third raw frame shape.
 *
 * Mirrors the logic that used to live in web/src/lib/chatStream.ts
 * `parseSseBlock` (the "sdk" and "kimi" branches). The frontend now
 * consumes one normalized "agent" channel.
 */

import type { AgentEvent, AgentUsage } from "./types.ts";

type SdkUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type SdkContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: unknown;
};

type SdkMsg = {
  type?: string;
  message?: {
    content?: SdkContentBlock[];
    model?: string;
    usage?: SdkUsage;
  };
  event?: {
    type?: string;
    /** index of the content block this event is for. We use it to
     *  match content_block_delta and content_block_stop events back
     *  to the originating content_block_start (which carries the
     *  tool_use id and name). */
    index?: number;
    /** Set on content_block_start for tool_use blocks. */
    content_block?: { type?: string; id?: string; name?: string };
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      /** Set on input_json_delta — partial JSON for a tool_use input.
       *  Concatenate across deltas to reconstruct the full JSON. */
      partial_json?: string;
    };
  };
  result?: string;
  usage?: SdkUsage;
  duration_ms?: number;
  model?: string;
};

/** Per-call state for tracking which content_block index belongs to
 *  which ask_user tool_use call. Filled by content_block_start,
 *  consumed by content_block_delta and content_block_stop.
 *
 *  Each `runClaude` invocation should mint its own `AgentEventState`
 *  via `newAgentEventState()` and pass it as the second arg to
 *  `sdkMessageToAgentEvents`. Two concurrent runs (two tabs, two
 *  projects) emit overlapping content-block indices — sharing one
 *  module-level Map would cross-contaminate them. */
export type AgentEventState = {
  askUserBlocks: Map<number, { toolUseId: string; toolName: string }>;
};

export function newAgentEventState(): AgentEventState {
  return { askUserBlocks: new Map() };
}

/** True if `name` is one of our ask_user tool aliases. The model may
 *  see either the bare name (when running outside the MCP envelope)
 *  or the namespaced one (`mcp__ask-user__ask_user`). */
function isAskUserToolName(name: string | undefined): boolean {
  if (!name) return false;
  return name === "ask_user" || name === "mcp__ask-user__ask_user";
}

type KimiContentItem = {
  type: string;
  text?: string;
  think?: string;
  name?: string;
  input?: unknown;
};

type KimiMsg = {
  role?: string;
  content?: KimiContentItem[];
};

function extractSdkUsage(m: SdkMsg): AgentUsage | undefined {
  const out: AgentUsage = {};
  const u = m.usage;
  if (u && typeof u === "object") {
    if (typeof u.input_tokens === "number") out.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") out.outputTokens = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === "number") out.cacheCreationInputTokens = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === "number") out.cacheReadInputTokens = u.cache_read_input_tokens;
  }
  if (typeof m.duration_ms === "number") out.durationMs = m.duration_ms;
  if (typeof m.model === "string") out.model = m.model;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Map one Anthropic claude-agent-sdk message to zero or more AgentEvents.
 *  Handles stream_event deltas (text/thinking), assistant tool_use blocks,
 *  user tool_result blocks, and the terminal `result` message (finalText
 *  + per-turn usage). Mirrors chatStream.ts:parseSseBlock pre-Phase-1.
 *
 *  Pass a per-`runClaude` `state` (via `newAgentEventState()`) to scope
 *  the content-block tracking. Concurrent calls without per-call state
 *  would collide on overlapping indices. */
export function sdkMessageToAgentEvents(
  msg: unknown,
  state: AgentEventState = newAgentEventState(),
): AgentEvent[] {
  if (!msg || typeof msg !== "object") return [];
  const m = msg as SdkMsg;
  const askUserBlocks = state.askUserBlocks;

  if (m.type === "stream_event") {
    // Tool-use streaming: announce the start of an ask_user tool_use
    // block so the frontend can mount an empty preview form, then
    // forward each input_json_delta so it can lenient-parse and
    // render questions progressively.
    if (m.event?.type === "content_block_start") {
      const cb = m.event.content_block;
      const idx = m.event.index;
      if (cb?.type === "tool_use" && isAskUserToolName(cb.name) && typeof cb.id === "string" && typeof idx === "number") {
        askUserBlocks.set(idx, { toolUseId: cb.id, toolName: cb.name as string });
        return [{ type: "elicitPreviewStart", toolUseId: cb.id, toolName: cb.name as string }];
      }
      return [];
    }
    if (m.event?.type === "content_block_delta") {
      const d = m.event.delta;
      const idx = m.event.index;
      if (d?.type === "text_delta" && d.text) return [{ type: "text", chunk: d.text }];
      if (d?.type === "thinking_delta" && d.thinking) return [{ type: "thinking", chunk: d.thinking }];
      if (d?.type === "input_json_delta" && typeof d.partial_json === "string" && typeof idx === "number") {
        const tracked = askUserBlocks.get(idx);
        if (tracked) {
          return [{ type: "elicitPreviewDelta", toolUseId: tracked.toolUseId, partialJson: d.partial_json }];
        }
      }
      return [];
    }
    if (m.event?.type === "content_block_stop") {
      const idx = m.event.index;
      if (typeof idx === "number") {
        const tracked = askUserBlocks.get(idx);
        if (tracked) {
          askUserBlocks.delete(idx);
          return [{ type: "elicitPreviewStop", toolUseId: tracked.toolUseId }];
        }
      }
      return [];
    }
    return [];
  }

  if (m.type === "assistant") {
    if (m.message?.content) {
      const out: AgentEvent[] = [];
      for (const c of m.message.content) {
        if (c.type === "tool_use" && c.name) {
          const input = (c as { input?: Record<string, unknown> }).input ?? undefined;
          const id = typeof c.id === "string" ? c.id : undefined;
          out.push({ type: "tool", tool: { name: c.name, input, id } });
        }
      }
      return out;
    }
    // No content → forward just the model id as a partial usage event,
    // so the chat badge can show it before the terminal `result` arrives.
    if (m.message?.model) {
      return [{ type: "usage", usage: { model: m.message.model } }];
    }
    return [];
  }

  // SDK echoes tool outputs as a `user` message with tool_result content.
  if (m.type === "user" && m.message?.content) {
    const out: AgentEvent[] = [];
    for (const raw of m.message.content as unknown as Array<Record<string, unknown>>) {
      if (raw?.type !== "tool_result") continue;
      const id = typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined;
      if (!id) continue;
      const isError = raw.is_error === true;
      let text = "";
      const c = raw.content;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        for (const part of c) {
          const p = part as Record<string, unknown>;
          if (p?.type === "text" && typeof p.text === "string") text += p.text;
        }
      }
      out.push({ type: "toolResult", id, content: text, isError });
    }
    return out;
  }

  if (m.type === "result") {
    const out: AgentEvent[] = [];
    if (m.result) out.push({ type: "finalText", chunk: m.result });
    const usage = extractSdkUsage(m);
    if (usage) out.push({ type: "usage", usage });
    return out;
  }

  return [];
}

/** Map one kimi --print stream-json line to zero or more AgentEvents.
 *  Kimi only emits assistant messages with text or tool_use content;
 *  `think` parts are intentionally dropped (too verbose for chat).
 *  Kimi --print does NOT emit tool_use_id, so toolResult matching is
 *  best-effort; we leave `id` undefined and rely on order. */
export function kimiLineToAgentEvents(obj: unknown): AgentEvent[] {
  if (!obj || typeof obj !== "object") return [];
  const m = obj as KimiMsg;
  if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
  const out: AgentEvent[] = [];
  for (const c of m.content) {
    if (c.type === "text" && c.text) {
      out.push({ type: "text", chunk: c.text });
    } else if (c.type === "tool_use" && c.name) {
      const input = (c as { input?: Record<string, unknown> }).input ?? undefined;
      out.push({ type: "tool", tool: { name: c.name, input } });
    }
    // skip "think" parts — internal reasoning.
  }
  return out;
}
