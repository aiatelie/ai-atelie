/* sseChannels.ts — workspace-wide event bus for non-storage signals.
 *
 *   sharedEvents — emitted on project create/rename/delete. Subscribed via
 *   /api/__shared-events alongside driver-level kv changes.
 *
 * The per-project meta-events and per-project reload events used to live
 * here too. They moved into the StorageDriver: route handlers now subscribe
 * via `getRepos().projectMeta.subscribe(id, fn)` and
 * `getRepos().projectFiles.subscribe(id, fn)`, both of which return an
 * unsubscribe function. This file only exists for events that are *not*
 * tied to a storage object — the project-list-changed signal that
 * `routes/projects.ts` fires after create/delete.
 */

import { EventEmitter } from "node:events";

export const sharedEvents = new EventEmitter();
sharedEvents.setMaxListeners(0);

export function broadcastShared(key: string) {
  sharedEvents.emit("event", key);
}
