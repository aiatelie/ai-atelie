/* canonicalLog.ts — per-stream canonical event log (Phase 1).
 *
 * All four adapters already normalize to the flat `AgentEvent` union and
 * funnel through commentEdit's single `send("agent", …)`. This module
 * tees that funnel into the canonical, block-addressed log that
 * canonicalEvents.ts defines: a stateful converter assigns a monotonic
 * `seq`, opens/closes reasoning + text blocks, mints stable block ids,
 * keeps an in-memory ring (live + in-tab reconnect), and mirrors every
 * event to a durable `runs/canonical/<streamId>.jsonl` (the backstop for
 * post-reload reconnect once the ring is gone — Phase 5).
 *
 * Phase 1 is DUAL-EMIT: the old flat `agent` wire shape is untouched;
 * canonical events ride alongside on a `canon` channel the current
 * frontend ignores. Phase 4 switches the frontend onto `canon` and drops
 * the flat shape. Until then this is validated purely by server tests
 * (canonicalLog.test.ts) against the Phase 0 fold/project.
 *
 * The flat→canonical conversion is the ONE place block boundaries are
 * derived; everything downstream (fold/project/persist/replay) is pure.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { ENV } from "../env.ts";
import type { AgentEvent, AgentUsage } from "./types.ts";
import type { CanonicalEvent, CanonicalEventInput, CanonicalUsage } from "./canonicalEvents.ts";

type StreamState = {
  seq: number;
  openReasoningId: string | null;
  openTextId: string | null;
  /** Once any text block opened, a later `finalText` is a dup (deltas
   *  already carried the prose) and is dropped. */
  textEverOpened: boolean;
  /** Did any reasoning block open this turn (i.e. the provider actually
   *  streamed thinking text)? Drives the withheld-marker decision below. */
  reasoningEverOpened: boolean;
  /** Max reasoning-token count seen on `usage` events. When the provider
   *  spent reasoning tokens but streamed no summary text (codex on a
   *  ChatGPT account often does, esp. under our narration-heavy prompt),
   *  finalize synthesizes a reasoning-meta{withheld} so the UI is honest:
   *  "Reasoned · ~N tok" instead of silently empty (invariant I7). */
  maxReasoningTokens: number;
  ring: CanonicalEvent[];
  jsonlPath: string;
};

const streams = new Map<string, StreamState>();

function canonicalDir(): string {
  return resolvePath(ENV.RUN_LOGS_DIR, "canonical");
}

function ensure(streamId: string): StreamState {
  let s = streams.get(streamId);
  if (!s) {
    s = {
      seq: 0,
      openReasoningId: null,
      openTextId: null,
      textEverOpened: false,
      reasoningEverOpened: false,
      maxReasoningTokens: 0,
      ring: [],
      jsonlPath: resolvePath(canonicalDir(), `${streamId}.jsonl`),
    };
    streams.set(streamId, s);
  }
  return s;
}

/** Append to ring + fire-and-forget the durable jsonl (one JSON object
 *  per line, in seq order). Best-effort, like runLogger. */
let dirReady: Promise<unknown> | null = null;
function persist(s: StreamState, ev: CanonicalEvent): void {
  s.ring.push(ev);
  const line = JSON.stringify(ev) + "\n";
  if (!dirReady) dirReady = mkdir(canonicalDir(), { recursive: true }).catch(() => {});
  void dirReady.then(() => appendFile(s.jsonlPath, line, "utf8")).catch(() => {});
}

function toCanonicalUsage(u: AgentUsage): CanonicalUsage {
  // AgentUsage and CanonicalUsage share field names; copy through. The
  // reasoning-token field is added to AgentUsage in Phase 2.
  const any = u as Record<string, unknown>;
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheCreationInputTokens: u.cacheCreationInputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    reasoningTokens: any.reasoningTokens as number | undefined,
    durationMs: u.durationMs,
    model: u.model,
  };
}

/** Convert one flat AgentEvent into 0+ canonical events, stamping seq,
 *  threading block ids, opening/closing blocks. Persists + returns them
 *  (caller dual-emits on the `canon` wire channel). */
export function pushCanonical(streamId: string, e: AgentEvent): CanonicalEvent[] {
  const s = ensure(streamId);
  const out: CanonicalEvent[] = [];
  const emit = (ev: CanonicalEventInput): void => {
    const full = { ...ev, seq: s.seq++ } as CanonicalEvent;
    out.push(full);
    persist(s, full);
  };
  const closeReasoning = () => {
    if (s.openReasoningId) { emit({ kind: "reasoning-end", id: s.openReasoningId }); s.openReasoningId = null; }
  };
  const closeText = () => {
    if (s.openTextId) { emit({ kind: "text-end", id: s.openTextId }); s.openTextId = null; }
  };

  switch (e.type) {
    case "thinking": {
      if (!e.chunk) break;
      closeText();
      if (!s.openReasoningId) {
        s.openReasoningId = `${streamId}:r${s.seq}`;
        s.reasoningEverOpened = true;
        emit({ kind: "reasoning-start", id: s.openReasoningId });
      }
      emit({ kind: "reasoning-delta", id: s.openReasoningId, chunk: e.chunk });
      break;
    }
    case "text": {
      if (!e.chunk) break;
      closeReasoning();
      if (!s.openTextId) {
        s.openTextId = `${streamId}:t${s.seq}`;
        s.textEverOpened = true;
        emit({ kind: "text-start", id: s.openTextId });
      }
      emit({ kind: "text-delta", id: s.openTextId, chunk: e.chunk });
      break;
    }
    case "finalText": {
      if (!e.chunk || s.textEverOpened) break; // deltas already covered it
      closeReasoning();
      const id = `${streamId}:t${s.seq}`;
      s.textEverOpened = true;
      emit({ kind: "text-start", id });
      emit({ kind: "text-delta", id, chunk: e.chunk });
      emit({ kind: "text-end", id });
      break;
    }
    case "tool": {
      closeReasoning();
      closeText();
      const id = e.tool.id || `${streamId}:tool${s.seq}`;
      emit({ kind: "tool", id, name: e.tool.name, input: e.tool.input });
      break;
    }
    case "toolResult": {
      emit({ kind: "tool-result", id: e.id, content: e.content, isError: e.isError });
      break;
    }
    case "usage": {
      const usage = toCanonicalUsage(e.usage);
      if (typeof usage.reasoningTokens === "number" && usage.reasoningTokens > s.maxReasoningTokens) {
        s.maxReasoningTokens = usage.reasoningTokens;
      }
      emit({ kind: "usage", usage });
      break;
    }
  }
  return out;
}

/** Close any open reasoning/text block at turn end. */
export function finalizeCanonical(streamId: string): CanonicalEvent[] {
  const s = streams.get(streamId);
  if (!s) return [];
  const out: CanonicalEvent[] = [];
  const emit = (ev: CanonicalEventInput) => {
    const full = { ...ev, seq: s.seq++ } as CanonicalEvent;
    out.push(full);
    persist(s, full);
  };
  if (s.openReasoningId) { emit({ kind: "reasoning-end", id: s.openReasoningId }); s.openReasoningId = null; }
  if (s.openTextId) { emit({ kind: "text-end", id: s.openTextId }); s.openTextId = null; }
  // I7 — reasoning never silently empty: the provider spent reasoning
  // tokens but streamed no summary text (codex withholds it under our
  // narration-heavy prompt). Emit an honest withheld marker so the UI
  // shows "Reasoned · ~N tok" rather than nothing. Guarded on
  // !reasoningEverOpened so a turn that DID stream reasoning never
  // double-marks.
  if (!s.reasoningEverOpened && s.maxReasoningTokens > 0) {
    emit({ kind: "reasoning-meta", id: `${streamId}:rmeta`, tokens: s.maxReasoningTokens, withheld: true });
  }
  return out;
}

/** In-memory replay (live + in-tab reconnect): events with seq >= fromSeq. */
export function replayCanonical(streamId: string, fromSeq = 0): CanonicalEvent[] {
  const s = streams.get(streamId);
  if (!s) return [];
  return fromSeq <= 0 ? s.ring.slice() : s.ring.filter((e) => e.seq >= fromSeq);
}

/** Drop the in-memory ring (the jsonl on disk remains the durable
 *  backstop for post-reload reconnect — Phase 5). */
export function disposeCanonical(streamId: string): void {
  streams.delete(streamId);
}
