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
import { activeRuns } from "../services/runRegistry.ts";
import {
  cancelPendingForStream,
  registerStreamEmitter,
  unregisterStreamEmitter,
} from "../services/elicitBus.ts";
import { projectDirOf, internalBaseUrl } from "../services/projectStore.ts";
import { openRunLog } from "../services/runLogger.ts";
import type { CommentPayload } from "../services/types.ts";

/** Hard wall-clock cap on a single AI turn. If we don't reach `done`
 *  within this window we abort and return a clear timeout error.
 *  10 min instead of 5: motion-design refactors that touch multiple
 *  files (RouteMap variants, design-canvas updates, etc.) legitimately
 *  exceed 5min on Claude Opus. The cap exists to catch wedged
 *  subprocesses, not to throttle thoughtful work. */
const RUN_MAX_DURATION_MS = 10 * 60 * 1000;

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
  let payload: CommentPayload;
  try { payload = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  if (!payload.comment || !payload.route) {
    return c.text("Missing route or comment", 400);
  }

  const turnId = randomUUID();
  const requestStreamId = randomUUID();
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
      // Hono's writeSSE swallows write errors when the stream is aborted;
      // catch defensively so a closed socket can't poison the agent loop.
      stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => { /* aborted */ });
      // Mirror to the per-stream log so a hung turn leaves a tail-able
      // trace. Truncate big payloads (kimi can emit multi-KB blobs).
      try {
        const j = JSON.stringify(data);
        runLog.log(`sse event=${event} data=${j.length > 600 ? j.slice(0, 600) + "…(+" + (j.length - 600) + ")" : j}`);
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
    stream.onAbort(() => {
      clientAborted = true;
      if (agentDone) return;
      if (!abortController.signal.aborted) {
        abortController.abort("client-aborted");
        const cancelled = cancelPendingForStream(requestStreamId, "client-aborted");
        for (const id of cancelled) {
          try { send("elicitClear", { id, reason: "client-aborted" }); } catch { /* ignore */ }
        }
      }
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
      activeRuns.delete(requestStreamId);
      unregisterStreamEmitter(requestStreamId);
      try { await heartbeat; } catch { /* ignore */ }
      try { await runLog.flush(); } catch { /* ignore */ }
      runLog.close();
    }
  });
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
