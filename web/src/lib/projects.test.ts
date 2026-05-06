/* projects.test.ts — covers the SWR-style loading flag added for #55.
 *
 * The home page used to flash "No projects yet" on a fresh browser
 * because the in-memory cache was empty until the async /api/projects
 * fetch completed. `isLoadingProjects()` is true only during that
 * window so Projects.tsx can render a skeleton instead.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { isLoadingProjects, listProjects } from "./projects";

// projects.ts holds module-level cache state. Tests need a fresh state
// per case, so we re-import via a query-string trick that bypasses
// Bun's module cache.

let m: typeof import("./projects");
let mockedFetch: typeof globalThis.fetch | null = null;
const origFetch = globalThis.fetch;

function setupDom() {
  const localStore = new Map<string, string>();
  const sessionStore = new Map<string, string>();
  const listeners = new Map<string, Set<EventListener>>();
  // Minimal DOM shim — projects.ts only touches localStorage, sessionStorage,
  // and window.dispatchEvent / addEventListener.
  (globalThis as any).window = {
    addEventListener: (type: string, fn: EventListener) => {
      let s = listeners.get(type);
      if (!s) { s = new Set(); listeners.set(type, s); }
      s.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (e: Event) => {
      listeners.get(e.type)?.forEach((fn) => fn(e));
      return true;
    },
  };
  (globalThis as any).localStorage = {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => localStore.set(k, v),
    removeItem: (k: string) => localStore.delete(k),
    clear: () => localStore.clear(),
  };
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => sessionStore.set(k, v),
    removeItem: (k: string) => sessionStore.delete(k),
    clear: () => sessionStore.clear(),
  };
  (globalThis as any).CustomEvent = class CustomEvent extends Event {
    constructor(type: string, init?: { detail?: unknown }) {
      super(type);
      void init;
    }
  };
  return { listeners };
}

function teardownDom() {
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
  delete (globalThis as any).CustomEvent;
}

beforeEach(async () => {
  setupDom();
  // Bypass module cache so each test gets fresh module state.
  m = await import(`./projects?t=${Date.now()}-${Math.random()}`);
});

afterEach(() => {
  if (mockedFetch) {
    globalThis.fetch = origFetch;
    mockedFetch = null;
  }
  teardownDom();
});

test("fresh browser (empty localStorage): loading=true until first fetch resolves", async () => {
  // Mock /api/projects to return an empty list slowly.
  let resolveFetch: (v: unknown) => void = () => {};
  globalThis.fetch = ((_url: string) =>
    new Promise((resolve) => {
      resolveFetch = resolve;
    })) as typeof fetch;
  mockedFetch = globalThis.fetch;

  // First read triggers boot: localStorage is empty → loading should be true.
  expect(m.isLoadingProjects()).toBe(true);
  expect(m.listProjects()).toEqual([]);

  // Resolve fetch with server-empty.
  resolveFetch({
    ok: true,
    json: async () => [],
  });
  // Microtask + finally flush.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  expect(m.isLoadingProjects()).toBe(false);
});

test("warm cache (localStorage has a project): loading=false from the start", async () => {
  (globalThis as any).localStorage.setItem(
    "projects.v1",
    JSON.stringify({
      projects: [{
        id: "p_demo",
        name: "Demo",
        createdAt: 1,
        updatedAt: 1,
        openTabs: [],
      }],
    }),
  );
  globalThis.fetch = (async () => ({ ok: true, json: async () => [] })) as typeof fetch;
  mockedFetch = globalThis.fetch;

  // Boot reads the cache, sees a non-empty list → loading stays false.
  expect(m.isLoadingProjects()).toBe(false);
  expect(m.listProjects().length).toBe(1);
});

test("network failure on first fetch: loading flips off so empty state can render", async () => {
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  mockedFetch = globalThis.fetch;

  expect(m.isLoadingProjects()).toBe(true);
  // Bounce a couple of microtasks to let the catch+finally run.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(m.isLoadingProjects()).toBe(false);

  // referenced so the compiler keeps the import (esbuild + isolatedModules)
  void listProjects;
});

test("createProject aborts an inflight stale fetchFromServer (CUJ race fix)", async () => {
  // Simulate the race: bootCache fires GET /api/projects on page load.
  // Before that resolves, the user clicks "+ new project" → POST commits,
  // and our cache should NOT get clobbered by the stale GET response
  // (which can't include the new project because it predates the POST).

  type Resolver = (v: { ok: boolean; json: () => Promise<unknown> }) => void;
  const getResolvers: Resolver[] = [];
  const fetchSeenSignals: (AbortSignal | undefined)[] = [];

  globalThis.fetch = ((url: string, init?: { method?: string; signal?: AbortSignal; body?: string }) => {
    fetchSeenSignals.push(init?.signal);
    if (url.includes("/api/projects/create")) {
      // POST — succeeds with new project id
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          id: "p_new",
          manifest: { pages: [{ file: "index.html", label: "index.html" }] },
        }),
      } as unknown as Response);
    }
    // GET /api/projects — return [demo] only, but DELAY resolution
    // until the test releases it (mimics network latency).
    return new Promise<Response>((resolve) => {
      getResolvers.push(resolve as unknown as Resolver);
    }) as unknown as Promise<Response>;
  }) as typeof fetch;
  mockedFetch = globalThis.fetch;

  // First read kicks off bootCache → triggers the inflight GET.
  expect(m.listProjects()).toEqual([]);
  expect(m.isLoadingProjects()).toBe(true);

  // User creates a project. createProject should call invalidateInflightFetch
  // BEFORE seeding cache so the inflight GET's abort signal fires.
  const created = await m.createProject("CUJ Hello World");
  expect(created.id).toBe("p_new");
  expect(m.listProjects().map((p) => p.id)).toContain("p_new");

  // Now we release the stale GET to resolve. With the fix, the response
  // should be ignored (signal aborted) — cache must still contain p_new.
  const resolveGet = getResolvers.shift();
  if (resolveGet) {
    resolveGet({
      ok: true,
      json: async () => [{
        id: "demo", name: "AI Atelie demo", createdAt: 1, updatedAt: 1,
        pages: [{ file: "index.html", label: "index.html" }],
      }],
    });
  }
  // Microtasks drain.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  // The fix's contract: p_new is still in cache, still active.
  const ids = m.listProjects().map((p) => p.id);
  expect(ids).toContain("p_new");
  // The inflight fetch was passed a signal (proves the AbortController wiring).
  const getSignal = fetchSeenSignals.find((s, i) => i === 0 && s !== undefined);
  expect(getSignal).toBeDefined();
  expect(getSignal!.aborted).toBe(true);
});
