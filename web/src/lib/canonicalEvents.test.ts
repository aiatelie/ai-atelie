/* canonicalEvents.test.ts — web mirror of the api invariant suite.
 *
 * This module is hand-mirrored from api/src/services/canonicalEvents.ts;
 * these tests guard that the browser-side fold/project agrees with the
 * server (the api side has the full I1–I8 corpus). We assert the
 * invariants the frontend depends on directly: order-by-seq, idempotent
 * dedup, tool↔result pairing, reasoning-bytes-only, interleave-preserved,
 * and reduce-equivalence regardless of arrival order.
 *
 * Run via `bun test src/lib/canonicalEvents.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { reduce, project, foldEvent, emptyState, type CanonicalEvent } from "./canonicalEvents";

/** A CanonicalEvent without seq — so fixtures read as an ordered list and
 *  we stamp seq from the index (matches how the server stamps). */
type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
function L(parts: Array<WithoutSeq<CanonicalEvent>>): CanonicalEvent[] {
  return parts.map((p, i) => ({ ...p, seq: i }) as CanonicalEvent);
}

describe("reduce — block construction", () => {
  test("I3 tool↔result pair by id; status flips on result", () => {
    const log = L([
      { kind: "tool", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
      { kind: "tool-result", id: "t1", content: "ok" },
    ]);
    const tool = reduce(log).blocks[0];
    expect(tool).toMatchObject({ kind: "tool", id: "t1", name: "Read", result: "ok", status: "done" });
  });

  test("tool-result with isError flips status to error", () => {
    const log = L([
      { kind: "tool", id: "t1", name: "Bash" },
      { kind: "tool-result", id: "t1", content: "boom", isError: true },
    ]);
    expect(reduce(log).blocks[0]).toMatchObject({ status: "error", isError: true, result: "boom" });
  });

  test("I4 reasoning bytes accumulate only in the reasoning block", () => {
    const log = L([
      { kind: "reasoning-start", id: "r1" },
      { kind: "reasoning-delta", id: "r1", chunk: "think " },
      { kind: "reasoning-delta", id: "r1", chunk: "more" },
      { kind: "reasoning-end", id: "r1" },
      { kind: "text-start", id: "x1" },
      { kind: "text-delta", id: "x1", chunk: "answer" },
      { kind: "text-end", id: "x1" },
    ]);
    const blocks = reduce(log).blocks;
    expect(blocks[0]).toMatchObject({ kind: "reasoning", text: "think more", done: true });
    expect(blocks[1]).toMatchObject({ kind: "text", text: "answer", done: true });
  });

  test("reasoning-meta marks a withheld block without text", () => {
    const log = L([{ kind: "reasoning-meta", id: "r1", tokens: 512, withheld: true }]);
    expect(reduce(log).blocks[0]).toMatchObject({ kind: "reasoning", text: "", withheld: true, tokens: 512 });
  });
});

describe("foldEvent — idempotency", () => {
  test("I2 re-applying an already-seen seq is a no-op (same ref)", () => {
    const e: CanonicalEvent = { kind: "text-delta", id: "x", chunk: "a", seq: 5 };
    const s1 = foldEvent(emptyState(), e);
    const s2 = foldEvent(s1, e); // duplicate
    expect(s2).toBe(s1); // identical ref → idempotent
  });

  test("out-of-window (seq <= seenSeq) deltas are dropped", () => {
    const log = L([
      { kind: "text-start", id: "x" },
      { kind: "text-delta", id: "x", chunk: "hello" },
    ]);
    let s = reduce(log);
    // Replay an earlier-seq delta (overlap from a reconnect) — must not double-append.
    s = foldEvent(s, { kind: "text-delta", id: "x", chunk: "hello", seq: 1 });
    expect((s.blocks[0] as { text: string }).text).toBe("hello");
  });
});

describe("reduce — order independence (I1 + I5)", () => {
  test("shuffled delivery folds to the same state as in-order", () => {
    const log = L([
      { kind: "reasoning-start", id: "r" },
      { kind: "reasoning-delta", id: "r", chunk: "X" },
      { kind: "tool", id: "t", name: "Edit" },
      { kind: "tool-result", id: "t", content: "done" },
      { kind: "text-delta", id: "x", chunk: "hi" },
    ]);
    const shuffled = [log[3], log[0], log[4], log[2], log[1]];
    expect(reduce(shuffled)).toEqual(reduce(log));
  });
});

describe("project — render units (I8 interleave)", () => {
  test("think → act → answer → act → answer preserves order; tools collapse contiguously", () => {
    const log = L([
      { kind: "reasoning-delta", id: "r", chunk: "plan" },
      { kind: "tool", id: "t1", name: "Read" },
      { kind: "tool", id: "t2", name: "Edit" },
      { kind: "text-delta", id: "x1", chunk: "first" },
      { kind: "tool", id: "t3", name: "Bash" },
      { kind: "text-delta", id: "x2", chunk: "second" },
    ]);
    const units = project(reduce(log));
    expect(units.map((u) => u.kind)).toEqual(["reasoning", "tools", "text", "tools", "text"]);
    // The two contiguous tools collapse into one strip; the lone later tool is its own strip.
    expect((units[1] as { blocks: unknown[] }).blocks).toHaveLength(2);
    expect((units[3] as { blocks: unknown[] }).blocks).toHaveLength(1);
  });
});
