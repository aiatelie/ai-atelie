/* canonicalEvents.test.ts — the faithfulness contract (Phase 0).
 *
 * These 8 invariants are what make "live == persisted == replayed ==
 * reconnected" mechanically true. They gate every later phase; if any
 * regress, the transcript can drift again (the "9 tools / 6 entries"
 * class of bug). Pure fold/project — no adapters, no I/O. */

import { test, expect } from "bun:test";
import {
  type CanonicalEvent,
  reduce,
  foldEvent,
  project,
  emptyState,
  type ReasoningBlock,
  type ToolBlock,
  type TextBlock,
} from "./canonicalEvents.ts";

/** Stamp a list of partial events with sequential seq (delivery order).
 *  `WithoutSeq` distributes Omit over the union so each member keeps its
 *  own fields (id/chunk/…) — a plain Omit<Union,"seq"> would collapse to
 *  the common keys only. */
type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
function L(parts: Array<WithoutSeq<CanonicalEvent>>): CanonicalEvent[] {
  return parts.map((p, i) => ({ ...p, seq: i }) as CanonicalEvent);
}

/** A representative interleaved turn: reason → tool → text → tool → text. */
const TURN = L([
  { kind: "reasoning-start", id: "r1" },
  { kind: "reasoning-delta", id: "r1", chunk: "Let me " },
  { kind: "reasoning-delta", id: "r1", chunk: "look." },
  { kind: "reasoning-end", id: "r1" },
  { kind: "tool", id: "t1", name: "Read", input: { file: "index.html" } },
  { kind: "tool-result", id: "t1", content: "<html>", isError: false },
  { kind: "text-start", id: "x1" },
  { kind: "text-delta", id: "x1", chunk: "Investigating" },
  { kind: "text-delta", id: "x1", chunk: " the layout." },
  { kind: "text-end", id: "x1" },
  { kind: "tool", id: "t2", name: "Edit", input: { file: "index.html" } },
  { kind: "tool-result", id: "t2", content: "ok" },
  { kind: "text-delta", id: "x2", chunk: "Done." },
  { kind: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
]);

test("I1 — order by seq: reduce is independent of delivery order", () => {
  const shuffled = [...TURN].reverse();
  expect(reduce(shuffled)).toEqual(reduce(TURN));
  // blocks materialize in seq order
  expect(reduce(TURN).blocks.map((b) => b.id)).toEqual(["r1", "t1", "x1", "t2", "x2"]);
});

test("I2 — dedup idempotent: re-delivered events don't double-apply", () => {
  expect(reduce([...TURN, ...TURN])).toEqual(reduce(TURN));
  // foldEvent returns the SAME ref when the event was already seen
  let s = emptyState();
  s = foldEvent(s, TURN[0]);
  const again = foldEvent(s, TURN[0]);
  expect(again).toBe(s);
  // coalescing: repeated deltas on one id concatenate (not split)
  const x1 = reduce(TURN).blocks.find((b) => b.id === "x1") as TextBlock;
  expect(x1.text).toBe("Investigating the layout.");
});

test("I3 — tool↔result pairing by id (not by order)", () => {
  // results arrive out of order relative to calls; pairing is by id
  const evs = L([
    { kind: "tool", id: "a", name: "Read" },
    { kind: "tool", id: "b", name: "Edit" },
    { kind: "tool-result", id: "b", content: "B", isError: true },
    { kind: "tool-result", id: "a", content: "A" },
  ]);
  const st = reduce(evs);
  const a = st.blocks.find((b) => b.id === "a") as ToolBlock;
  const b = st.blocks.find((b) => b.id === "b") as ToolBlock;
  expect(a.result).toBe("A");
  expect(a.status).toBe("done");
  expect(b.result).toBe("B");
  expect(b.status).toBe("error");
});

test("I4 — reasoning bytes only in reasoning blocks", () => {
  const st = reduce(TURN);
  const r = st.blocks.find((b) => b.kind === "reasoning") as ReasoningBlock;
  const texts = st.blocks.filter((b) => b.kind === "text") as TextBlock[];
  expect(r.text).toBe("Let me look.");
  expect(texts.map((t) => t.text)).toEqual(["Investigating the layout.", "Done."]);
  // no reasoning text leaked into any text block and vice-versa
  expect(texts.some((t) => t.text.includes("Let me"))).toBe(false);
  expect(r.text.includes("Investigating")).toBe(false);
});

test("I5 — reduce equivalence: all-at-once == one-by-one == two halves", () => {
  const all = reduce(TURN);
  let inc = emptyState();
  for (const e of TURN) inc = foldEvent(inc, e);
  expect(inc).toEqual(all);
  const k = Math.floor(TURN.length / 2);
  let halves = emptyState();
  for (const e of TURN.slice(0, k)) halves = foldEvent(halves, e);
  for (const e of TURN.slice(k)) halves = foldEvent(halves, e);
  expect(halves).toEqual(all);
});

test("I6 — reconnect continuous: prefix + overlapping replay == whole", () => {
  const k = 7;
  let s = emptyState();
  for (const e of TURN.slice(0, k)) s = foldEvent(s, e);
  // reconnect replays an OVERLAP (re-sends already-seen events) then the rest
  for (const e of TURN.slice(k - 3)) s = foldEvent(s, e);
  expect(s).toEqual(reduce(TURN));
});

test("I7 — reasoning never silently empty when the model reasoned", () => {
  // codex agentic turn: reasoned (tokens>0) but text withheld by provider
  const evs = L([
    { kind: "reasoning-meta", id: "r1", tokens: 148, withheld: true },
    { kind: "tool", id: "t1", name: "apply_patch" },
    { kind: "tool-result", id: "t1", content: "ok" },
    { kind: "text-delta", id: "x1", chunk: "Edited." },
  ]);
  const r = reduce(evs).blocks.find((b) => b.kind === "reasoning") as ReasoningBlock;
  expect(r).toBeTruthy();
  expect(r.withheld).toBe(true);
  expect(r.tokens).toBe(148);
});

test("I8 — interleave preserved through projection", () => {
  const units = project(reduce(TURN));
  expect(units.map((u) => u.kind)).toEqual(["reasoning", "tools", "text", "tools", "text"]);
  // the tools unit groups contiguous calls; here each is a single call
  const firstTools = units[1] as { kind: "tools"; blocks: ToolBlock[] };
  expect(firstTools.blocks.map((b) => b.name)).toEqual(["Read"]);
});

test("projection groups CONTIGUOUS tools into one strip", () => {
  const evs = L([
    { kind: "tool", id: "a", name: "Read" },
    { kind: "tool", id: "b", name: "Grep" },
    { kind: "tool", id: "c", name: "Edit" },
    { kind: "text-delta", id: "x", chunk: "done" },
  ]);
  const units = project(reduce(evs));
  expect(units.map((u) => u.kind)).toEqual(["tools", "text"]);
  expect((units[0] as { blocks: ToolBlock[] }).blocks.length).toBe(3);
});
