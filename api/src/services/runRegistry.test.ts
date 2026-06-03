/* runRegistry.test.ts — replay-buffer eviction policy.
 *
 * Phase 5 invariant: under memory pressure the ring evicts recoverable
 * INTERIOR content (legacy `agent` text, canonical text-/reasoning-delta)
 * but NEVER a structural envelope (tool / tool-result / block start-end /
 * reasoning-meta). A resumed client re-folds the surviving log; if a tool
 * envelope or a block boundary were dropped, the projection would show an
 * orphan chip or lose a whole block — diverging from the live render.
 *
 * Run via `bun test src/services/runRegistry.test.ts`.
 */

import { test, expect, beforeEach } from "bun:test";
import {
  activeRuns,
  appendBufferedEvent,
  replaySince,
  freshRunCore,
  RING_MAX_BYTES,
} from "./runRegistry.ts";

const SID = "s-test-eviction";

beforeEach(() => {
  // Fresh run each test; AbortController is required by the type.
  activeRuns.set(SID, { ...freshRunCore(), startedAt: 0, abort: new AbortController() });
});

function canon(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

test("eviction drops canon deltas but keeps tool/block-boundary/meta envelopes", () => {
  // Structural envelopes we expect to survive, interleaved with big deltas.
  appendBufferedEvent(SID, "canon", canon({ kind: "reasoning-start", seq: 0, id: "r1" }));
  appendBufferedEvent(SID, "canon", canon({ kind: "tool", seq: 1, id: "t1", name: "Read" }));
  appendBufferedEvent(SID, "canon", canon({ kind: "tool-result", seq: 2, id: "t1", content: "ok" }));
  appendBufferedEvent(SID, "canon", canon({ kind: "reasoning-meta", seq: 3, id: "r1", tokens: 99, withheld: true }));

  // Now flood with big interior deltas (~16KB each) to blow past RING_MAX_BYTES.
  const big = "x".repeat(16 * 1024);
  const deltaCount = Math.ceil((RING_MAX_BYTES / big.length) * 2) + 8; // comfortably over budget
  for (let i = 0; i < deltaCount; i++) {
    appendBufferedEvent(SID, "canon", canon({ kind: "text-delta", seq: 100 + i, id: "x1", chunk: big }));
  }
  // A final structural boundary after the flood.
  appendBufferedEvent(SID, "canon", canon({ kind: "text-end", seq: 9999, id: "x1" }));

  const run = activeRuns.get(SID)!;
  expect(run.bufferBytes).toBeLessThanOrEqual(RING_MAX_BYTES);

  const kinds = run.buffer.map((e) => JSON.parse(e.data).kind as string);
  // Every structural envelope survived eviction…
  for (const k of ["reasoning-start", "tool", "tool-result", "reasoning-meta", "text-end"]) {
    expect(kinds).toContain(k);
  }
  // …while interior deltas were the ones thrown overboard.
  const survivingDeltas = kinds.filter((k) => k === "text-delta").length;
  expect(survivingDeltas).toBeLessThan(deltaCount);
});

test("legacy `agent` text is still evictable; finalText envelope is preserved", () => {
  appendBufferedEvent(SID, "agent", canon({ type: "tool", tool: { id: "t1", name: "Edit" } }));
  const big = "y".repeat(16 * 1024);
  const n = Math.ceil((RING_MAX_BYTES / big.length) * 2) + 8;
  for (let i = 0; i < n; i++) appendBufferedEvent(SID, "agent", canon({ type: "text", chunk: big }));
  appendBufferedEvent(SID, "agent", canon({ type: "finalText", chunk: "the whole answer" }));

  const run = activeRuns.get(SID)!;
  expect(run.bufferBytes).toBeLessThanOrEqual(RING_MAX_BYTES);
  const datas = run.buffer.map((e) => e.data);
  expect(datas.some((d) => /"type":"tool"/.test(d))).toBe(true);       // envelope kept
  expect(datas.some((d) => /"type":"finalText"/.test(d))).toBe(true);  // recovery kept
  expect(datas.filter((d) => /"type":"text"/.test(d) && !/finalText/.test(d)).length).toBeLessThan(n);
});

test("replaySince returns a foldable suffix even after a mid-stream eviction", () => {
  appendBufferedEvent(SID, "canon", canon({ kind: "tool", seq: 0, id: "t1", name: "Read" }));
  const big = "z".repeat(16 * 1024);
  const n = Math.ceil((RING_MAX_BYTES / big.length) * 2) + 8;
  for (let i = 0; i < n; i++) appendBufferedEvent(SID, "canon", canon({ kind: "text-delta", seq: 1 + i, id: "x1", chunk: big }));
  appendBufferedEvent(SID, "canon", canon({ kind: "tool-result", seq: 5000, id: "t1", content: "done" }));

  // A reconnect from index 0 still gets the surviving (gap-bearing but
  // structurally complete) log; the client's reduce() tolerates the gap.
  const replayed = replaySince(SID, 0);
  const kinds = replayed.map((e) => JSON.parse(e.data).kind as string);
  expect(kinds).toContain("tool");
  expect(kinds).toContain("tool-result");
});
