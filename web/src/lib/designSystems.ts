/* designSystems.ts — workspace design systems registry.
 *
 * A Design System (DS) is a user-authored brand definition (colors,
 * typography, voice, component rules) that Claude follows on every
 * design turn in any project bound to it. DSes live workspace-wide;
 * the same DS can be bound to several projects.
 *
 * Storage:
 *   • Server: web/design_systems/<id>.json (one JSON file per DS)
 *   • Browser: in-memory cache + SSE re-fetch on workspace events
 *
 * The list is kept tiny (summary-only) to stay snappy. Full descriptions
 * are fetched lazily by `getDesignSystem(id)`.
 */

import { useEffect, useState } from "react";
import { subscribeSharedMeta } from "./metaEvents";

export type DesignSystemSummary = {
  id: string;
  name: string;
  published: boolean;
  createdAt: number;
  updatedAt: number;
};

export type DesignSystem = DesignSystemSummary & {
  schemaVersion: 1;
  description: string;
};

let cache: DesignSystemSummary[] | null = null;
let inflight: Promise<void> | null = null;
let firstFetchPending = false;
let sharedSubscribed = false;

function notifyChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("design-systems:change"));
  }
}

function ensureSubscribed() {
  if (typeof window === "undefined") return;
  if (sharedSubscribed) return;
  sharedSubscribed = true;
  subscribeSharedMeta((data) => {
    if (data === "design-systems") void fetchList();
  });
}

async function fetchList(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch("/api/design-systems");
      if (!r.ok) return;
      const list = (await r.json()) as DesignSystemSummary[];
      if (!Array.isArray(list)) return;
      cache = list;
      notifyChange();
    } catch {
      /* offline / boot — silent. The next mutation or SSE event will retry. */
    } finally {
      inflight = null;
      if (firstFetchPending) {
        firstFetchPending = false;
        notifyChange();
      }
    }
  })();
  return inflight;
}

function boot(): DesignSystemSummary[] {
  if (cache !== null) return cache;
  cache = [];
  firstFetchPending = true;
  if (typeof window !== "undefined") {
    void fetchList();
    ensureSubscribed();
  }
  return cache;
}

export function listDesignSystems(): DesignSystemSummary[] { return boot(); }

export function isLoadingDesignSystems(): boolean {
  boot();
  return firstFetchPending;
}

export async function getDesignSystem(id: string): Promise<DesignSystem | null> {
  if (!id) return null;
  try {
    const r = await fetch(`/api/design-systems/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return (await r.json()) as DesignSystem;
  } catch { return null; }
}

export async function createDesignSystem(input: {
  name: string;
  description: string;
}): Promise<DesignSystem> {
  const r = await fetch("/api/design-systems", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error ?? `Server returned ${r.status}`);
  }
  const ds = (await r.json()) as DesignSystem;
  // Optimistic local insert so the UI reflects the create immediately;
  // the SSE re-fetch will reconcile order/timestamps shortly after.
  if (cache) {
    const summary: DesignSystemSummary = {
      id: ds.id,
      name: ds.name,
      published: ds.published,
      createdAt: ds.createdAt,
      updatedAt: ds.updatedAt,
    };
    cache = [summary, ...cache.filter((d) => d.id !== ds.id)];
    notifyChange();
  }
  return ds;
}

export async function updateDesignSystem(id: string, patch: {
  name?: string;
  description?: string;
  published?: boolean;
}): Promise<DesignSystem> {
  const r = await fetch(`/api/design-systems/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error ?? `Server returned ${r.status}`);
  }
  const ds = (await r.json()) as DesignSystem;
  if (cache) {
    cache = cache.map((d) =>
      d.id === ds.id
        ? { id: ds.id, name: ds.name, published: ds.published, createdAt: ds.createdAt, updatedAt: ds.updatedAt }
        : d,
    );
    notifyChange();
  }
  return ds;
}

export async function publishDesignSystem(id: string, published: boolean): Promise<DesignSystem> {
  return updateDesignSystem(id, { published });
}

export async function deleteDesignSystem(id: string): Promise<void> {
  const r = await fetch(`/api/design-systems/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 404) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error ?? `Server returned ${r.status}`);
  }
  if (cache) {
    cache = cache.filter((d) => d.id !== id);
    notifyChange();
  }
}

export function useDesignSystems(): {
  all: DesignSystemSummary[];
  loading: boolean;
} {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick((n) => n + 1);
    window.addEventListener("design-systems:change", refresh);
    return () => window.removeEventListener("design-systems:change", refresh);
  }, []);
  void tick;
  return { all: listDesignSystems(), loading: isLoadingDesignSystems() };
}
