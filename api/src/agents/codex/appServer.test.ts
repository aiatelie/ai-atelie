/* appServer.test.ts — codex app-server notification → AgentEvent mapping.
 * Fixtures are real notification shapes captured from a live app-server. */

import { test, expect } from "bun:test";
import { mapAppServerNotification } from "./appServer.ts";

test("reasoning summary deltas → thinking (the whole point)", () => {
  expect(mapAppServerNotification("item/reasoning/summaryTextDelta", {
    itemId: "rs_1", delta: "**Clarifying request** I", summaryIndex: 0,
  })).toEqual([{ type: "thinking", chunk: "**Clarifying request** I" }]);
  expect(mapAppServerNotification("item/reasoning/textDelta", { itemId: "rs_1", delta: " more" }))
    .toEqual([{ type: "thinking", chunk: " more" }]);
});

test("agentMessage deltas → text", () => {
  expect(mapAppServerNotification("item/agentMessage/delta", { itemId: "m1", delta: "Hello" }))
    .toEqual([{ type: "text", chunk: "Hello" }]);
});

test("commandExecution item → tool then toolResult (error on non-zero exit)", () => {
  expect(mapAppServerNotification("item/started", {
    item: { type: "commandExecution", id: "c1", command: "ls -a", status: "inProgress" },
  })).toEqual([{ type: "tool", tool: { id: "c1", name: "command", input: { command: "ls -a" } } }]);

  expect(mapAppServerNotification("item/completed", {
    item: { type: "commandExecution", id: "c1", aggregatedOutput: "boom", exitCode: 2, status: "failed" },
  })).toEqual([{ type: "toolResult", id: "c1", content: "boom", isError: true }]);

  expect(mapAppServerNotification("item/completed", {
    item: { type: "commandExecution", id: "c2", aggregatedOutput: "ok", exitCode: 0, status: "completed" },
  })).toEqual([{ type: "toolResult", id: "c2", content: "ok", isError: false }]);
});

test("fileChange + mcpToolCall items map to tool/result", () => {
  expect(mapAppServerNotification("item/started", { item: { type: "fileChange", id: "f1", changes: { a: 1 } } }))
    .toEqual([{ type: "tool", tool: { id: "f1", name: "apply_patch", input: { changes: { a: 1 } } } }]);
  expect(mapAppServerNotification("item/started", { item: { type: "mcpToolCall", id: "x1", server: "starters", tool: "list" } }))
    .toEqual([{ type: "tool", tool: { id: "x1", name: "starters/list" } }]);
});

test("agentMessage item/completed → finalText (deduped downstream)", () => {
  expect(mapAppServerNotification("item/completed", { item: { type: "agentMessage", id: "m1", text: "final answer" } }))
    .toEqual([{ type: "finalText", chunk: "final answer" }]);
});

test("token usage → usage with reasoning tokens (camel or snake)", () => {
  const camel = mapAppServerNotification("thread/tokenUsage/updated", {
    tokenUsage: { last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 90, reasoningOutputTokens: 50 } },
  });
  expect(camel).toEqual([{ type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 90, reasoningTokens: 50 } }]);
  const snake = mapAppServerNotification("thread/tokenUsage/updated", {
    tokenUsage: { last: { input_tokens: 5, output_tokens: 6, reasoning_output_tokens: 7 } },
  });
  expect((snake[0] as { usage: { reasoningTokens?: number } }).usage.reasoningTokens).toBe(7);
});

test("unknown / lifecycle-only notifications produce nothing", () => {
  expect(mapAppServerNotification("turn/started", {})).toEqual([]);
  expect(mapAppServerNotification("item/started", { item: { type: "userMessage", id: "u1" } })).toEqual([]);
  expect(mapAppServerNotification("item/reasoning/summaryPartAdded", { itemId: "r", summaryIndex: 0 })).toEqual([]);
});
