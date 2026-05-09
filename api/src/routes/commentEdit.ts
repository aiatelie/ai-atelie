/* commentEdit.ts — POST /api/comment-edit (SSE) + POST /api/comment-undo.
 *
 * The frontend POSTs JSON: { route, selector, comment, screenshotDataUrl, … }.
 * We pick a provider based on `modelId` (claude or kimi), spawn the AI as
 * a subprocess via the appropriate driver, and stream every event back as
 * SSE. The 25s `:keepalive` heartbeat keeps the client-side stall watchdog
 * happy through long tool calls.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { pickAdapter } from "../agents/registry.ts";
import { applySnapshot, deleteSnapshot, diffSnapshot, getSnapshot, recordSnapshot } from "../services/snapshots.ts";
import {
  activeRuns,
  appendBufferedEvent,
  attachTailer,
  cancelGraceAbort,
  detachTailer,
  freshRunCore,
  GRACE_DISCONNECT_MS,
  markRunFinished,
  replaySince,
  scheduleGraceAbort,
} from "../services/runRegistry.ts";
import {
  cancelPendingForStream,
  registerStreamEmitter,
  unregisterStreamEmitter,
} from "../services/elicitBus.ts";
import { projectDirOf, internalBaseUrl } from "../services/projectStore.ts";
import { openRunLog } from "../services/runLogger.ts";
import type { CommentPayload } from "../services/types.ts";

/** Validate a client-provided streamId before we use it as a registry
 *  key (which becomes part of the run-log filename). Allows the
 *  `chatStream.newStreamId()` shape `s-<digits>-<alnum>` plus a UUID
 *  fallback. Anything else is rejected and we generate our own. */
function isSafeStreamId(s: unknown): s is string {
  return typeof s === "string"
    && (/^s-\d{10,16}-[a-z0-9]{4,12}$/.test(s)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s));
}

/** Hard wall-clock cap on a single AI turn. If we don't reach `done`
 *  within this window we abort and return a clear timeout error.
 *  10 min instead of 5: motion-design refactors that touch multiple
 *  files (RouteMap variants, design-canvas updates, etc.) legitimately
 *  exceed 5min on Claude Opus. The cap exists to catch wedged
 *  subprocesses, not to throttle thoughtful work. */
const RUN_MAX_DURATION_MS = 10 * 60 * 1000;

/** Reject request bodies larger than 10MB. The dominant payload component
 *  is the base64-encoded screenshotDataUrl; a 4K retina canvas produces
 *  ~2MB. 10MB gives headroom for multiple large image attachments. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function runAgent(
  payload: CommentPayload,
  send: (event: string, data: unknown) => void,
  abortSignal: AbortSignal,
  baseUrl: string,
  streamId: string,
): Promise<void> {
  const adapter = pickAdapter(payload.modelId);
  await adapter.run({ payload, send, abortSignal, baseUrl, streamId });
}

export const commentEditRoutes = new Hono();

commentEditRoutes.post("/api/comment-edit", async (c) => {
  // Reject oversized bodies before buffering them into memory.
  const cl = c.req.header("content-length");
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return c.json({ error: `Request body too large (max ${MAX_BODY_BYTES / 1024 / 1024}MB)` }, 413);
  }
  let payload: CommentPayload;
  try { payload = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  if (!payload.comment || !payload.route) {
    return c.text("Missing route or comment", 400);
  }

  const turnId = randomUUID();
  // Use the client-supplied streamId as the registry key when present
  // and well-formed, so the same key threads (a) the original POST,
  // (b) the elicit bus emitter, (c) the run log, and (d) any future
  // resume request via /api/comment-edit/replay/:streamId. A duplicate
  // POST on the same streamId — common if a panicky client retries — is
  // rejected with 409 to avoid double-billing the SDK turn.
  const clientStreamId = isSafeStreamId(payload.streamId) ? payload.streamId : null;
  const requestStreamId = clientStreamId ?? randomUUID();
  if (clientStreamId && activeRuns.has(clientStreamId)) {
    return c.json(
      { error: "stream-in-progress", streamId: clientStreamId },
      409,
    );
  }
  const startedAt = Date.now();
  const abortController = new AbortController();
  const baseUrl = internalBaseUrl();
  const requestId = c.get("requestId" as never) as string | undefined;
  const runLog = await openRunLog(requestStreamId);
  runLog.log(`turn=${turnId} reqId=${requestId ?? "-"} project=${payload.projectId ?? "-"} model=${payload.modelId ?? "(default)"} comment=${JSON.stringify(payload.comment).slice(0, 200)}`);

  // Snapshot the right scope before the agent runs so we can revert
  // this turn later. Sandbox projects snapshot their own files via the
  // storage driver; legacy snapshots LEGACY_EDITOR_ROOT/src directly.
  // Survives daemon restart because the snapshot lives on disk under
  // SHARED_ROOT/snapshot-<turnId>.json.
  let snapshotErr: string | null = null;
  try {
    if (payload.projectId && !projectDirOf(payload.projectId)) {
      throw new Error(`Invalid projectId: ${payload.projectId}`);
    }
    const entry = await recordSnapshot(turnId, payload.projectId ?? null);
    if (!entry) snapshotErr = "Snapshot failed: storage write returned no entry";
  } catch (err) {
    // Snapshot is best-effort; if it fails we just don't offer undo.
    snapshotErr = `Snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const provider = pickAdapter(payload.modelId).id;

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => {
      // Record the event in the registry's per-stream ring buffer so
      // a reloaded client can pick it up via the resume endpoint, then
      // write it on the wire. The eventIndex is sent as the SSE `id:`
      // field — clients track it and resume with `?fromIndex=lastSeen+1`.
      const json = JSON.stringify(data);
      const idx = appendBufferedEvent(requestStreamId, event, json);
      stream
        .writeSSE(idx == null ? { event, data: json } : { event, data: json, id: String(idx) })
        .catch(() => { /* aborted */ });
      // Mirror to the per-stream log so a hung turn leaves a tail-able
      // trace. Truncate big payloads (kimi can emit multi-KB blobs).
      try {
        runLog.log(`sse event=${event} data=${json.length > 600 ? json.slice(0, 600) + "…(+" + (json.length - 600) + ")" : json}`);
      } catch { /* unstringifiable; skip */ }
    };

    // Keepalive: prevent the client's 90s no-event watchdog from declaring
    // the stream dead during long tool calls. SSE comments (`:keepalive`)
    // are valid per spec and the parser ignores them — they exist only to
    // keep bytes flowing on the wire.
    let heartbeatActive = true;
    const heartbeat = (async () => {
      while (heartbeatActive && !stream.aborted) {
        await stream.sleep(25_000);
        if (!heartbeatActive || stream.aborted) break;
        try { await stream.write(":keepalive\n\n"); } catch { break; }
      }
    })();

    // Forward client-disconnect (Stop button, navigated away, etc.) into
    // the agent so the AI subprocess stops cleanly + any pending
    // elicitation is cancelled instead of hanging forever.
    //
    // We distinguish *who* aborted via `clientAborted`. When the client
    // dropped, the UI already shows "stopped" — we keep silence on the
    // wire. When the server aborted (timeout, SIGTERM/HMR via
    // runRegistry.abortAllRuns, etc.), the user has no idea anything
    // happened — we surface a clear error in the catch branch below.
    let agentDone = false;
    let clientAborted = false;
    /** Performs the actual SDK abort + elicit cleanup. Hoisted so the
     *  grace timer (and the explicit Stop endpoint via `bypassGrace`)
     *  can both invoke the same path. */
    const abortRunNow = (reason: string) => {
      if (!abortController.signal.aborted) {
        abortController.abort(reason);
        const cancelled = cancelPendingForStream(requestStreamId, reason);
        for (const id of cancelled) {
          try { send("elicitClear", { id, reason }); } catch { /* ignore */ }
        }
      }
    };
    stream.onAbort(() => {
      clientAborted = true;
      if (agentDone) return;
      // Don't abort yet — wait GRACE_DISCONNECT_MS for a resume request
      // to land. If a tailer attaches in time, the SDK keeps streaming
      // into the buffer and the new client picks it up via /replay.
      // If no client returns, the timer fires and aborts the SDK turn.
      // Bypassed instantly when the user explicitly pressed Stop (the
      // /abort/:streamId endpoint sets `bypassGrace = true`).
      scheduleGraceAbort(requestStreamId, GRACE_DISCONNECT_MS, () => {
        abortRunNow("client-aborted");
      });
    });

    // Helper: list files the model edited before getting cut off, so
    // our abort message can tell the user what landed (and surface
    // Undo). Returns an empty list on snapshot-missing or read errors.
    const editedFilesSummary = async (): Promise<string> => {
      const snap = await getSnapshot(turnId);
      if (!snap) return "";
      try {
        const { modified } = await diffSnapshot(snap);
        if (modified.length === 0) return "";
        const list = modified.length <= 4
          ? modified.join(", ")
          : `${modified.slice(0, 4).join(", ")} +${modified.length - 4}`;
        return ` Edits already on disk: ${list}. ↩ Undo reverts them.`;
      } catch {
        return "";
      }
    };

    // Hard timeout: wall-clock cap on a single turn (RUN_MAX_DURATION_MS).
    const timeoutTimer = setTimeout(async () => {
      if (agentDone) return;
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.warn(`[comment-edit] timeout streamId=${requestStreamId.slice(0, 8)} elapsed=${elapsedSec}s — aborting`);
      const tail = await editedFilesSummary();
      try {
        send("error", {
          message: `Run exceeded ${Math.round(RUN_MAX_DURATION_MS / 1000 / 60)}min — backend aborted.${tail} Try again or simplify the request.`,
        });
      } catch { /* ignore */ }
      try { abortController.abort("timeout"); } catch { /* ignore */ }
      cancelPendingForStream(requestStreamId, "timeout");
    }, RUN_MAX_DURATION_MS);

    activeRuns.set(requestStreamId, {
      ...freshRunCore(),
      startedAt,
      projectId: payload.projectId,
      abort: abortController,
      logPath: runLog.path,
      requestId,
    });
    registerStreamEmitter(requestStreamId, send);
    console.log(`[comment-edit] ${requestId ?? ""} start streamId=${requestStreamId.slice(0, 8)} project=${payload.projectId ?? "-"} provider=${provider} log=${runLog.path}`);

    if (snapshotErr) send("error", { message: snapshotErr });
    send("status", { phase: "started", turnId, provider });

    try {
      await runAgent(payload, send, abortController.signal, baseUrl, requestStreamId);
      agentDone = true;
      // After the agent loop returns: if we were aborted server-side
      // (NOT a normal client disconnect), surface a clear error so the
      // user sees what happened instead of a misleading "Made N tool
      // calls" auto-summary. Include the file list of any edits that
      // landed before the abort, so the user knows the work isn't lost.
      if (abortController.signal.aborted && !clientAborted) {
        const reason = String(abortController.signal.reason ?? "");
        if (reason === "timeout") {
          // Already sent inside the timeout handler; nothing to add.
        } else {
          const tail = await editedFilesSummary();
          if (reason === "SIGTERM" || reason === "SIGINT" || reason === "hot-reload") {
            send("error", { message: `Run interrupted — backend restarted (${reason}).${tail} Hit Retry to resume.` });
          } else {
            send("error", { message: `Run aborted${reason ? ` (${reason})` : ""}.${tail}` });
          }
        }
      }
      send("status", { phase: "done", turnId });
      console.log(`[comment-edit] done streamId=${requestStreamId.slice(0, 8)} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s aborted=${abortController.signal.aborted} clientAborted=${clientAborted}`);
    } catch (err) {
      agentDone = true;
      if (clientAborted) {
        // Client gave up; UI already shows it.
      } else if (abortController.signal.aborted) {
        const reason = String(abortController.signal.reason ?? "");
        if (reason !== "timeout") {
          const tail = await editedFilesSummary();
          send("error", { message: `Run interrupted${reason ? ` (${reason})` : ""}.${tail} Hit Retry.` });
        }
      } else {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      }
      console.warn(`[comment-edit] error streamId=${requestStreamId.slice(0, 8)} aborted=${abortController.signal.aborted} clientAborted=${clientAborted} err=${err instanceof Error ? err.message : String(err)}`);
    } finally {
      agentDone = true;
      heartbeatActive = false;
      clearTimeout(timeoutTimer);
      // Defer activeRuns deletion via markRunFinished so the buffered
      // events stick around for BUFFER_GC_MS — covers the slow-reload
      // case where the user reloads AFTER the run completed but before
      // they could see the result.
      // When the client disconnected (grace timer fired), the abort was
      // triggered by us, not by a genuine failure. Classify as "done" so
      // the ring-buffer GC retains termination events for replay.
      const terminal: "done" | "error" =
        abortController.signal.aborted && !clientAborted ? "error" : "done";
      markRunFinished(requestStreamId, terminal);
      unregisterStreamEmitter(requestStreamId);
      try { await heartbeat; } catch { /* ignore */ }
      try { await runLog.flush(); } catch { /* ignore */ }
      runLog.close();
    }
  });
});

/** Resume an in-flight run from a reloaded tab. Replays buffered events
 *  with eventIndex >= fromIndex (default 0), then tails live until the
 *  run finishes or this client disconnects too. The original POST is
 *  NEVER re-issued from this path — that would double-bill the SDK. */
commentEditRoutes.get("/api/comment-edit/replay/:streamId", async (c) => {
  const streamId = c.req.param("streamId");
  if (!isSafeStreamId(streamId)) return c.text("bad streamId", 400);
  const fromIndex = Math.max(0, parseInt(c.req.query("fromIndex") ?? "0", 10) | 0);
  const run = activeRuns.get(streamId);
  if (!run) return c.text("not found", 404);

  // A resume client just landed; cancel any pending grace-abort.
  cancelGraceAbort(streamId);

  return streamSSE(c, async (stream) => {
    // 1. Flush whatever the buffer holds since fromIndex.
    for (const ev of replaySince(streamId, fromIndex)) {
      await stream
        .writeSSE({ event: ev.event, id: String(ev.eventIndex), data: ev.data })
        .catch(() => { /* socket gone */ });
    }
    // 2. If the run already finished, the buffer carries the terminal
    //    `status: done` event — nothing more to forward.
    if (run.finishedAt) return;

    // 3. Tail live: every appendBufferedEvent fans out to this tailer.
    const tailer = (ev: { eventIndex: number; event: string; data: string }) => {
      stream
        .writeSSE({ event: ev.event, id: String(ev.eventIndex), data: ev.data })
        .catch(() => { /* socket gone */ });
    };
    attachTailer(streamId, tailer);

    // Same heartbeat behavior as the primary endpoint so the resumed
    // client's stall watchdog stays satisfied during long tool calls.
    let alive = true;
    stream.onAbort(() => {
      alive = false;
      detachTailer(streamId, tailer);
      // No live consumers + run not finished → start the grace clock
      // again. The original SSE socket is already gone, so this client
      // dropping is "the user closed the tab". Schedule eventual abort.
      const r = activeRuns.get(streamId);
      if (r && !r.finishedAt && r.tailers.size === 0) {
        scheduleGraceAbort(streamId, GRACE_DISCONNECT_MS, () => {
          if (!r.abort.signal.aborted) r.abort.abort("client-aborted");
        });
      }
    });
    while (alive && !run.finishedAt) {
      await stream.sleep(25_000);
      if (!alive || run.finishedAt) break;
      try { await stream.write(":keepalive\n\n"); } catch { break; }
    }
  });
});

/** Explicit stop request from the client. Bypasses the grace window so
 *  the SDK aborts immediately when the user hits Stop (not when they
 *  navigate away — that path waits the full grace period). */
commentEditRoutes.post("/api/comment-edit/abort/:streamId", async (c) => {
  const streamId = c.req.param("streamId");
  if (!isSafeStreamId(streamId)) return c.text("bad streamId", 400);
  const run = activeRuns.get(streamId);
  if (!run) return c.json({ ok: false, reason: "not-found" }, 404);
  run.bypassGrace = true;
  if (run.graceTimer) { clearTimeout(run.graceTimer); run.graceTimer = undefined; }
  if (!run.abort.signal.aborted) {
    try { run.abort.abort("user-stop"); } catch { /* ignore */ }
    cancelPendingForStream(streamId, "user-stop");
  }
  return c.json({ ok: true });
});

commentEditRoutes.post("/api/comment-undo", async (c) => {
  let body: { turnId?: string };
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  const snap = body.turnId ? await getSnapshot(body.turnId) : null;
  if (!snap) {
    return c.json({ error: "Turn not found or already reverted." }, 404);
  }
  try {
    const { reverted } = await applySnapshot(snap);
    await deleteSnapshot(body.turnId!);
    return c.json({ reverted });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
