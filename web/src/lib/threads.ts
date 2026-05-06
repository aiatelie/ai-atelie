/* threads.ts — chat-thread persistence per project.
 *
 * Same shape as comments.ts: in-memory cache, sync API for callers, debounced
 * PATCH to /api/projects/<id>/meta/threads, ETag-tracked, SSE-invalidated,
 * automatic localStorage→server migration on first 404.
 *
 * The sanitizer (mark dead pending streams as errored on load) lives at the
 * call sites that already implemented it — this lib intentionally treats the
 * archive as opaque so callers can keep their behavior.
 */
import type { ChatThread, ThreadArchive } from "../components/editor/ChatSidebar";
import { subscribeProjectMeta } from "./metaEvents";

const META_KEY = "threads";
const LEGACY_KEY_BASE = "editor-threads";

type CacheEntry = {
  archive: ThreadArchive;
  etag: string | null;
  loaded: boolean;
  loading: Promise<void> | null;
};
const cache = new Map<string, CacheEntry>();
// Per-project cancel-fns returned by metaEvents.subscribeProjectMeta.
// Stored so `releaseProject` can actually drop the SSE listener and let
// metaEvents close the connection — without this every project ever
// visited held its EventSource open until the page was refreshed.
const subscriptions = new Map<string, () => void>();
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emptyArchive(): ThreadArchive { return { threads: [], activeId: null }; }

function getEntry(projectId: string): CacheEntry {
  let c = cache.get(projectId);
  if (!c) {
    c = { archive: emptyArchive(), etag: null, loaded: false, loading: null };
    cache.set(projectId, c);
  }
  return c;
}

function emitChange(projectId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("threads:change", { detail: { projectId } }));
}

/* ─── server I/O ───────────────────────────────────────────────── */

async function fetchFromServer(projectId: string): Promise<void> {
  const c = getEntry(projectId);
  if (c.loading) return c.loading;
  const wasLoaded = c.loaded;
  c.loading = (async () => {
    let changed = false;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/meta/${META_KEY}`);
      if (r.status === 404) {
        // No server blob yet. Try one-shot migration from legacy
        // localStorage first. DO NOT clear `c.archive` if the cache
        // already holds threads — that's user-just-added data sitting
        // in the 300ms push window (the saveThreads guard stashed it
        // while we were loading). Clearing here was a data-loss race
        // during first-project creation.
        const legacy = readLegacyLocalStorage(projectId);
        if (legacy && legacy.threads.length > 0) {
          c.archive = legacy;
          changed = true;
          await pushToServer(projectId);
          clearLegacyLocalStorage(projectId);
        } else if (c.archive.threads.length > 0) {
          // saveThreads stashed data while we were loading but skipped
          // the push (mount-race guard). Schedule it now — without this
          // the user's first message lives in the in-memory cache and
          // never reaches disk, so reloads see an empty thread.
          schedulePush(projectId);
        }
        c.etag = null;
      } else if (r.ok) {
        const data = (await r.json()) as Partial<ThreadArchive>;
        const next: ThreadArchive = {
          threads: Array.isArray(data?.threads) ? (data.threads as ChatThread[]) : [],
          activeId: typeof data?.activeId === "string" ? data.activeId : null,
        };
        // Only swap cache + emit when content actually changed. Otherwise
        // our own PATCH → SSE echo → setState → save loop runs forever.
        if (JSON.stringify(next) !== JSON.stringify(c.archive)) {
          c.archive = next;
          changed = true;
        }
        c.etag = r.headers.get("etag");
      }
      c.loaded = true;
    } catch {
      c.loaded = true;
    } finally {
      c.loading = null;
    }
    // Emit on first load (so listeners see we're done loading) or on
    // any real content change.
    if (changed || !wasLoaded) emitChange(projectId);
  })();
  return c.loading;
}

async function pushToServer(projectId: string): Promise<void> {
  const c = getEntry(projectId);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (c.etag) headers["if-match"] = c.etag;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/meta/${META_KEY}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(c.archive),
    });
    if (r.status === 412) {
      c.etag = null;
      await fetchFromServer(projectId);
      return;
    }
    if (r.ok) {
      const newEtag = r.headers.get("etag");
      if (newEtag) c.etag = newEtag;
    }
  } catch { /* offline; next mutation retries */ }
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
      const c = getEntry(projectId);
      c.etag = null;
      void fetchFromServer(projectId);
    }
  });
  subscriptions.set(projectId, off);
}

/** Drop the SSE subscription for a project — keeps the cache warm but
 *  lets metaEvents close the underlying EventSource so we don't leak
 *  one socket per project ever visited. The next call to `loadThreads`
 *  / `saveThreads` for this project will re-subscribe lazily. */
export function releaseProject(projectId: string): void {
  const off = subscriptions.get(projectId);
  if (!off) return;
  subscriptions.delete(projectId);
  try { off(); } catch { /* ignore */ }
}

/* ─── legacy localStorage migration ────────────────────────────── */

function readLegacyLocalStorage(projectId: string): ThreadArchive | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${LEGACY_KEY_BASE}:${projectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThreadArchive>;
    return {
      threads: Array.isArray(parsed?.threads) ? (parsed.threads as ChatThread[]) : [],
      activeId: typeof parsed?.activeId === "string" ? parsed.activeId : null,
    };
  } catch { return null; }
}

function clearLegacyLocalStorage(projectId: string) {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(`${LEGACY_KEY_BASE}:${projectId}`); } catch { /* ignore */ }
}

/* ─── public sync API ──────────────────────────────────────────── */

/** Synchronous read. First call kicks off the async fetch + SSE
 *  subscription; until that resolves, callers see an empty archive. */
export function loadThreads(projectId: string): ThreadArchive {
  if (!projectId) return emptyArchive();
  const c = getEntry(projectId);
  if (!c.loaded && !c.loading) {
    void fetchFromServer(projectId);
    ensureSubscribed(projectId);
  }
  return c.archive;
}

/** Replace the archive snapshot for a project. The new archive is
 *  cached immediately (so subsequent reads see the change) and the
 *  server PATCH is debounced 300ms. Callers should treat this as
 *  fire-and-forget; failures retry on the next save.
 *
 *  Intentionally does NOT fire `threads:change` — the caller is the
 *  component that initiated the change, so it already has the new
 *  state. Cross-tab subscribers learn via the SSE-driven fetchFromServer
 *  path, which only emits when content actually differs. Emitting here
 *  causes a write loop (caller's `useEffect([threads])` keeps re-firing). */
export function saveThreads(projectId: string, archive: ThreadArchive): void {
  if (!projectId) return;
  const c = getEntry(projectId);
  // Guard against the mount-time race: useState(loadThreads) returns an
  // empty archive while fetchFromServer is in flight, then the caller's
  // useEffect immediately fires saveThreads with that empty archive. If
  // we let that PATCH go out, it would clobber the real server data.
  // Skip the push until we've at least heard back from the server once.
  if (!c.loaded && c.loading) {
    // Stash the new archive so it overrides the in-flight fetch, but
    // don't trigger a push yet — the loading promise will write the
    // server result. The next mutation after load will push correctly.
    c.archive = archive;
    return;
  }
  c.archive = archive;
  c.loaded = true;
  schedulePush(projectId);
  // Subscribe lazily so a save without a prior load still wires the SSE.
  ensureSubscribed(projectId);
}

/** Subscribe to cross-tab/cross-browser thread changes for a project.
 *  Returns the unsubscribe function. */
export function subscribeThreads(projectId: string, cb: (archive: ThreadArchive) => void): () => void {
  if (typeof window === "undefined") return () => { /* noop */ };
  const handler = (e: Event) => {
    const ev = e as CustomEvent<{ projectId?: string }>;
    if (!ev.detail || !ev.detail.projectId || ev.detail.projectId === projectId) {
      cb(getEntry(projectId).archive);
    }
  };
  window.addEventListener("threads:change", handler);
  // Sync immediately in case the load-time emit fired before we subscribed.
  if (getEntry(projectId).loaded) cb(getEntry(projectId).archive);
  return () => window.removeEventListener("threads:change", handler);
}
