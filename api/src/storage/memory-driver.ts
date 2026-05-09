/* memory-driver.ts — in-RAM StorageDriver. Drives unit tests and is the
 * second proof point for the swap seam: routes that work against the FS
 * driver must work against this one without modification.
 *
 * Not for production. Holds everything in Map<>; data evaporates on
 * process restart.
 */

import { EventEmitter } from "node:events";
import type {
  AppendLog,
  BlobChange,
  BlobDeleteResult,
  BlobReadResult,
  BlobReadTextResult,
  BlobStat,
  BlobStore,
  DesignSystemsScope,
  ETag,
  JsonKv,
  KvChange,
  KvDeleteResult,
  KvGetResult,
  KvPutResult,
  LogEntry,
  ProjectScope,
  SharedScope,
  StorageDriver,
  Unsubscribe,
} from "./driver.ts";
import { STORAGE_INTERFACE_VERSION } from "./driver.ts";

const KEY_RE = /^[a-zA-Z0-9_-]+$/;

let etagCounter = 0;
function nextEtag(): ETag {
  etagCounter++;
  return `W/"mem-${etagCounter.toString(36)}"`;
}

function statOf(size: number): BlobStat {
  return { size, mtime: Date.now(), etag: nextEtag() };
}

/* ─── JsonKv (memory) ────────────────────────────────────────────── */

function createMemoryJsonKv(): JsonKv {
  const store = new Map<string, { value: unknown; etag: ETag }>();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  return {
    async list() { return [...store.keys()].sort(); },

    async get<T>(key: string): Promise<KvGetResult<T>> {
      const entry = store.get(key);
      if (!entry) return { ok: false, reason: "not_found" };
      return { ok: true, value: entry.value as T, etag: entry.etag };
    },

    async put<T>(key: string, value: T, opts?: { ifMatch?: ETag }): Promise<KvPutResult> {
      if (!KEY_RE.test(key)) throw new Error(`Invalid kv key: ${key}`);
      const cur = store.get(key);
      if (opts?.ifMatch) {
        const curEtag = cur?.etag ?? null;
        if (curEtag !== opts.ifMatch) {
          return { ok: false, reason: "conflict", currentEtag: curEtag };
        }
      }
      const etag = nextEtag();
      // Deep clone via JSON round-trip so callers can't mutate stored data.
      store.set(key, { value: JSON.parse(JSON.stringify(value)), etag });
      emitter.emit("change", { type: "put", key } satisfies KvChange);
      return { ok: true, etag };
    },

    async delete(key: string, opts?: { ifMatch?: ETag }): Promise<KvDeleteResult> {
      const cur = store.get(key);
      if (!cur) return { ok: false, reason: "not_found" };
      if (opts?.ifMatch && cur.etag !== opts.ifMatch) {
        return { ok: false, reason: "conflict", currentEtag: cur.etag };
      }
      store.delete(key);
      emitter.emit("change", { type: "delete", key } satisfies KvChange);
      return { ok: true };
    },

    subscribe(listener): Unsubscribe {
      emitter.on("change", listener);
      return () => emitter.off("change", listener);
    },
  };
}

/* ─── BlobStore (memory) ─────────────────────────────────────────── */

function createMemoryBlobStore(): BlobStore & { __destroy(): void } {
  const store = new Map<string, { bytes: Uint8Array; stat: BlobStat }>();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  function normalizePath(path: string): string | null {
    if (typeof path !== "string" || path.length === 0) return null;
    if (path.includes("\0")) return null;
    const cleaned = path.replace(/^\/+/, "");
    for (const seg of cleaned.split("/")) {
      if (seg === "" || seg === "." || seg === "..") return null;
      if (seg.startsWith(".")) return null;
    }
    return cleaned;
  }

  return {
    async exists(path: string) {
      const p = normalizePath(path);
      return p ? store.has(p) : false;
    },

    async stat(path: string) {
      const p = normalizePath(path);
      if (!p) return null;
      const entry = store.get(p);
      return entry ? { ...entry.stat } : null;
    },

    async read(path: string): Promise<BlobReadResult> {
      const p = normalizePath(path);
      if (!p) return { ok: false, reason: "not_found" };
      const entry = store.get(p);
      if (!entry) return { ok: false, reason: "not_found" };
      return { ok: true, bytes: new Uint8Array(entry.bytes), stat: { ...entry.stat } };
    },

    async readText(path: string): Promise<BlobReadTextResult> {
      const p = normalizePath(path);
      if (!p) return { ok: false, reason: "not_found" };
      const entry = store.get(p);
      if (!entry) return { ok: false, reason: "not_found" };
      const text = new TextDecoder().decode(entry.bytes);
      return { ok: true, text, stat: { ...entry.stat } };
    },

    async write(path: string, data: Uint8Array | string) {
      const p = normalizePath(path);
      if (!p) throw new Error(`Invalid blob path: ${path}`);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      const stat = statOf(bytes.byteLength);
      store.set(p, { bytes, stat });
      emitter.emit("change", { type: "put", path: p } satisfies BlobChange);
      return { ok: true as const, stat: { ...stat } };
    },

    async delete(path: string): Promise<BlobDeleteResult> {
      const p = normalizePath(path);
      if (!p) return { ok: false, reason: "not_found" };
      if (!store.has(p)) return { ok: false, reason: "not_found" };
      store.delete(p);
      emitter.emit("change", { type: "delete", path: p } satisfies BlobChange);
      return { ok: true };
    },

    async list(prefix?: string) {
      const norm = prefix ? normalizePath(prefix) : null;
      const out: { path: string; stat: BlobStat }[] = [];
      for (const [path, entry] of store) {
        if (norm) {
          if (path !== norm && !path.startsWith(norm + "/")) continue;
        }
        out.push({ path, stat: { ...entry.stat } });
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      return out;
    },

    subscribe(listener): Unsubscribe {
      emitter.on("change", listener);
      return () => emitter.off("change", listener);
    },

    __destroy() {
      emitter.removeAllListeners();
      store.clear();
    },
  };
}

/* ─── AppendLog (memory) ─────────────────────────────────────────── */

function createMemoryAppendLog(): AppendLog & { __destroy(): void } {
  const entries: LogEntry[] = [];
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  let nextSeq = 1;

  return {
    async append<T = unknown>(items: T[]): Promise<{ lastSeq: number }> {
      const ts = Date.now();
      let last = nextSeq - 1;
      for (const data of items) {
        const e: LogEntry<T> = { seq: nextSeq, ts, data };
        entries.push(e);
        emitter.emit("entry", e);
        last = nextSeq;
        nextSeq++;
      }
      return { lastSeq: last };
    },

    async read<T = unknown>(opts?: { sinceSeq?: number; limit?: number; reverse?: boolean }): Promise<LogEntry<T>[]> {
      let result = entries.slice() as LogEntry<T>[];
      if (opts?.sinceSeq != null) {
        const since = opts.sinceSeq;
        result = result.filter((e) => e.seq > since);
      }
      if (opts?.reverse) result.reverse();
      if (opts?.limit != null) result = result.slice(0, opts.limit);
      return result;
    },

    subscribe<T = unknown>(
      opts: { sinceSeq?: number } | undefined,
      fn: (entry: LogEntry<T>) => void,
    ): Unsubscribe {
      if (opts?.sinceSeq == null) {
        const direct = (e: LogEntry<T>) => fn(e);
        emitter.on("entry", direct);
        return () => emitter.off("entry", direct);
      }

      const since = opts.sinceSeq;
      let stopped = false;
      let replaying = true;
      const buffered: LogEntry<T>[] = [];
      const handler = (e: LogEntry<T>) => {
        if (stopped) return;
        if (replaying) buffered.push(e);
        else fn(e);
      };
      emitter.on("entry", handler);

      // Memory impl: replay synchronously on next microtask so the
      // semantics match the FS impl (some buffering window).
      void Promise.resolve().then(() => {
        if (stopped) return;
        const past = entries.filter((e) => e.seq > since) as LogEntry<T>[];
        let lastSent = since;
        for (const e of past) {
          fn(e);
          if (e.seq > lastSent) lastSent = e.seq;
        }
        for (const e of buffered) {
          if (e.seq > lastSent) fn(e);
        }
        buffered.length = 0;
        replaying = false;
      });

      return () => {
        stopped = true;
        emitter.off("entry", handler);
      };
    },

    async truncateBefore(seq: number): Promise<{ removed: number }> {
      const before = entries.length;
      const remaining = entries.filter((e) => e.seq > seq);
      entries.length = 0;
      entries.push(...remaining);
      return { removed: before - entries.length };
    },

    __destroy() {
      emitter.removeAllListeners();
      entries.length = 0;
    },
  };
}

/* ─── Driver assembly ────────────────────────────────────────────── */

export function createMemoryDriver(): StorageDriver {
  const projects = new Map<string, ProjectScope & { __destroy(): void }>();
  let shared: SharedScope | null = null;
  let designSystems: DesignSystemsScope | null = null;

  function buildProjectScope(): ProjectScope & { __destroy(): void } {
    const meta = createMemoryJsonKv();
    const files = createMemoryBlobStore();
    const history = createMemoryAppendLog();
    return {
      meta,
      files,
      history,
      __destroy() { files.__destroy(); history.__destroy(); },
    };
  }

  return {
    shared(): SharedScope {
      if (!shared) shared = { kv: createMemoryJsonKv() };
      return shared;
    },

    designSystems(): DesignSystemsScope {
      if (!designSystems) designSystems = { kv: createMemoryJsonKv() };
      return designSystems;
    },

    project(id: string): ProjectScope {
      let s = projects.get(id);
      if (s) return s;
      s = buildProjectScope();
      projects.set(id, s);
      return s;
    },

    async listProjectIds(): Promise<string[]> {
      return [...projects.keys()].sort();
    },

    async createProject(id: string): Promise<void> {
      if (!projects.has(id)) projects.set(id, buildProjectScope());
    },

    async deleteProject(id: string): Promise<void> {
      const s = projects.get(id);
      if (!s) return;
      s.__destroy();
      projects.delete(id);
    },

    info() {
      return { name: "memory", version: STORAGE_INTERFACE_VERSION };
    },
  };
}
