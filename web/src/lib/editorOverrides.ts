/* editorOverrides.ts — per-project, per-route inspector style overrides.
 *
 * Data shape: AllOverrides = Record<route, Record<selector, StyleProps>>
 *
 * Storage layers (writes go to all of them; reads come from the first
 * that has data; the disk is the source of truth across browsers):
 *
 *   memory cache  — per-process Map keyed by projectId. The render hot
 *                   path (`applyOverrides`) reads from here so it stays
 *                   sync.
 *   localStorage  — `editor-overrides.v1:<projectId>`. Survives a tab
 *                   reload, hydrates the memory cache on first read.
 *   /api/projects/:id/meta/inspector-overrides — the cross-browser
 *                   source of truth. Pushed with a 250ms debounce
 *                   (see lib/projectMetaSync). Pulled on first read of
 *                   each project to bring stale localStorage up to date.
 *
 * Legacy migration: the previous shape was a single workspace-wide
 * localStorage key `editor-overrides.v1`. On first read we attribute
 * its contents to the active project, write to the per-project key,
 * and drop the legacy key. Cross-project route collisions are absorbed
 * into the active project — a known one-time loss; the legacy key was
 * already buggy in this respect.
 *
 * Inspector "Save" still bakes the visible overrides into
 * `_inspector_edits.css` on disk via the inspector-css route. This
 * module only handles the pre-bake live-preview state.
 */

import { useEffect, useState } from "react";
import { getActiveProject } from "./projects";
import { pullMeta, pushMetaSoon } from "./projectMetaSync";
import { trackEvent } from "./telemetry";

export type StyleProps = Record<string, string>;
export type RouteOverrides = Record<string /* selector */, StyleProps>;
export type AllOverrides = Record<string /* route */, RouteOverrides>;

const LS_PREFIX = "editor-overrides.v1:";
const LEGACY_KEY = "editor-overrides.v1";
const META_KEY = "inspector-overrides";

const cache = new Map<string, AllOverrides>();
const hydrated = new Set<string>();

function lsKey(projectId: string): string {
  return LS_PREFIX + projectId;
}

function readLocalStorageFor(projectId: string): AllOverrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(lsKey(projectId));
    if (raw) return JSON.parse(raw) as AllOverrides;
  } catch { /* ignore */ }
  // Legacy migration: hoist the workspace-wide key into this project's
  // bucket. Done once; the legacy key gets removed.
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const data = JSON.parse(legacy) as AllOverrides;
      try {
        localStorage.setItem(lsKey(projectId), legacy);
        localStorage.removeItem(LEGACY_KEY);
      } catch { /* ignore */ }
      return data;
    }
  } catch { /* ignore */ }
  return {};
}

function writeLocalStorageFor(projectId: string, all: AllOverrides): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(lsKey(projectId), JSON.stringify(all)); }
  catch { /* ignore */ }
}

function getProjectId(): string {
  return getActiveProject()?.id ?? "";
}

/** First-time fetch of disk state for `projectId`. Updates the cache +
 *  localStorage if disk has newer data; fires a change event so any
 *  subscribed UI re-reads. */
function hydrateFromDisk(projectId: string): void {
  if (!projectId) return;
  if (hydrated.has(projectId)) return;
  hydrated.add(projectId);
  if (typeof window === "undefined") return;
  void pullMeta<AllOverrides>(projectId, META_KEY).then((data) => {
    if (!data || typeof data !== "object") return;
    cache.set(projectId, data);
    writeLocalStorageFor(projectId, data);
    try { window.dispatchEvent(new CustomEvent("editor-overrides:change")); }
    catch { /* ignore */ }
  });
}

export function readAll(): AllOverrides {
  const projectId = getProjectId();
  if (!projectId) return {};
  let data = cache.get(projectId);
  if (!data) {
    data = readLocalStorageFor(projectId);
    cache.set(projectId, data);
    hydrateFromDisk(projectId);
  }
  return data;
}

export function writeAll(all: AllOverrides) {
  const projectId = getProjectId();
  if (!projectId) return;
  cache.set(projectId, all);
  writeLocalStorageFor(projectId, all);
  pushMetaSoon(projectId, META_KEY, all);
  if (typeof window !== "undefined") {
    try { window.dispatchEvent(new CustomEvent("editor-overrides:change")); }
    catch { /* ignore */ }
  }
}

export function readRoute(route: string): RouteOverrides {
  return readAll()[route] ?? {};
}

export function setOverride(route: string, selector: string, prop: string, value: string) {
  const all = readAll();
  const r = all[route] ?? {};
  const sel = r[selector] ?? {};
  if (value === "") delete sel[prop];
  else sel[prop] = value;
  if (Object.keys(sel).length === 0) delete r[selector];
  else r[selector] = sel;
  if (Object.keys(r).length === 0) delete all[route];
  else all[route] = r;
  writeAll(all);
  trackEvent("override_apply", { route, prop });
}

export function clearRoute(route: string) {
  const all = readAll();
  delete all[route];
  writeAll(all);
  trackEvent("override_clear", { route });
}

/** Subscribe to the count of overrides for a single route. Re-reads on
 *  every `editor-overrides:change` event (fired by writeAll) AND on
 *  `projects:change` (so a project switch refreshes the count). */
export function useOverrideCount(route: string): number {
  const [count, setCount] = useState(() => Object.keys(readRoute(route)).length);
  useEffect(() => {
    const recompute = () => setCount(Object.keys(readRoute(route)).length);
    recompute();
    window.addEventListener("editor-overrides:change", recompute);
    window.addEventListener("projects:change", recompute);
    return () => {
      window.removeEventListener("editor-overrides:change", recompute);
      window.removeEventListener("projects:change", recompute);
    };
  }, [route]);
  return count;
}

/** Set of routes that currently have at least one inspector override for
 *  the active project. Drives the dirty-mark on each tab in the strip
 *  without forcing a per-tab subscription. Reactive on both override
 *  changes and project switches. */
export function useDirtyRoutes(): Set<string> {
  const [dirty, setDirty] = useState<Set<string>>(() => new Set(Object.keys(readAll())));
  useEffect(() => {
    const recompute = () => setDirty(new Set(Object.keys(readAll())));
    recompute();
    window.addEventListener("editor-overrides:change", recompute);
    window.addEventListener("projects:change", recompute);
    return () => {
      window.removeEventListener("editor-overrides:change", recompute);
      window.removeEventListener("projects:change", recompute);
    };
  }, []);
  return dirty;
}

// Apply every override for a given route to its document. Used on iframe load.
export function applyOverrides(doc: Document, route: string) {
  const r = readRoute(route);
  for (const [selector, props] of Object.entries(r)) {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (!el) continue;
    for (const [k, v] of Object.entries(props)) {
      // setProperty handles kebab-case ("border-radius"). Priority must
      // be "important" so the live preview beats _inspector_edits.css —
      // that file uses !important to beat source rules, and an inline
      // style without !important loses the cascade duel.
      el.style.setProperty(k, v, "important");
    }
  }
}
