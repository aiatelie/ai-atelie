/* agents/shared/sessionStore.ts — auto-heal session remap, shared.
 *
 * Both claude.ts and kimi.ts had identical state for the same idea:
 * when resuming an existing session fails with a hard exit, generate
 * a fresh uuid, remember the remap (original → fresh) so future
 * messages in the same conversation pick up the new session, and
 * retry once.
 *
 * The session-file location differs per provider (Claude writes
 * `~/.claude/projects/<slug>/<sid>.jsonl`; kimi writes
 * `~/.kimi/sessions/<md5(rootDir)>/<sid>/wire.jsonl`) so the
 * "does this session exist on disk?" check stays inside each
 * adapter. Only the remap-bookkeeping lives here, namespaced by
 * provider id so two providers using the same `originalSid` don't
 * collide.
 *
 * State is process-local. HMR / process restart wipes the remap;
 * this is intentional — file-system session state is the source of
 * truth and a corrupt session won't survive a restart.
 */

import { randomUUID } from "node:crypto";

const remap = new Map<string, string>();

const remapKey = (provider: string, rootDir: string, originalSid: string) =>
  `${provider}::${rootDir}::${originalSid}`;

/** Look up the effective session id for a given (provider, rootDir,
 *  originalSid) tuple. Returns the remapped uuid if auto-heal has
 *  fired for this conversation; otherwise returns originalSid
 *  unchanged. Returns null when originalSid is null. */
export function effectiveSessionId(
  provider: string,
  rootDir: string,
  originalSid: string | null,
): string | null {
  if (!originalSid) return null;
  return remap.get(remapKey(provider, rootDir, originalSid)) ?? originalSid;
}

/** Mark a session as corrupt. Generates a fresh uuid, binds the
 *  original → fresh mapping, and returns the fresh uuid for the
 *  retry attempt. The old session file on disk is left in place;
 *  the next run starts a new session under the fresh uuid. */
export function orphanSession(
  provider: string,
  rootDir: string,
  originalSid: string,
): string {
  const fresh = randomUUID();
  remap.set(remapKey(provider, rootDir, originalSid), fresh);
  return fresh;
}

/** Diagnostic only — surfaced in adapter log lines. */
export function sessionRemapSize(): number {
  return remap.size;
}
