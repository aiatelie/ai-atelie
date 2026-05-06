/* elicitBus.ts — in-memory bridge between an MCP elicitation request and
 * the editor's chat sidebar response.
 *
 * Flow:
 *   1. Claude calls `ask_user` (an MCP tool).
 *   2. The MCP server emits `elicitation/create` to the SDK host.
 *   3. The SDK's `onElicitation` callback (in commentEdit.ts) calls
 *      `createPending(streamId)` to get an id + promise, emits an SSE
 *      `elicit` event with that id + the schema, and awaits the promise.
 *   4. The editor renders the form, the user submits, and the editor
 *      POSTs `/api/elicit-response { id, action, content }`.
 *   5. That handler calls `resolvePending(id, ...)`, which resolves the
 *      promise from step 3, which becomes the elicitation reply, which
 *      the MCP server returns as the tool result.
 *
 * Lives at module scope so a single Vite dev server instance can route
 * many concurrent elicitations across many chat threads.
 *
 * Per-stream tagging is the key to multi-tab safety: when a client
 * disconnects we MUST only cancel the pendings tied to *that* stream,
 * not every elicitation across every project. A global cancel was the
 * cause of "Claude made 8 ask_user calls but no form ever showed" —
 * any unrelated tab refresh blew away every in-flight form by
 * resolving its promise with `cancel`, which the model interpreted as
 * the user skipping the question and immediately asked the next.
 */

import { randomUUID } from "node:crypto";

export type ElicitAction = "accept" | "decline" | "cancel";
export type ElicitResponse = {
  action: ElicitAction;
  content?: Record<string, unknown>;
};

type Entry = {
  resolver: (response: ElicitResponse) => void;
  /** Identifies the originating /api/comment-edit stream so we can
   *  cancel only this stream's pendings on disconnect, not every other
   *  tab/project's. Undefined for legacy callers (won't be cancelled
   *  by the per-stream path — they just hang until resolved or process
   *  exit; same as the old global behaviour for that subset). */
  streamId?: string;
};
const pending = new Map<string, Entry>();

/** Per-stream SSE emitter registry. Used by the kimi HTTP-bridge MCP
 *  server (`mcp/ask-user-http-server.mjs`) which can't reach the SDK's
 *  onElicitation callback the way Claude can: it POSTs to the dev
 *  server, which looks up the active stream's emitter here, dispatches
 *  the SSE `elicit` event, and awaits the matching `/api/elicit-response`
 *  via the same {@link createPending} bus. Both providers share the same
 *  resolution path; only the *send* side differs. */
type StreamEmitter = (event: string, data: unknown) => void;
const streamEmitters = new Map<string, StreamEmitter>();

export function registerStreamEmitter(streamId: string, emit: StreamEmitter): void {
  streamEmitters.set(streamId, emit);
}

export function unregisterStreamEmitter(streamId: string): void {
  streamEmitters.delete(streamId);
}

/** Schema shape forwarded to the editor's ElicitForm. Mirrors the fields
 *  the Claude `onElicitation` callback emits today, so the frontend can
 *  treat both sources identically. */
export type ElicitDispatchRequest = {
  message: string;
  schema: Record<string, unknown>;
  serverName?: string;
  mode?: string;
  title?: string;
  displayName?: string;
  description?: string;
};

/** Dispatch an elicitation onto a registered stream and await the user's
 *  response. Returns null if no emitter is registered for that streamId
 *  (e.g. the run already ended or the stream id is bogus) — the MCP
 *  server can surface that as a tool error. */
export async function dispatchElicit(
  streamId: string,
  req: ElicitDispatchRequest,
): Promise<ElicitResponse | null> {
  const emit = streamEmitters.get(streamId);
  if (!emit) return null;
  const { id, promise } = createPending(streamId);
  emit("elicit", {
    id,
    serverName: req.serverName ?? "ask-user",
    message: req.message,
    mode: req.mode,
    schema: req.schema,
    title: req.title,
    displayName: req.displayName,
    description: req.description,
  });
  return promise;
}

export function createPending(streamId?: string): { id: string; promise: Promise<ElicitResponse> } {
  const id = randomUUID();
  let resolver!: Entry["resolver"];
  const promise = new Promise<ElicitResponse>((resolve) => {
    resolver = resolve;
  });
  pending.set(id, { resolver, streamId });
  return { id, promise };
}

/** Returns true if a pending request matched and was resolved. */
export function resolvePending(id: string, response: ElicitResponse): boolean {
  const e = pending.get(id);
  if (!e) return false;
  pending.delete(id);
  e.resolver(response);
  return true;
}

/** Cancel pendings owned by a single stream — used when its client
 *  disconnects. Returns the cancelled ids so the caller can fire
 *  matching `elicitClear` SSE events (best-effort: the socket may
 *  already be gone by then, but other consumers of the bus could
 *  still want to know). */
export function cancelPendingForStream(
  streamId: string,
  reason = "stream-aborted",
): string[] {
  const ids: string[] = [];
  for (const [id, entry] of pending) {
    if (entry.streamId !== streamId) continue;
    pending.delete(id);
    ids.push(id);
    entry.resolver({ action: "cancel", content: { _reason: reason } });
  }
  return ids;
}

/** Cancel every pending. Reserved for full-process teardown (Vite
 *  shutdown). DO NOT call from per-request abort paths — that's the
 *  bug we fixed: an unrelated tab close would cancel forms in every
 *  open chat. Use {@link cancelPendingForStream} instead. */
export function cancelAllPending(reason = "process-shutdown"): void {
  for (const [id, entry] of pending) {
    entry.resolver({ action: "cancel", content: { _reason: reason } });
    pending.delete(id);
  }
}
