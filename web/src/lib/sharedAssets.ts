/* sharedAssets.ts — workspace-wide assets visible to every project.
 *
 * Backed by `web/.data/assets.json` on the server (workspace-level, not
 * per-project), with an in-memory cache so the public API stays sync.
 *
 * Live propagation: editing a shared color writes to the cache + fires a
 * `shared-assets:change` event the editor listens to. The editor then
 * rewrites CSS variables on each open iframe's <html>. The PATCH to the
 * server happens in the background; SSE on /api/__shared-events lets
 * other tabs/browsers see the change.
 */
import { useEffect, useState } from "react";
import { subscribeSharedMeta } from "./metaEvents";

export type SharedColor = {
  id: string;
  name: string;
  hex: string;
  updatedAt: number;
};

export type SharedLottie = { id: string; name: string; url: string; updatedAt: number };
export type SharedComponent = { id: string; name: string; html: string; updatedAt: number };

export type SharedAssets = {
  colors: SharedColor[];
  lotties: SharedLottie[];
  components: SharedComponent[];
};

const SHARED_KEY = "assets";
const LEGACY_KEY = "shared-assets.v1";

function uuid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function emptyAssets(): SharedAssets {
  return { colors: [], lotties: [], components: [] };
}

/* ─── cache + sync ─────────────────────────────────────────────── */

type CacheEntry = {
  data: SharedAssets;
  etag: string | null;
  loaded: boolean;
  loading: Promise<void> | null;
  /** Set when the last server read failed (!res.ok or threw). Lets the
   *  AssetsDialog distinguish "genuinely empty" from "fetch failed"
   *  instead of silently showing an empty library. */
  error: boolean;
};

const entry: CacheEntry = { data: emptyAssets(), etag: null, loaded: false, loading: null, error: false };
let subscribed = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function emitChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("shared-assets:change"));
}

async function fetchFromServer(): Promise<void> {
  if (entry.loading) return entry.loading;
  const wasLoaded = entry.loaded;
  entry.loading = (async () => {
    let changed = false;
    try {
      const r = await fetch(`/api/shared/${SHARED_KEY}`);
      if (!r.ok && r.status !== 404) {
        // A real transport/server failure — surface it. (404 is the
        // benign "no assets file yet" case handled just below.)
        entry.error = true;
      } else {
        entry.error = false;
      }
      if (r.status === 404) {
        const legacy = readLegacyLocalStorage();
        if (legacy) {
          entry.data = legacy;
          changed = true;
          await pushToServer();
          clearLegacyLocalStorage();
        }
        entry.etag = null;
      } else if (r.ok) {
        const data = (await r.json()) as Partial<SharedAssets>;
        const next: SharedAssets = {
          colors: Array.isArray(data?.colors) ? data.colors : [],
          lotties: Array.isArray(data?.lotties) ? data.lotties : [],
          components: Array.isArray(data?.components) ? data.components : [],
        };
        if (JSON.stringify(next) !== JSON.stringify(entry.data)) {
          entry.data = next;
          changed = true;
        }
        entry.etag = r.headers.get("etag");
      }
      entry.loaded = true;
    } catch {
      entry.error = true;
      entry.loaded = true;
    } finally {
      entry.loading = null;
    }
    if (changed || !wasLoaded || entry.error) emitChange();
  })();
  return entry.loading;
}

async function pushToServer(): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (entry.etag) headers["if-match"] = entry.etag;
  try {
    const r = await fetch(`/api/shared/${SHARED_KEY}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(entry.data),
    });
    if (r.status === 412) {
      entry.etag = null;
      await fetchFromServer();
      return;
    }
    if (r.ok) {
      const newEtag = r.headers.get("etag");
      if (newEtag) entry.etag = newEtag;
    }
  } catch { /* offline */ }
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; void pushToServer(); }, 300);
}

function ensureSubscribed() {
  if (typeof window === "undefined") return;
  if (subscribed) return;
  subscribed = true;
  subscribeSharedMeta((data) => {
    if (data === SHARED_KEY) {
      entry.etag = null;
      void fetchFromServer();
    }
  });
}

function readLegacyLocalStorage(): SharedAssets | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SharedAssets>;
    return {
      colors: Array.isArray(parsed?.colors) ? parsed.colors : [],
      lotties: Array.isArray(parsed?.lotties) ? parsed.lotties : [],
      components: Array.isArray(parsed?.components) ? parsed.components : [],
    };
  } catch { return null; }
}

function clearLegacyLocalStorage() {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
}

/* ─── public API (sync, cache-backed) ──────────────────────────── */

export function getSharedAssets(): SharedAssets {
  if (!entry.loaded && !entry.loading) {
    void fetchFromServer();
    ensureSubscribed();
  }
  return entry.data;
}

/** Whether the last server read failed. Pairs with `refreshSharedAssets()`
 *  so callers can offer a Retry affordance. */
export function getSharedAssetsError(): boolean {
  return entry.error;
}

/** Force a re-fetch from the server (used by Retry). Clears the cached
 *  etag so the next read isn't short-circuited. */
export function refreshSharedAssets(): void {
  entry.etag = null;
  void fetchFromServer();
}

function commit(next: SharedAssets) {
  entry.data = next;
  emitChange();
  schedulePush();
}

/* ─── Colors ──────────────────────────────────────────────── */

export function addColor(name: string, hex: string): SharedColor {
  const cur = getSharedAssets();
  const c: SharedColor = { id: uuid(), name, hex, updatedAt: Date.now() };
  commit({ ...cur, colors: [...cur.colors, c] });
  return c;
}

export function updateColor(id: string, patch: Partial<Omit<SharedColor, "id">>) {
  const cur = getSharedAssets();
  commit({
    ...cur,
    colors: cur.colors.map((c) =>
      c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c
    ),
  });
}

export function removeColor(id: string) {
  const cur = getSharedAssets();
  commit({ ...cur, colors: cur.colors.filter((c) => c.id !== id) });
}

/* ─── Lotties ─────────────────────────────────────────────── */

export function addLottie(name: string, url: string): SharedLottie {
  const cur = getSharedAssets();
  const l: SharedLottie = { id: uuid(), name, url, updatedAt: Date.now() };
  commit({ ...cur, lotties: [...cur.lotties, l] });
  return l;
}

export function updateLottie(id: string, patch: Partial<Omit<SharedLottie, "id">>) {
  const cur = getSharedAssets();
  commit({
    ...cur,
    lotties: cur.lotties.map((l) =>
      l.id === id ? { ...l, ...patch, updatedAt: Date.now() } : l
    ),
  });
}

export function removeLottie(id: string) {
  const cur = getSharedAssets();
  commit({ ...cur, lotties: cur.lotties.filter((l) => l.id !== id) });
}

/* ─── Components ──────────────────────────────────────────── */

export function addComponent(name: string, html: string): SharedComponent {
  const cur = getSharedAssets();
  const c: SharedComponent = { id: uuid(), name, html, updatedAt: Date.now() };
  commit({ ...cur, components: [...cur.components, c] });
  return c;
}

export function updateComponent(id: string, patch: Partial<Omit<SharedComponent, "id">>) {
  const cur = getSharedAssets();
  commit({
    ...cur,
    components: cur.components.map((c) =>
      c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c
    ),
  });
}

export function removeComponent(id: string) {
  const cur = getSharedAssets();
  commit({ ...cur, components: cur.components.filter((c) => c.id !== id) });
}

/* ─── React hook ──────────────────────────────────────────── */

export function useSharedAssets(): SharedAssets {
  const [assets, setAssets] = useState<SharedAssets>(() => getSharedAssets());
  useEffect(() => {
    const refresh = () => setAssets(getSharedAssets());
    window.addEventListener("shared-assets:change", refresh);
    // Sync after subscribing so we don't miss an emit that fired between mount and listener registration.
    refresh();
    return () => window.removeEventListener("shared-assets:change", refresh);
  }, []);
  return assets;
}

/** Reactive read of the last-fetch error flag. Re-renders on the same
 *  `shared-assets:change` event that drives `useSharedAssets`. */
export function useSharedAssetsError(): boolean {
  const [err, setErr] = useState<boolean>(() => getSharedAssetsError());
  useEffect(() => {
    const refresh = () => setErr(getSharedAssetsError());
    window.addEventListener("shared-assets:change", refresh);
    refresh();
    return () => window.removeEventListener("shared-assets:change", refresh);
  }, []);
  return err;
}

/* ─── Applying to an iframe ───────────────────────────────── */

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "color";
}

/** Inject CSS variables for each shared color onto `doc.documentElement`. */
export function applySharedAssetsToDoc(doc: Document | null) {
  if (!doc?.documentElement) return;
  const root = doc.documentElement;
  const assets = getSharedAssets();
  for (const c of assets.colors) {
    root.style.setProperty(`--shared-color-${c.id}`, c.hex);
    root.style.setProperty(`--shared-color-${slugify(c.name)}`, c.hex);
  }
}

export const _internal = { slugify };
