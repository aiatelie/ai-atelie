/* metaEvents.ts — shared EventSource fan-out.
 *
 * Browsers cap HTTP/1.1 sockets at ~6 per origin. Each open SSE eats one.
 * Without sharing, two open projects burn 4 sockets just on meta-events
 * (comments + threads × 2), plus 2 more on the workspace channel — leaving
 * zero headroom for `/api/comment-edit` plus normal fetches. New requests
 * (project list, manifest, etc.) then queue indefinitely.
 *
 * This module keeps **one** EventSource per URL and fans `onmessage` out
 * to every registered listener. Consumers (`comments.ts`, `threads.ts`,
 * `projects.ts`, `sharedAssets.ts`) all funnel through here.
 *
 * Lifecycle: when the listener count for a URL drops to zero, the
 * EventSource is closed after a 5s grace period. The grace period
 * absorbs project-switch bounce — if a new subscriber arrives within
 * 5s, the close is cancelled and the connection stays warm. Without
 * this we'd accumulate one EventSource per project ever visited and
 * eventually saturate the browser's socket cap, making the app feel
 * "dead" — new requests queue forever behind dead-but-open SSEs.
 */

type Listener = (data: string) => void;

const sources = new Map<string, EventSource>();
const listeners = new Map<string, Set<Listener>>();
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();

const CLOSE_GRACE_MS = 5_000;

function ensure(url: string) {
  // Cancel any pending close — a new subscriber wants the live connection.
  const t = closeTimers.get(url);
  if (t) { clearTimeout(t); closeTimers.delete(url); }
  if (sources.has(url)) return;
  try {
    const es = new EventSource(url);
    es.onmessage = (e) => {
      const set = listeners.get(url);
      if (!set) return;
      for (const cb of set) cb(e.data);
    };
    sources.set(url, es);
  } catch { /* EventSource unsupported */ }
}

function maybeCloseLater(url: string) {
  if (closeTimers.has(url)) return;
  const timer = setTimeout(() => {
    closeTimers.delete(url);
    const set = listeners.get(url);
    if (set && set.size > 0) return; // someone re-subscribed during the grace
    const es = sources.get(url);
    if (es) {
      try { es.close(); } catch { /* ignore */ }
      sources.delete(url);
    }
    listeners.delete(url);
  }, CLOSE_GRACE_MS);
  closeTimers.set(url, timer);
}

function subscribe(url: string, cb: Listener): () => void {
  if (typeof window === "undefined") return () => { /* noop */ };
  let set = listeners.get(url);
  if (!set) { set = new Set(); listeners.set(url, set); }
  set.add(cb);
  ensure(url);
  return () => {
    const s = listeners.get(url);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) maybeCloseLater(url);
  };
}

/** Subscribe to a project's `__meta-events` channel. The callback receives
 *  the meta key that changed (e.g. `"comments"`, `"threads"`). */
export function subscribeProjectMeta(projectId: string, cb: Listener): () => void {
  return subscribe(`/api/projects/${encodeURIComponent(projectId)}/__meta-events`, cb);
}

/** Subscribe to the workspace `__shared-events` channel. The callback
 *  receives the shared key that changed (e.g. `"projects"`, `"assets"`). */
export function subscribeSharedMeta(cb: Listener): () => void {
  return subscribe(`/api/__shared-events`, cb);
}
