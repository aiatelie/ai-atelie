/* sseChannels.ts — pub-sub for SSE broadcasts.
 *
 * Three channels exist:
 *   • workspace-wide shared-events — emitted on /api/shared/:key writes
 *     and on project create/rename/delete. Subscribed via /api/__shared-events.
 *   • per-project meta-events — emitted on /api/projects/:id/meta/:key writes.
 *     Subscribed via /api/projects/:id/__meta-events.
 *   • per-project reload-events — emitted by fs.watch when the project
 *     dir changes. Subscribed via /p/:id/__reload by the iframe.
 *
 * In Hono on Bun we use a `streamSSE` callback per connection; that
 * callback registers a listener with EventEmitter at connect time and
 * removes it on `stream.onAbort`. The publisher just calls `emitter.emit`
 * — no connection bookkeeping in the publisher.
 */

import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { projectDirOf } from "./projectStore.ts";

/** Workspace-wide event bus. emit(key) → all `/api/__shared-events` clients
 *  receive `data: <key>\n\n`. */
export const sharedEvents = new EventEmitter();
sharedEvents.setMaxListeners(0);

export function broadcastShared(key: string) {
  sharedEvents.emit("event", key);
}

/* ─── Per-project meta channel ─── */

const metaEmitters = new Map<string, EventEmitter>();

export function getMetaEmitter(projectId: string): EventEmitter {
  let e = metaEmitters.get(projectId);
  if (e) return e;
  e = new EventEmitter();
  e.setMaxListeners(0);
  metaEmitters.set(projectId, e);
  return e;
}

export function broadcastMeta(projectId: string, key: string) {
  metaEmitters.get(projectId)?.emit("event", key);
}

export function destroyMetaChannel(projectId: string) {
  const e = metaEmitters.get(projectId);
  if (!e) return;
  e.removeAllListeners();
  metaEmitters.delete(projectId);
}

/* ─── Per-project iframe reload channel + fs.watch ─── */

type ReloadChannel = {
  watcher: ReturnType<typeof watch> | null;
  emitter: EventEmitter;
  debounce: ReturnType<typeof setTimeout> | null;
};
const reloadChannels = new Map<string, ReloadChannel>();

/** Get-or-create the reload channel for a project. Lazy-starts an
 *  fs.watch on the project dir; events are debounced 250ms before being
 *  emitted to all subscribers. Skips writes whose first path segment is
 *  `.meta` — those go on the meta channel instead and shouldn't reload
 *  the iframe. */
export async function getOrCreateReloadChannel(projectId: string): Promise<ReloadChannel | null> {
  const existing = reloadChannels.get(projectId);
  if (existing) return existing;
  const dir = projectDirOf(projectId);
  if (!dir) return null;
  // Avoid creating a channel for a project that doesn't exist yet (e.g.
  // first GET arrives before scaffold finished).
  const exists = await stat(dir).then(() => true).catch(() => false);
  if (!exists) return null;

  const ch: ReloadChannel = {
    watcher: null,
    emitter: new EventEmitter(),
    debounce: null,
  };
  ch.emitter.setMaxListeners(0);
  try {
    ch.watcher = watch(dir, { recursive: true }, (_evt, filename) => {
      if (typeof filename === "string" && filename.split(/[\\/]/)[0] === ".meta") return;
      if (ch.debounce) clearTimeout(ch.debounce);
      ch.debounce = setTimeout(() => ch.emitter.emit("reload"), 250);
    });
  } catch { /* dir might be ephemeral; skip */ }
  reloadChannels.set(projectId, ch);
  return ch;
}

export function destroyReloadChannel(projectId: string) {
  const ch = reloadChannels.get(projectId);
  if (!ch) return;
  try { ch.watcher?.close(); } catch { /* ignore */ }
  if (ch.debounce) clearTimeout(ch.debounce);
  ch.emitter.removeAllListeners();
  reloadChannels.delete(projectId);
}
