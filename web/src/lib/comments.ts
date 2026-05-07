/* comments.ts — file/element-scoped annotations.
 *
 * Backed by `web/projects/<id>/.meta/comments.json` on the server, with an
 * in-memory cache so the public API stays synchronous (callers don't need
 * to know about the network).
 *
 * Flow:
 *   - First read for a project triggers a background fetch + SSE
 *     subscription. Until the fetch resolves, callers see an empty list.
 *   - Mutations (add/update/remove) write to the cache immediately, fire a
 *     `comments:change` event for re-render, and schedule a debounced PATCH.
 *   - The server broadcasts on its `__meta-events` channel; other tabs /
 *     browsers receive `data: comments` and refetch.
 *   - First-time projects with localStorage data get their data pushed up
 *     when the server returns 404 — automatic migration.
 *
 * Concurrency: PATCH sends the full snapshot with `If-Match` set to the
 * cached ETag. On 412 the client refetches (last-write-wins per project,
 * per snapshot — fine for single-user-with-multiple-tabs).
 */

import { useEffect, useState } from "react";
import { subscribeProjectMeta } from "./metaEvents";
import type { ElementDescriptor } from "./cssPath";
import type { LabelKind } from "./smartLabel";

export type LocalComment = {
  id: string;
  file: string;
  selector: string;
  tag?: string;
  innerText?: string;
  /** Rich element profile snapshotted at capture time. Optional for
   *  back-compat with rows saved before this field existed — the UI
   *  falls back to tag-based smart labels for those. */
  descriptor?: ElementDescriptor;
  /** Resolved smart-label kind, classified at capture time when live
   *  computed style was available. Persisted so the comments panel
   *  can render "Heading" on a heading-styled div without re-resolving
   *  computed style (which we no longer have post-reload). */
  kind?: LabelKind;
  body: string;
  x?: number;
  y?: number;
  ts: number;
  resolved?: boolean;
  promoted?: boolean;
  /** ms-since-epoch when the comment was bundled into a chat turn. Set
   *  alongside `promotedTurnId` so we can roll the lifecycle back to
   *  Open if the spawning turn errors / is undone. */
  promotedAt?: number;
  /** Turn id of the chat message that absorbed this comment. Cleared
   *  on stream-error so a re-promotion is possible. */
  promotedTurnId?: string;
  /** Iframe viewport at the time of capture — preserved so the AI can
   *  reproduce the layout the user was looking at. */
  viewport?: { w: number; h: number };
  thumbnail?: string;
  domHtml?: string;
  styles?: Record<string, string>;
  scrollX?: number;
  scrollY?: number;
};

const META_KEY = "comments";
const LEGACY_KEY_BASE = "editor-comments.v1"; // pre-server-migration

type CacheEntry = {
  items: LocalComment[];
  etag: string | null;
  loaded: boolean;
  loading: Promise<void> | null;
};
const cache = new Map<string, CacheEntry>();
// Same shape as threads.ts: store cancel-fns so `releaseProject` can
// actually drop the SSE listener and let metaEvents close the socket.
const subscriptions = new Map<string, () => void>();
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getCache(projectId: string): CacheEntry {
  let c = cache.get(projectId);
  if (!c) {
    c = { items: [], etag: null, loaded: false, loading: null };
    cache.set(projectId, c);
  }
  return c;
}

function emitChange(projectId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("comments:change", { detail: { projectId } }));
}

function uuid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/* ─── server I/O ───────────────────────────────────────────────── */

async function fetchFromServer(projectId: string): Promise<void> {
  const c = getCache(projectId);
  if (c.loading) return c.loading;
  const wasLoaded = c.loaded;
  c.loading = (async () => {
    let changed = false;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/meta/${META_KEY}`);
      if (r.status === 404) {
        // No server blob yet — try a one-shot migration from
        // localStorage. DO NOT clear `c.items` when the cache holds
        // entries: those are user-just-added comments sitting in the
        // debounced PATCH window. Same data-loss race as threads.ts.
        const legacy = readLegacyLocalStorage(projectId);
        if (legacy && legacy.length > 0) {
          c.items = legacy;
          changed = true;
          await pushToServer(projectId);
          clearLegacyLocalStorage(projectId);
        }
        c.etag = null;
      } else if (r.ok) {
        const data = (await r.json()) as unknown;
        const next = Array.isArray(data) ? (data as LocalComment[]) : [];
        // Skip cache swap + emit when content matches — breaks the
        // PATCH → SSE echo → setState → push loop.
        if (JSON.stringify(next) !== JSON.stringify(c.items)) {
          c.items = next;
          changed = true;
        }
        c.etag = r.headers.get("etag");
      }
      c.loaded = true;
    } catch {
      // Offline or server error — leave cache empty but mark loaded so we
      // don't spin. The next mutation will retry on its PATCH.
      c.loaded = true;
    } finally {
      c.loading = null;
    }
    if (changed || !wasLoaded) emitChange(projectId);
  })();
  return c.loading;
}

async function pushToServer(projectId: string): Promise<void> {
  const c = getCache(projectId);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (c.etag) headers["if-match"] = c.etag;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/meta/${META_KEY}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(c.items),
    });
    if (r.status === 412) {
      // Another tab beat us — refetch and let our snapshot lose. The user
      // sees the merged list on the next render.
      c.etag = null;
      await fetchFromServer(projectId);
      return;
    }
    if (r.ok) {
      const newEtag = r.headers.get("etag");
      if (newEtag) c.etag = newEtag;
    }
  } catch {
    // Network failed — keep the cache; the next mutation will retry.
  }
}

function schedulePush(projectId: string) {
  const existing = pushTimers.get(projectId);
  if (existing) clearTimeout(existing);
  pushTimers.set(projectId, setTimeout(() => {
    pushTimers.delete(projectId);
    void pushToServer(projectId);
  }, 300));
}

function ensureSubscribed(projectId: string) {
  if (typeof window === "undefined") return;
  if (subscriptions.has(projectId)) return;
  const off = subscribeProjectMeta(projectId, (data) => {
    if (data === META_KEY) {
      const c = getCache(projectId);
      c.etag = null;
      void fetchFromServer(projectId);
    }
  });
  subscriptions.set(projectId, off);
}

/** Drop the SSE subscription for a project — keeps the cache warm but
 *  lets metaEvents close the underlying connection. Editor calls this
 *  when switching projects so we don't leak one socket per project ever
 *  visited (the browser caps HTTP/1.1 at 6 sockets per origin). */
export function releaseProject(projectId: string): void {
  const off = subscriptions.get(projectId);
  if (!off) return;
  subscriptions.delete(projectId);
  try { off(); } catch { /* ignore */ }
}

/* ─── legacy localStorage migration helpers ────────────────────── */

function readLegacyLocalStorage(projectId: string): LocalComment[] | null {
  if (typeof window === "undefined") return null;
  try {
    const scoped = localStorage.getItem(`${LEGACY_KEY_BASE}:${projectId}`);
    const global = localStorage.getItem(LEGACY_KEY_BASE);
    const raw = scoped ?? global;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LocalComment[]) : null;
  } catch { return null; }
}

function clearLegacyLocalStorage(projectId: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(`${LEGACY_KEY_BASE}:${projectId}`);
    localStorage.removeItem(LEGACY_KEY_BASE);
  } catch { /* ignore */ }
}

/* ─── public API ───────────────────────────────────────────────── */

export function listComments(projectId: string, file?: string): LocalComment[] {
  const c = getCache(projectId);
  if (!c.loaded && !c.loading) {
    void fetchFromServer(projectId);
    ensureSubscribed(projectId);
  }
  return file ? c.items.filter((x) => x.file === file) : c.items;
}

export function addComment(projectId: string, c: Omit<LocalComment, "id" | "ts">): LocalComment {
  const next: LocalComment = { ...c, id: uuid(), ts: Date.now() };
  const entry = getCache(projectId);
  entry.items = [...entry.items, next];
  emitChange(projectId);
  schedulePush(projectId);
  return next;
}

export function updateComment(projectId: string, id: string, patch: Partial<LocalComment>) {
  const entry = getCache(projectId);
  entry.items = entry.items.map((c) => (c.id === id ? { ...c, ...patch } : c));
  emitChange(projectId);
  schedulePush(projectId);
}

export function removeComment(projectId: string, id: string) {
  const entry = getCache(projectId);
  entry.items = entry.items.filter((c) => c.id !== id);
  emitChange(projectId);
  schedulePush(projectId);
}

/** Tag every listed comment with the turn id that absorbed it. Used by
 *  the multi-select promote flow so the lifecycle (Open → Promoted →
 *  Resolved) can be reversed via {@link clearPromoted} on stream error. */
export function markPromoted(projectId: string, ids: string[], turnId: string) {
  if (ids.length === 0) return;
  const entry = getCache(projectId);
  const set = new Set(ids);
  const now = Date.now();
  entry.items = entry.items.map((c) =>
    set.has(c.id) ? { ...c, promoted: true, promotedAt: now, promotedTurnId: turnId } : c
  );
  emitChange(projectId);
  schedulePush(projectId);
}

/** Roll back {@link markPromoted}. Only clears the link to the turn —
 *  keeps the comments themselves so the user can re-promote. */
export function clearPromoted(projectId: string, ids: string[]) {
  if (ids.length === 0) return;
  const entry = getCache(projectId);
  const set = new Set(ids);
  entry.items = entry.items.map((c) =>
    set.has(c.id)
      ? { ...c, promoted: false, promotedAt: undefined, promotedTurnId: undefined }
      : c
  );
  emitChange(projectId);
  schedulePush(projectId);
}

/** Mark every listed comment as resolved in one mutation — one PATCH
 *  for N rows. Used by the "Resolve N promoted comments?" auto-prompt
 *  after a successful turn, and by the bulk Resolve action in the
 *  selection bar. */
export function bulkResolve(projectId: string, ids: string[], resolved = true) {
  if (ids.length === 0) return;
  const entry = getCache(projectId);
  const set = new Set(ids);
  entry.items = entry.items.map((c) =>
    set.has(c.id) ? { ...c, resolved } : c
  );
  emitChange(projectId);
  schedulePush(projectId);
}

/** React hook — re-renders when comments for the given project change. */
export function useComments(projectId: string, file?: string): LocalComment[] {
  const [items, setItems] = useState<LocalComment[]>(() => listComments(projectId, file));
  useEffect(() => {
    const refresh = () => setItems(listComments(projectId, file));
    const onChange = (e: Event) => {
      const ev = e as CustomEvent<{ projectId?: string }>;
      if (!ev.detail || !ev.detail.projectId || ev.detail.projectId === projectId) refresh();
    };
    window.addEventListener("comments:change", onChange);
    // Sync after subscribing so we don't miss an emit that fired between mount and listener registration.
    refresh();
    return () => window.removeEventListener("comments:change", onChange);
  }, [projectId, file]);
  return items;
}
