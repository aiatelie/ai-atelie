/* canonicalEvents.ts — the single source of truth for a turn's shape.
 *
 * ⚠️ HAND-MIRRORED from api/src/services/canonicalEvents.ts. This module is
 * intentionally dependency-free (no React, no Node) on BOTH sides so the
 * exact same fold/project logic runs server-side (replay/tests) and here in
 * the browser. Keep the two byte-identical below the header comment — the
 * invariant suites (api canonicalEvents.test.ts + web canonicalEvents.test.ts)
 * guard that the logic stays in agreement. This is the same duplication
 * pattern we already use for AgentEvent (api) ↔ StreamEvent (web).
 *
 * A turn is an ordered, seq-stamped, block-addressed, append-only log of
 * CanonicalEvents. The live UI, persistence, and reconnect are all PURE
 * FOLDS over that log — so live == persisted == replayed == reconnected
 * by construction, killing the class of drift bugs (the "9 tools / 6
 * entries" mismatch, triple finalText dedup, two divergent reducers).
 *
 * EVENT MODEL — every event carries { seq, id? }:
 *   reasoning-start/-delta/-end/-meta   — the model's thoughts (a block)
 *   text-start/-delta/-end              — assistant prose (a block)
 *   tool / tool-result                  — a tool call + its result (one block, by id)
 *   usage | status | error              — turn-level
 */

export type CanonicalUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Reasoning tokens the model spent (e.g. codex reasoning_output_tokens). */
  reasoningTokens?: number;
  durationMs?: number;
  model?: string;
};

export type CanonicalEvent =
  | { kind: "reasoning-start"; seq: number; id: string }
  | { kind: "reasoning-delta"; seq: number; id: string; chunk: string }
  | { kind: "reasoning-end"; seq: number; id: string }
  /** Honest "reasoning happened but the provider withheld the text"
   *  (codex agentic turns) or post-hoc token attribution. */
  | { kind: "reasoning-meta"; seq: number; id: string; tokens?: number; withheld?: boolean }
  | { kind: "text-start"; seq: number; id: string }
  | { kind: "text-delta"; seq: number; id: string; chunk: string }
  | { kind: "text-end"; seq: number; id: string }
  | { kind: "tool"; seq: number; id: string; name: string; input?: Record<string, unknown> }
  | { kind: "tool-result"; seq: number; id: string; content: string; isError?: boolean }
  | { kind: "usage"; seq: number; usage: CanonicalUsage }
  | { kind: "status"; seq: number; phase?: string; message?: string }
  | { kind: "error"; seq: number; message: string };

/** A CanonicalEvent without its `seq` — distributes Omit over the union
 *  so each member keeps its own fields (a plain Omit<Union,"seq"> would
 *  collapse to the common keys). The append seam stamps `seq`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CanonicalEventInput = DistributiveOmit<CanonicalEvent, "seq">;

export type ReasoningBlock = {
  kind: "reasoning";
  id: string;
  /** seq of first appearance — stable chronological order key. */
  order: number;
  text: string;
  tokens?: number;
  withheld: boolean;
  done: boolean;
};
export type TextBlock = { kind: "text"; id: string; order: number; text: string; done: boolean };
export type ToolBlock = {
  kind: "tool";
  id: string;
  order: number;
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
};
export type Block = ReasoningBlock | TextBlock | ToolBlock;

export type FoldState = {
  /** Blocks in first-appearance (seq) order. */
  blocks: Block[];
  /** id → index into `blocks`. */
  byId: Record<string, number>;
  /** Highest seq incorporated — gives O(1) dedup/idempotency for the
   *  monotonic, in-order delivery the server guarantees (SSE preserves
   *  order; reconnect replays a suffix; overlap replays re-send <= this
   *  and are skipped). */
  seenSeq: number;
  usage?: CanonicalUsage;
  error?: string;
};

export function emptyState(): FoldState {
  return { blocks: [], byId: {}, seenSeq: -1 };
}

/** Clone just enough to apply one event immutably (new state ref). */
function cloneState(s: FoldState): FoldState {
  return { blocks: s.blocks.slice(), byId: { ...s.byId }, seenSeq: s.seenSeq, usage: s.usage, error: s.error };
}

function getBlock<T extends Block>(s: FoldState, id: string): T | undefined {
  const i = s.byId[id];
  return i === undefined ? undefined : (s.blocks[i] as T);
}

/** Replace the block at id with a patched copy (immutable). */
function setBlock(s: FoldState, id: string, block: Block): void {
  const i = s.byId[id];
  if (i === undefined) {
    s.byId[id] = s.blocks.length;
    s.blocks.push(block);
  } else {
    s.blocks[i] = block;
  }
}

/** Apply one event. Returns the SAME state ref when the event is a
 *  duplicate/out-of-window (idempotent), else a new state ref. */
export function foldEvent(state: FoldState, e: CanonicalEvent): FoldState {
  if (e.seq <= state.seenSeq) return state; // already incorporated → idempotent
  const s = cloneState(state);
  s.seenSeq = e.seq;

  switch (e.kind) {
    case "reasoning-start": {
      if (!getBlock(s, e.id)) setBlock(s, e.id, { kind: "reasoning", id: e.id, order: e.seq, text: "", withheld: false, done: false });
      break;
    }
    case "reasoning-delta": {
      const b = getBlock<ReasoningBlock>(s, e.id) ?? { kind: "reasoning", id: e.id, order: e.seq, text: "", withheld: false, done: false };
      setBlock(s, e.id, { ...b, text: b.text + e.chunk });
      break;
    }
    case "reasoning-end": {
      const b = getBlock<ReasoningBlock>(s, e.id);
      if (b) setBlock(s, e.id, { ...b, done: true });
      break;
    }
    case "reasoning-meta": {
      const b = getBlock<ReasoningBlock>(s, e.id) ?? { kind: "reasoning", id: e.id, order: e.seq, text: "", withheld: false, done: true };
      setBlock(s, e.id, { ...b, tokens: e.tokens ?? b.tokens, withheld: e.withheld ?? b.withheld });
      break;
    }
    case "text-start": {
      if (!getBlock(s, e.id)) setBlock(s, e.id, { kind: "text", id: e.id, order: e.seq, text: "", done: false });
      break;
    }
    case "text-delta": {
      const b = getBlock<TextBlock>(s, e.id) ?? { kind: "text", id: e.id, order: e.seq, text: "", done: false };
      setBlock(s, e.id, { ...b, text: b.text + e.chunk });
      break;
    }
    case "text-end": {
      const b = getBlock<TextBlock>(s, e.id);
      if (b) setBlock(s, e.id, { ...b, done: true });
      break;
    }
    case "tool": {
      if (!getBlock(s, e.id)) setBlock(s, e.id, { kind: "tool", id: e.id, order: e.seq, name: e.name, input: e.input, status: "running" });
      break;
    }
    case "tool-result": {
      const b = getBlock<ToolBlock>(s, e.id);
      if (b) setBlock(s, e.id, { ...b, result: e.content, isError: e.isError, status: e.isError ? "error" : "done" });
      break;
    }
    case "usage": {
      s.usage = { ...s.usage, ...e.usage };
      break;
    }
    case "error": {
      s.error = e.message;
      break;
    }
    case "status":
      break;
  }
  return s;
}

/** Fold a whole log into final state. Sorts by seq (stable) + dedups, so
 *  the result is independent of delivery order. This is the authoritative
 *  reducer used by replay + tests. */
export function reduce(events: readonly CanonicalEvent[]): FoldState {
  const ordered = events.slice().sort((a, b) => a.seq - b.seq);
  let s = emptyState();
  for (const e of ordered) s = foldEvent(s, e);
  return s;
}

export type RenderUnit =
  | { kind: "reasoning"; block: ReasoningBlock }
  | { kind: "tools"; blocks: ToolBlock[] }
  | { kind: "text"; block: TextBlock };

/** Project folded state into ordered render units: reasoning is its own
 *  (visible) capsule, contiguous tool calls collapse into one steps
 *  strip, each prose segment is its own bubble. Interleave preserved. */
export function project(state: FoldState): RenderUnit[] {
  const units: RenderUnit[] = [];
  let tools: ToolBlock[] = [];
  const flush = () => { if (tools.length) { units.push({ kind: "tools", blocks: tools }); tools = []; } };
  for (const b of state.blocks) {
    if (b.kind === "tool") { tools.push(b); continue; }
    flush();
    units.push(b.kind === "reasoning" ? { kind: "reasoning", block: b } : { kind: "text", block: b });
  }
  flush();
  return units;
}
