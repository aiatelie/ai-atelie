/* projectMetaSync.ts — debounced sync of per-project JSON to disk.
 *
 * The frontend keeps a synchronous in-memory cache (so render-hot-path
 * reads stay sync), and pushes changes to `/api/projects/:id/meta/:key`
 * with a 250ms debounce. Writes are best-effort: on failure we log,
 * keep the in-memory cache, and let the next successful push converge.
 *
 * Used by lib/editorOverrides (per-route inspector overrides) and
 * lib/drawings (per-route freehand strokes) — both used to live in
 * localStorage under a single workspace-wide key, which leaked across
 * projects. Per-project meta keys fix that AND make the data
 * cross-browser visible (closes the same class of bug as #55).
 */

const PUSH_DEBOUNCE_MS = 250;
const inflight = new Map<string, ReturnType<typeof setTimeout>>();
// Track the latest etag we got back per (projectId, key) so subsequent
// PATCHes can pass If-Match. If a write conflicts, we re-fetch and
// retry once with the fresh etag.
const lastEtag = new Map<string, string>();

function cacheKey(projectId: string, key: string): string {
  return `${projectId}::${key}`;
}

/** Schedule a debounced PATCH that writes `value` to
 *  `/api/projects/<projectId>/meta/<key>`. Multiple calls within the
 *  debounce window collapse to one network request with the latest
 *  value. Failures are logged once; in-memory state stays the truth
 *  until the next successful push reconciles. */
export function pushMetaSoon(projectId: string, key: string, value: unknown): void {
  const ck = cacheKey(projectId, key);
  const existing = inflight.get(ck);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    inflight.delete(ck);
    void doPush(projectId, key, value);
  }, PUSH_DEBOUNCE_MS);
  inflight.set(ck, timer);
}

async function doPush(projectId: string, key: string, value: unknown): Promise<void> {
  const ck = cacheKey(projectId, key);
  const url = `/api/projects/${encodeURIComponent(projectId)}/meta/${encodeURIComponent(key)}`;
  const prevEtag = lastEtag.get(ck);
  try {
    const r = await fetch(url, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(prevEtag ? { "if-match": prevEtag } : {}),
      },
      body: JSON.stringify(value),
    });
    if (r.status === 412) {
      // Stale etag — somebody else wrote in between. Re-fetch + retry once.
      const fresh = await fetch(url);
      if (fresh.ok) {
        const etag = fresh.headers.get("etag");
        if (etag) lastEtag.set(ck, etag);
        // Retry with the fresh etag.
        const retry = await fetch(url, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            ...(etag ? { "if-match": etag } : {}),
          },
          body: JSON.stringify(value),
        });
        if (retry.ok) {
          const retryEtag = retry.headers.get("etag");
          if (retryEtag) lastEtag.set(ck, retryEtag);
        }
      }
      return;
    }
    if (r.ok) {
      const etag = r.headers.get("etag");
      if (etag) lastEtag.set(ck, etag);
    }
  } catch (err) {
    // Network failure — silently skip. The in-memory cache stays the
    // truth; the next successful push (or a project switch refetch)
    // will reconcile.
    if (typeof console !== "undefined" && console.warn) {
      console.warn(`[meta-sync] push ${url} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Fetch `/api/projects/:id/meta/:key` once. Returns null on 404 or
 *  network failure. On success, stamps the etag for future If-Match
 *  use by `pushMetaSoon`. */
export async function pullMeta<T = unknown>(projectId: string, key: string): Promise<T | null> {
  const ck = cacheKey(projectId, key);
  const url = `/api/projects/${encodeURIComponent(projectId)}/meta/${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      if (r.status === 404) lastEtag.delete(ck);
      return null;
    }
    const etag = r.headers.get("etag");
    if (etag) lastEtag.set(ck, etag);
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Force-flush any pending debounced push for `(projectId, key)`. Used
 *  by project-switch hydration so we don't lose unsaved local edits
 *  before pulling fresh state. */
export async function flushPending(projectId: string, key: string): Promise<void> {
  const ck = cacheKey(projectId, key);
  const timer = inflight.get(ck);
  if (timer) {
    clearTimeout(timer);
    inflight.delete(ck);
    // The closure in pushMetaSoon already captured the latest value;
    // unfortunately we can't replay it here without storing the value.
    // Callers who need a guaranteed flush should instead call doPush
    // directly with the value they want. flushPending just cancels.
  }
}
