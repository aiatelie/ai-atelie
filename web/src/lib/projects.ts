/* projects.ts — multi-project workspace registry.
 *
 * Two storage layers:
 *
 *   Server  (`web/projects/<id>/manifest.json`)  → id, name, createdAt,
 *           updatedAt, pages. **Source of truth** for "what projects exist."
 *           Listed via GET /api/projects.
 *
 *   Browser (`localStorage["projects.v1"]`)       → SWR-style cache of
 *           the project list (for fast first paint) plus the
 *           genuinely-device-local per-project openTabs/activeTabId
 *           UX state. `activeProjectId` is per-tab via sessionStorage.
 *
 * Boot sequence:
 *   1. localStorage cache → in-memory `cache` (sync, for immediate render).
 *   2. fetch /api/projects → merge into cache, fire `projects:change`.
 *   3. SSE `/api/__shared-events` "projects" → re-fetch on remote changes.
 *
 * `useProjects().loading` is true only on the first paint when there's no
 * localStorage cache yet, so a fresh browser shows a skeleton instead of
 * the misleading "No projects yet" empty state — closes #55.
 */

import { useEffect, useState } from "react";
import { subscribeSharedMeta } from "./metaEvents";
import { trackEvent } from "./telemetry";

export type Viewport = { w: number; h: number; preset?: string };
export type DisplayMode = "fill" | "frame";

export type ProjectTab = {
  id: string;
  label: string;
  route: string;
  display: DisplayMode;
  viewport?: Viewport;
};

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Tabs the user has open in this browser for this project. */
  openTabs: ProjectTab[];
  /** Active tab id (within openTabs). */
  activeTabId?: string;
};

type Store = {
  projects: Project[];
  activeProjectId: string;
};

type ServerProject = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pages: Array<{ file: string; label: string; title?: string }>;
};

const KEY = "projects.v1";
// activeProjectId is per-TAB, not per-browser — open project A in one
// tab and project B in another, they should stay independent. Moved
// out of localStorage into sessionStorage so a `setActiveProject` in
// one tab doesn't fire a cross-tab `storage` event that yanks every
// other tab onto the same project.
const ACTIVE_KEY = "projects.activeId";
const LEGACY_PROJECT_ID = "cc_remix";

function uuid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/* ─── Storage I/O ─────────────────────────────────────────────── */

function readActiveId(): string {
  if (typeof window === "undefined") return "";
  try { return sessionStorage.getItem(ACTIVE_KEY) ?? ""; }
  catch { return ""; }
}

function writeActiveId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    if (id) sessionStorage.setItem(ACTIVE_KEY, id);
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch { /* ignore */ }
}

function read(): Store | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Store> & { activeProjectId?: string };
    // Migration: older versions persisted activeProjectId in localStorage.
    // If we find one here, seed sessionStorage with it (only for this
    // tab's first read) and strip it from the disk shape on the next
    // write. New tabs default to the first project until the user
    // explicitly switches — they won't inherit a cross-tab choice.
    if (typeof parsed?.activeProjectId === "string" && !readActiveId()) {
      writeActiveId(parsed.activeProjectId);
    }
    return {
      projects: Array.isArray(parsed?.projects) ? (parsed.projects as Project[]) : [],
      activeProjectId: readActiveId(),
    };
  } catch { return null; }
}

function write(store: Store) {
  try {
    // Persist only the project LIST in localStorage (shared across tabs
    // as a cache; the server is the source of truth). activeProjectId
    // is per-tab via sessionStorage.
    localStorage.setItem(KEY, JSON.stringify({ projects: store.projects }));
  } catch { /* ignore */ }
  writeActiveId(store.activeProjectId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("projects:change"));
  }
}

/* ─── Legacy URL reconciliation (pre-sandbox SPA routes) ─────── */

const SPA_TO_SANDBOX: Record<string, { route: string; label: string; display: DisplayMode }> = {
  "/":                   { route: "index.html",            label: "index.html",            display: "frame" },
  "/titling":            { route: "Titling System.html",   label: "Titling System.html",   display: "fill" },
  "/ep/01/thumbnail":    { route: "01 Thumbnail.html",     label: "01 Thumbnail.html",     display: "frame" },
  "/ep/02/opener":       { route: "02 Opening Title.html", label: "02 Opening Title.html", display: "frame" },
  "/ep/03/chapter":      { route: "03 Chapter Intro.html", label: "03 Chapter Intro.html", display: "frame" },
  "/ep/04/lower":        { route: "04 Lower Third.html",   label: "04 Lower Third.html",   display: "frame" },
  "/ep/05/stamp":        { route: "05 Location Stamp.html",label: "05 Location Stamp.html",display: "frame" },
  "/inspirations":       { route: "index.html",            label: "index.html",            display: "frame" },
};

// Migration check for projects created under the previous name.
// Recognized literally so existing local stores still get reconciled.
const LEGACY_PROJECT_NAME = "Content Creator Remix";

function reconcileLegacyTabs(s: Store): Store {
  let dirty = false;
  const projects = s.projects.map((p) => {
    const isLegacyByName = p.name === LEGACY_PROJECT_NAME;
    const isLegacyByTabs = p.openTabs.some((t) =>
      t.route === "Titling System.html" ||
      t.route === "01 Thumbnail.html" ||
      t.route === "/titling" ||
      t.route === "/ep/01/thumbnail"
    );
    let nextId = p.id;
    if (p.id !== LEGACY_PROJECT_ID && (isLegacyByName || isLegacyByTabs)) {
      nextId = LEGACY_PROJECT_ID;
      dirty = true;
    }

    const remappedTabs: ProjectTab[] = [];
    for (const t of p.openTabs) {
      const known = SPA_TO_SANDBOX[t.route];
      if (known) {
        remappedTabs.push({ ...t, route: known.route, label: known.label, display: known.display });
        dirty = true;
        continue;
      }
      if (t.route.startsWith("/")) { dirty = true; continue; }
      remappedTabs.push(t);
    }
    if (nextId === p.id && remappedTabs.length === p.openTabs.length && !dirty) return p;
    const activeId = remappedTabs.find((t) => t.id === p.activeTabId)?.id ?? remappedTabs[0]?.id;
    return { ...p, id: nextId, openTabs: remappedTabs, activeTabId: activeId };
  });

  const byId = new Map<string, Project>();
  for (const p of projects) {
    const existing = byId.get(p.id);
    if (!existing || p.openTabs.length > existing.openTabs.length) byId.set(p.id, p);
  }
  const deduped = Array.from(byId.values());
  const collapsed = deduped.length !== projects.length;

  let activeProjectId = s.activeProjectId;
  const activeRewriteSrc = s.projects.find((p) => p.id === s.activeProjectId);
  if (activeRewriteSrc && activeRewriteSrc.name === LEGACY_PROJECT_NAME) {
    activeProjectId = LEGACY_PROJECT_ID;
  }

  return (dirty || collapsed) ? { projects: deduped, activeProjectId } : s;
}

/* ─── Cache + server sync ─────────────────────────────────────── */

let cache: Store | null = null;
let serverFetchInflight: Promise<void> | null = null;
/** Aborts the inflight `fetchFromServer` so a stale GET (sent before
 *  a local createProject/deleteProject committed) can't overwrite the
 *  cache. createProject/deleteProject call `invalidateInflightFetch()`
 *  before they seed cache. Without this, the CUJ flake on a fresh
 *  browser (race between bootCache's GET and createProject's POST)
 *  resets the active project to whatever was on the server first. */
let serverFetchAborter: AbortController | null = null;
let sharedSubscribed = false;
/** True from the moment bootCache() runs against an empty localStorage
 *  until the first /api/projects fetch resolves (success or failure).
 *  Read by useProjects().loading so the home page renders a skeleton
 *  instead of "No projects yet" on a fresh browser. */
let firstFetchPending = false;

function ensureSubscribed() {
  if (typeof window === "undefined") return;
  if (sharedSubscribed) return;
  sharedSubscribed = true;
  subscribeSharedMeta((data) => {
    if (data === "projects") void fetchFromServer();
  });
}

function tabsFromManifestPages(pages: ServerProject["pages"]): ProjectTab[] {
  return pages.map((pg) => ({
    id: uuid(),
    label: pg.label ?? pg.file,
    route: pg.file,
    display: "frame" as const,
  }));
}

/** Merge server-side project list with locally-stored tab state. */
function mergeServerWithLocal(server: ServerProject[]): Store {
  const local = read();
  const localById = new Map<string, Project>(local?.projects.map((p) => [p.id, p]) ?? []);

  const merged: Project[] = server.map((sp) => {
    const lp = localById.get(sp.id);
    if (lp) {
      return {
        id: sp.id,
        name: sp.name,
        createdAt: sp.createdAt,
        updatedAt: sp.updatedAt,
        openTabs: lp.openTabs,
        activeTabId: lp.activeTabId,
      };
    }
    const tabs = tabsFromManifestPages(sp.pages);
    return {
      id: sp.id,
      name: sp.name,
      createdAt: sp.createdAt,
      updatedAt: sp.updatedAt,
      openTabs: tabs,
      activeTabId: tabs[0]?.id,
    };
  });

  let activeProjectId = local?.activeProjectId ?? "";
  if (!merged.find((p) => p.id === activeProjectId)) {
    activeProjectId = merged[0]?.id ?? "";
  }
  return { projects: merged, activeProjectId };
}

async function fetchFromServer(): Promise<void> {
  if (serverFetchInflight) return serverFetchInflight;
  const aborter = new AbortController();
  serverFetchAborter = aborter;
  serverFetchInflight = (async () => {
    try {
      const r = await fetch("/api/projects", { signal: aborter.signal });
      if (!r.ok || aborter.signal.aborted) return;
      const list = (await r.json()) as ServerProject[];
      // Re-check after the JSON parse — invalidate could have fired
      // while we were awaiting the body.
      if (aborter.signal.aborted) return;
      const merged = mergeServerWithLocal(list);
      cache = merged;
      write(merged);
    } catch (err) {
      // Aborted fetches throw; that's expected — silently ignore.
      if (err instanceof Error && err.name === "AbortError") return;
      // Other errors: offline, parse failure. Already silent.
    } finally {
      // Only clear the singleton if WE own the current aborter — a fresh
      // invalidation may have already queued a new fetch on top of us.
      if (serverFetchAborter === aborter) {
        serverFetchInflight = null;
        serverFetchAborter = null;
      }
      // First-fetch flips off whether the request succeeded or failed —
      // an offline / 500 first paint should fall through to the empty
      // state rather than spin a skeleton forever.
      if (firstFetchPending) {
        firstFetchPending = false;
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("projects:change"));
        }
      }
    }
  })();
  return serverFetchInflight;
}

/** Cancel any inflight `fetchFromServer`. Used by createProject and
 *  deleteProject to discard responses to GETs that were sent before
 *  the local mutation committed — those responses don't include the
 *  mutation and would clobber the just-seeded cache. */
function invalidateInflightFetch(): void {
  if (serverFetchAborter) {
    serverFetchAborter.abort();
    serverFetchAborter = null;
    serverFetchInflight = null;
  }
}

/** Initialize the in-memory cache from localStorage, healing any
 *  pre-sandbox SPA routes still lying around. Then async-fetch from
 *  the server to fill in projects we don't know about. */
function bootCache(): Store {
  if (cache) return cache;
  const cur = read();
  if (cur && cur.projects.length > 0) {
    cache = reconcileLegacyTabs(cur);
    if (cache !== cur) write(cache);
  } else {
    cache = { projects: [], activeProjectId: "" };
    // Only mark loading when we genuinely don't know yet. A localStorage
    // store with zero projects means the user is up to date — the server
    // is also empty unless they touched another browser.
    firstFetchPending = true;
  }
  if (typeof window !== "undefined") {
    void fetchFromServer();
    ensureSubscribed();
  }
  return cache;
}

export function getStore(): Store { return bootCache(); }

export function listProjects(): Project[] { return bootCache().projects; }

/** True only on the first paint of a fresh browser (no localStorage
 *  cache) until the first /api/projects fetch resolves. Used by the
 *  home page to render a skeleton instead of the empty state. */
export function isLoadingProjects(): boolean {
  bootCache();
  return firstFetchPending;
}

/** May return null when there are no projects yet. */
export function getActiveProject(): Project | null {
  const s = bootCache();
  if (s.projects.length === 0) return null;
  return s.projects.find((p) => p.id === s.activeProjectId) ?? s.projects[0];
}

export function setActiveProject(id: string) {
  const s = bootCache();
  if (!s.projects.find((p) => p.id === id)) return;
  cache = { ...s, activeProjectId: id };
  write(cache);
  trackEvent("project_switch", {}, id);
}

/** Pull a project that exists on the server but isn't in the cache.
 *  Used by direct-URL access to /projects/:id/start. */
export async function hydrateProjectFromServer(id: string): Promise<Project | null> {
  const existing = bootCache().projects.find((p) => p.id === id);
  if (existing) return existing;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(id)}/manifest`);
    if (!r.ok) return null;
    const manifest = await r.json() as ServerProject;
    if (manifest.id !== id) return null;
    // Re-fetch the full list so the SSE-less browser also sees changes.
    await fetchFromServer();
    const after = bootCache().projects.find((p) => p.id === id);
    if (after) {
      // Make this the active project by default — matches old behavior.
      setActiveProject(id);
      trackEvent("project_hydrate", { name: after.name }, id);
    }
    return after ?? null;
  } catch { return null; }
}

/** Create a sandbox project. The server scaffolds the directory and
 *  returns the manifest; we add the merged Project to the cache.
 *
 *  Calls `invalidateInflightFetch()` BEFORE seeding cache so any
 *  fetchFromServer started before this POST (e.g. bootCache's GET on
 *  page load) can't return its stale [demo,…] list and clobber the
 *  newly-created project out of cache. Without this guard the CUJ
 *  bounces a fresh-browser test off into the demo project's editor
 *  because mergeServerWithLocal drops local-only projects. */
export async function createProject(name: string, activeSkills?: string[]): Promise<Project> {
  // activeSkills is optional — when omitted, the API picks a sensible
  // default (all aesthetic skills checked). When the user makes an
  // explicit choice in NewProjectForm, we pass it through so the
  // manifest captures their initial intent.
  const body: { name: string; active_skills?: string[] } = { name };
  if (activeSkills) body.active_skills = activeSkills;
  const r = await fetch("/api/projects/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error ?? `Server returned ${r.status}`);
  }
  const { id, manifest } = (await r.json()) as { id: string; manifest: { pages: Array<{ file: string; label: string }> } };
  const tabs: ProjectTab[] = manifest.pages.map((pg) => ({
    id: uuid(),
    label: pg.label,
    route: pg.file,
    display: "frame",
  }));
  const now = Date.now();
  const p: Project = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    openTabs: tabs,
    activeTabId: tabs[0]?.id,
  };
  // Discard any inflight stale GET before we mutate cache + sessionStorage.
  invalidateInflightFetch();
  const s = bootCache();
  cache = { projects: [...s.projects, p], activeProjectId: p.id };
  write(cache);
  trackEvent("project_create", { name }, p.id);
  return p;
}

/** Delete a project. Removes from cache optimistically, then DELETEs the
 *  on-disk dir. If the server call fails, we re-fetch the canonical list
 *  so the UI doesn't lie about a project that's still there — silent
 *  fire-and-forget would mean the project resurrects on next refresh
 *  with no explanation. */
export function deleteProject(id: string) {
  const s = bootCache();
  const removed = s.projects.find((p) => p.id === id);
  if (!removed) return;
  const next = s.projects.filter((p) => p.id !== id);
  const activeId = s.activeProjectId === id ? (next[0]?.id ?? "") : s.activeProjectId;
  // Same race guard as createProject: drop any inflight stale GET so a
  // response that still contains the just-deleted project can't add it
  // back to cache.
  invalidateInflightFetch();
  cache = { projects: next, activeProjectId: activeId };
  write(cache);
  trackEvent("project_delete", {}, id);
  fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" })
    .then(async (r) => {
      // 404 = already gone (idempotent); anything else 4xx/5xx = real failure.
      if (r.ok || r.status === 404) return;
      const detail = await r.json().catch(() => ({}));
      throw new Error(detail.error ?? `Server returned ${r.status}`);
    })
    .catch((err) => {
      console.error(`[deleteProject] ${id} failed:`, err);
      // Pull truth from the server so the resurrected project appears
      // again instead of staying ghosted in the UI.
      void fetchFromServer();
    });
}

/** Update a project. Tab/active-tab edits stay local; renames go to
 *  the server (PATCH /manifest) so other browsers see them. */
export function updateProject(id: string, patch: Partial<Project> | ((p: Project) => Partial<Project>)) {
  const s = bootCache();
  const cur = s.projects.find((p) => p.id === id);
  if (!cur) return;
  const apply = typeof patch === "function" ? patch(cur) : patch;
  cache = {
    ...s,
    projects: s.projects.map((p) => (p.id === id ? { ...p, ...apply, updatedAt: Date.now() } : p)),
  };
  write(cache);
  // Server-side fields (only `name` for now) need a manifest PATCH so
  // they cross browsers. Fire-and-forget; failures are silent because
  // the local view is already updated and the server SSE will re-sync.
  if (typeof apply.name === "string" && apply.name !== cur.name) {
    fetch(`/api/projects/${encodeURIComponent(id)}/manifest`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: apply.name }),
    }).catch(() => { /* ignore */ });
  }
}

/* ─── React hook ──────────────────────────────────────────────── */

export function useProjects(): { all: Project[]; active: Project | null; loading: boolean } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick((n) => n + 1);
    // We deliberately do NOT listen to the `storage` event here. Cross-
    // tab project-list updates flow through the SSE path (subscribeShared
    // → fetchFromServer), and `activeProjectId` is per-tab via
    // sessionStorage — listening to `storage` would yank one tab onto
    // whatever project another tab just opened, which is the bug.
    window.addEventListener("projects:change", refresh);
    return () => {
      window.removeEventListener("projects:change", refresh);
    };
  }, []);
  void tick;
  return { all: listProjects(), active: getActiveProject(), loading: isLoadingProjects() };
}

export const _internal = { uuid };
