/* canonicalLog.test.ts — Phase 1: flat AgentEvent → canonical blocks.
 *
 * Validates the ONE place block boundaries are derived (the stateful
 * converter) against the Phase 0 fold/project. Pure in/out; the jsonl
 * side-effect writes to RUN_LOGS_DIR (tmp) and is harmless here. */

import { test, expect } from "bun:test";
import type { AgentEvent } from "./types.ts";
import { pushCanonical, finalizeCanonical, replayCanonical, disposeCanonical } from "./canonicalLog.ts";
import { reduce, project, type ReasoningBlock, type TextBlock, type ToolBlock } from "./canonicalEvents.ts";
import type { CanonicalEvent } from "./canonicalEvents.ts";

let n = 0;
function freshId(): string { return `s-${++n}-aaaa`; } // unique per test, isValid-ish

function runTurn(streamId: string, events: AgentEvent[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];
  for (const e of events) out.push(...pushCanonical(streamId, e));
  out.push(...finalizeCanonical(streamId));
  return out;
}

test("converts a flat interleaved turn into block-addressed canonical events", () => {
  const sid = freshId();
  const canon = runTurn(sid, [
    { type: "thinking", chunk: "Let me " },
    { type: "thinking", chunk: "look." },
    { type: "tool", tool: { id: "t1", name: "Read", input: { file: "index.html" } } },
    { type: "toolResult", id: "t1", content: "<html>", isError: false },
    { type: "text", chunk: "Investigating" },
    { type: "text", chunk: " the layout." },
    { type: "tool", tool: { id: "t2", name: "Edit", input: { file: "index.html" } } },
    { type: "toolResult", id: "t2", content: "ok" },
    { type: "text", chunk: "Done." },
    { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
  ]);

  // seq strictly monotonic
  expect(canon.map((e) => e.seq)).toEqual([...canon.keys()]);

  const st = reduce(canon);
  const r = st.blocks.find((b) => b.kind === "reasoning") as ReasoningBlock;
  expect(r.text).toBe("Let me look.");
  expect(r.done).toBe(true);
  const texts = st.blocks.filter((b) => b.kind === "text") as TextBlock[];
  expect(texts.map((t) => t.text)).toEqual(["Investigating the layout.", "Done."]);
  expect(texts.every((t) => t.done)).toBe(true); // finalize closes the trailing block
  const tools = st.blocks.filter((b) => b.kind === "tool") as ToolBlock[];
  expect(tools.map((t) => [t.name, t.result, t.status])).toEqual([
    ["Read", "<html>", "done"],
    ["Edit", "ok", "done"],
  ]);
  expect(st.usage?.inputTokens).toBe(100);

  // projection preserves interleave
  expect(project(st).map((u) => u.kind)).toEqual(["reasoning", "tools", "text", "tools", "text"]);
  disposeCanonical(sid);
});

test("finalText is dropped when deltas already streamed text", () => {
  const sid = freshId();
  const canon = runTurn(sid, [
    { type: "text", chunk: "hi" },
    { type: "finalText", chunk: "hi — full result that would duplicate" },
  ]);
  const texts = reduce(canon).blocks.filter((b) => b.kind === "text") as TextBlock[];
  expect(texts.length).toBe(1);
  expect(texts[0].text).toBe("hi");
  disposeCanonical(sid);
});

test("finalText with no prior deltas creates a single closed text block", () => {
  const sid = freshId();
  const canon = runTurn(sid, [{ type: "finalText", chunk: "the answer" }]);
  const texts = reduce(canon).blocks.filter((b) => b.kind === "text") as TextBlock[];
  expect(texts.length).toBe(1);
  expect(texts[0].text).toBe("the answer");
  expect(texts[0].done).toBe(true);
  disposeCanonical(sid);
});

test("tool ids: provider id is used; synthetic id minted when absent (e.g. kimi)", () => {
  const sid = freshId();
  const canon = runTurn(sid, [
    { type: "tool", tool: { id: "real-id", name: "Read" } },
    { type: "tool", tool: { name: "Grep" } }, // no id
  ]);
  const tools = reduce(canon).blocks.filter((b) => b.kind === "tool") as ToolBlock[];
  expect(tools[0].id).toBe("real-id");
  expect(tools[1].id).toMatch(new RegExp(`^${sid}:tool\\d+$`));
  disposeCanonical(sid);
});

test("I7: reasoning tokens spent but no summary streamed → withheld marker", () => {
  const sid = freshId();
  // Codex under the narration-heavy prompt: narrates in text, streams NO
  // reasoning summary, but the usage reports reasoning_output_tokens.
  const canon = runTurn(sid, [
    { type: "text", chunk: "Comparing the three layouts" },
    { type: "tool", tool: { id: "t1", name: "command", input: { command: "ls" } } },
    { type: "toolResult", id: "t1", content: "ok" },
    { type: "text", chunk: ". Recommend asymmetric." },
    { type: "usage", usage: { inputTokens: 100, outputTokens: 40, reasoningTokens: 512 } as never },
  ]);
  const st = reduce(canon);
  const r = st.blocks.find((b) => b.kind === "reasoning") as ReasoningBlock | undefined;
  expect(r, "a (withheld) reasoning block was synthesized").toBeTruthy();
  expect(r!.withheld).toBe(true);
  expect(r!.text).toBe("");
  expect(r!.tokens).toBe(512);
  disposeCanonical(sid);
});

test("withheld marker NOT emitted when reasoning was actually streamed", () => {
  const sid = freshId();
  const canon = runTurn(sid, [
    { type: "thinking", chunk: "weighing options" },
    { type: "text", chunk: "answer" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 999 } as never },
  ]);
  const reasoningBlocks = reduce(canon).blocks.filter((b) => b.kind === "reasoning") as ReasoningBlock[];
  expect(reasoningBlocks.length).toBe(1);
  expect(reasoningBlocks[0].withheld).toBe(false);
  expect(reasoningBlocks[0].text).toBe("weighing options");
  // no separate withheld marker
  expect(canon.filter((e) => e.kind === "reasoning-meta").length).toBe(0);
  disposeCanonical(sid);
});

test("withheld marker NOT emitted when no reasoning tokens were spent", () => {
  const sid = freshId();
  const canon = runTurn(sid, [
    { type: "text", chunk: "quick answer" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
  ]);
  expect(canon.filter((e) => e.kind === "reasoning-meta").length).toBe(0);
  disposeCanonical(sid);
});

test("replayCanonical returns the ring in seq order", () => {
  const sid = freshId();
  const produced = runTurn(sid, [
    { type: "thinking", chunk: "x" },
    { type: "text", chunk: "y" },
  ]);
  const replayed = replayCanonical(sid, 0);
  expect(replayed).toEqual(produced);
  // partial replay
  const fromMid = replayCanonical(sid, 2);
  expect(fromMid.every((e) => e.seq >= 2)).toBe(true);
  disposeCanonical(sid);
});
