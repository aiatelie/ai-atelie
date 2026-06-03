/* streamParser.test.ts — codex exec --json → AgentEvent mapping.
 *
 * Canned JSONL only (no CLI / no auth needed). Documents the expected
 * exec-JSON schema; re-confirm the success-path item shapes against a
 * live `codex exec --json` capture once `codex login` is restored. */

import { test, expect } from "bun:test";
import { createCodexStreamParser } from "./streamParser.ts";
import type { AgentEvent } from "../../services/types.ts";

function run(lines: string[]): { events: AgentEvent[]; errors: string[]; sessionId: string | null } {
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  let sessionId: string | null = null;
  const parser = createCodexStreamParser({
    onAgent: (e) => events.push(e),
    onError: (m) => errors.push(m),
    onSessionId: (s) => { sessionId = s; },
  });
  for (const l of lines) parser.feed(l + "\n");
  parser.flush();
  return { events, errors, sessionId };
}

test("captures thread_id from thread.started", () => {
  const { sessionId } = run([JSON.stringify({ type: "thread.started", thread_id: "abc-123" })]);
  expect(sessionId).toBe("abc-123");
});

test("agent_message → text event", () => {
  const { events } = run([
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }),
  ]);
  expect(events).toEqual([{ type: "text", chunk: "hello" }]);
});

test("reasoning → thinking event", () => {
  const { events } = run([
    JSON.stringify({ type: "item.completed", item: { item_type: "reasoning", text: "pondering" } }),
  ]);
  expect(events).toEqual([{ type: "thinking", chunk: "pondering" }]);
});

test("command_execution → tool + toolResult with error flag", () => {
  const { events } = run([
    JSON.stringify({
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: ["ls", "-a"], aggregated_output: "boom", exit_code: 2 },
    }),
  ]);
  expect(events).toEqual([
    { type: "tool", tool: { id: "c1", name: "command", input: { command: "ls -a" } } },
    { type: "toolResult", id: "c1", content: "boom", isError: true },
  ]);
});

test("turn.completed → usage event", () => {
  const { events } = run([
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 3 } }),
  ]);
  expect(events).toEqual([
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3 } },
  ]);
});

test("error and turn.failed surface via onError", () => {
  const a = run([JSON.stringify({ type: "error", message: "revoked" })]);
  expect(a.errors).toEqual(["revoked"]);
  const b = run([JSON.stringify({ type: "turn.failed", error: { message: "nope" } })]);
  expect(b.errors).toEqual(["nope"]);
});

test("unwraps double-encoded API errors and dedupes error+turn.failed", () => {
  // Real codex shape: `message` is a JSON string whose .error.message is
  // the human text, and BOTH error + turn.failed fire for one failure.
  const payload = JSON.stringify({
    type: "error", status: 400,
    error: { type: "invalid_request_error", message: "The 'gpt-5-codex' model is not supported." },
  });
  const { errors } = run([
    JSON.stringify({ type: "error", message: payload }),
    JSON.stringify({ type: "turn.failed", error: { message: payload } }),
  ]);
  expect(errors).toEqual(["The 'gpt-5-codex' model is not supported."]);
});

test("non-JSON log lines and unknown events are ignored", () => {
  const { events, errors } = run([
    "2026-06-01T12:00:00Z ERROR some::module: a log line",
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.started", item: { type: "agent_message", text: "partial" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
  ]);
  // item.started must NOT emit (only item.completed does) → single text.
  expect(events).toEqual([{ type: "text", chunk: "final" }]);
  expect(errors).toEqual([]);
});
