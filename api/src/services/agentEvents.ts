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
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  result?: string;
  usage?: SdkUsage;
  duration_ms?: number;
  model?: string;
};

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
 *  + per-turn usage). Mirrors chatStream.ts:parseSseBlock pre-Phase-1. */
export function sdkMessageToAgentEvents(msg: unknown): AgentEvent[] {
  if (!msg || typeof msg !== "object") return [];
  const m = msg as SdkMsg;

  if (m.type === "stream_event" && m.event?.type === "content_block_delta") {
    const d = m.event.delta;
    if (d?.type === "text_delta" && d.text) return [{ type: "text", chunk: d.text }];
    if (d?.type === "thinking_delta" && d.thinking) return [{ type: "thinking", chunk: d.thinking }];
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
 *  Kimi emits assistant messages with text, tool_use, or `think` content.
 *  We now FORWARD `think` as reasoning (capture is never the place to
 *  discard — verbosity is a UI concern; the reasoning capsule collapses).
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
    } else if (c.type === "think" && c.think) {
      out.push({ type: "thinking", chunk: c.think });
    }
  }
  return out;
}
