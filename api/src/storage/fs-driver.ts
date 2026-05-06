/* fs-driver.ts — filesystem implementation of StorageDriver.
 *
 * Mirrors the byte-level layout the app already uses:
 *   PROJECTS_ROOT/<id>/manifest.json + source files + uploads/  → BlobStore
 *   PROJECTS_ROOT/<id>/.meta/<key>.json                         → JsonKv
 *   SHARED_ROOT/<key>.json                                      → JsonKv (shared)
 *
 * Behavior is byte-identical to pre-refactor: same atomic-write pattern
 * (tmp + rename), same `W/"<base36-mtime>"` ETags, same fs.watch debounce
 * for the reload channel. The interface adds change events on JsonKv
 * (previously broadcast manually from route handlers).
 */

import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import type {
  AppendLog,
  BlobChange,
  BlobDeleteResult,
  BlobReadResult,
  BlobReadTextResult,
  BlobStat,
  BlobStore,
  ETag,
  JsonKv,
  KvChange,
  KvDeleteResult,
  KvGetResult,
  KvPutResult,
  ProjectScope,
  SharedScope,
  StorageDriver,
  Unsubscribe,
} from "./driver.ts";
import { STORAGE_INTERFACE_VERSION } from "./driver.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const KEY_RE = /^[a-zA-Z0-9_-]+$/;

export type FsDriverOptions = {
  projectsRoot: string;
  sharedRoot: string;
  /** Reload-channel debounce window — coalesces fs.watch bursts so the
   *  iframe doesn't reload mid-write. Mirrors current 250ms. */
  reloadDebounceMs?: number;
};

/* ─── Helpers ────────────────────────────────────────────────────── */

function etagFromMtime(mtimeMs: number): ETag {
  return `W/"${Math.floor(mtimeMs).toString(36)}"`;
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

/** Path traversal guard for BlobStore. Rejects absolute paths, `..`,
 *  null bytes, and any segment that starts with `.` (so `.meta/*` is
 *  invisible — those live on JsonKv). */
function safeBlobPath(root: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0) return null;
  if (rel.includes("\0")) return null;
  const cleaned = rel.replace(/^\/+/, "");
  for (const seg of cleaned.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.startsWith(".")) return null;
  }
  const abs = resolvePath(root, cleaned);
  if (!isInside(root, abs)) return null;
  return abs;
}

async function atomicWriteFile(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  if (typeof data === "string") {
    await writeFile(tmp, data, "utf8");
  } else {
    await writeFile(tmp, data);
  }
  await rename(tmp, path);
}

async function statOrNull(path: string): Promise<BlobStat | null> {
  try {
    const st = await stat(path);
    return { size: st.size, mtime: st.mtimeMs, etag: etagFromMtime(st.mtimeMs) };
  } catch { return null; }
}

/* ─── JsonKv (filesystem) ────────────────────────────────────────── */

function createFsJsonKv(rootDir: string): JsonKv {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  function pathFor(key: string): string | null {
    if (!KEY_RE.test(key)) return null;
    return resolvePath(rootDir, `${key}.json`);
  }

  return {
    async list(): Promise<string[]> {
      const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
      const keys: string[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!e.name.endsWith(".json")) continue;
        const key = e.name.slice(0, -5);
        if (!KEY_RE.test(key)) continue;
        keys.push(key);
      }
      keys.sort();
      return keys;
    },

    async get<T = unknown>(key: string): Promise<KvGetResult<T>> {
      const path = pathFor(key);
      if (!path) return { ok: false, reason: "not_found" };
      const st = await statOrNull(path);
      if (!st) return { ok: false, reason: "not_found" };
      try {
        const raw = await readFile(path, "utf8");
        const value = JSON.parse(raw) as T;
        return { ok: true, value, etag: st.etag };
      } catch {
        return { ok: false, reason: "not_found" };
      }
    },

    async put<T = unknown>(
      key: string,
      value: T,
      opts?: { ifMatch?: ETag },
    ): Promise<KvPutResult> {
      const path = pathFor(key);
      if (!path) throw new Error(`Invalid kv key: ${key}`);
      if (opts?.ifMatch) {
        const cur = await statOrNull(path);
        const curEtag = cur?.etag ?? null;
        if (curEtag !== opts.ifMatch) {
          return { ok: false, reason: "conflict", currentEtag: curEtag };
        }
      }
      await atomicWriteFile(path, JSON.stringify(value));
      const st = await statOrNull(path);
      const etag = st?.etag ?? etagFromMtime(Date.now());
      emitter.emit("change", { type: "put", key } satisfies KvChange);
      return { ok: true, etag };
    },

    async delete(
      key: string,
      opts?: { ifMatch?: ETag },
    ): Promise<KvDeleteResult> {
      const path = pathFor(key);
      if (!path) return { ok: false, reason: "not_found" };
      const cur = await statOrNull(path);
      if (!cur) return { ok: false, reason: "not_found" };
      if (opts?.ifMatch && cur.etag !== opts.ifMatch) {
        return { ok: false, reason: "conflict", currentEtag: cur.etag };
      }
      try { await unlink(path); }
      catch { return { ok: false, reason: "not_found" }; }
      emitter.emit("change", { type: "delete", key } satisfies KvChange);
      return { ok: true };
    },

    subscribe(listener): Unsubscribe {
      emitter.on("change", listener);
      return () => emitter.off("change", listener);
    },
  };
}

/* ─── BlobStore (filesystem) ─────────────────────────────────────── */

type BlobChannel = {
  emitter: EventEmitter;
  watcher: ReturnType<typeof watch> | null;
  debounce: ReturnType<typeof setTimeout> | null;
  refcount: number;
};

function createFsBlobStore(rootDir: string, opts: { reloadDebounceMs: number }): BlobStore & { __destroy(): void } {
  const channel: BlobChannel = {
    emitter: new EventEmitter(),
    watcher: null,
    debounce: null,
    refcount: 0,
  };
  channel.emitter.setMaxListeners(0);

  function ensureWatcher() {
    if (channel.watcher) return;
    try {
      channel.watcher = watch(rootDir, { recursive: true }, (_evt, filename) => {
        if (typeof filename !== "string") return;
        const seg0 = filename.split(/[\\/]/)[0];
        // .meta/* lives on JsonKv — its events come through that channel.
        if (seg0 === ".meta") return;
        if (seg0.startsWith(".")) return;
        if (channel.debounce) clearTimeout(channel.debounce);
        channel.debounce = setTimeout(() => {
          // We don't know what changed precisely (recursive watch coalesces);
          // emit a coarse "put" with the filename so subscribers can react.
          channel.emitter.emit("change", { type: "put", path: filename } satisfies BlobChange);
        }, opts.reloadDebounceMs);
      });
    } catch {
      // Project dir might be ephemeral or freshly created; the next
      // ensureWatcher() call will retry.
    }
  }

  async function* walk(absDir: string, prefix: string): AsyncGenerator<{ abs: string; rel: string }> {
    const items = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const it of items) {
      if (it.name.startsWith(".")) continue;
      if (it.name === "node_modules") continue;
      const abs = join(absDir, it.name);
      const rel = prefix ? prefix + "/" + it.name : it.name;
      if (it.isDirectory()) yield* walk(abs, rel);
      else if (it.isFile()) yield { abs, rel };
    }
  }

  return {
    async exists(path: string): Promise<boolean> {
      const safe = safeBlobPath(rootDir, path);
      if (!safe) return false;
      return stat(safe).then(() => true).catch(() => false);
    },

    async stat(path: string): Promise<BlobStat | null> {
      const safe = safeBlobPath(rootDir, path);
      if (!safe) return null;
      return statOrNull(safe);
    },

    async read(path: string): Promise<BlobReadResult> {
      const safe = safeBlobPath(rootDir, path);
      if (!safe) return { ok: false, reason: "not_found" };
      const st = await statOrNull(safe);
      if (!st) return { ok: false, reason: "not_found" };
      try {
        const buf = await readFile(safe);
        return { ok: true, bytes: new Uint8Array(buf), stat: st };
      } catch {
        return { ok: false, reason: "not_found" };
      }
    },

    async readText(path: string): Promise<BlobReadTextResult> {
      const safe = safeBlobPath(rootDir, path);
      if (!safe) return { ok: false, reason: "not_found" };
      const st = await statOrNull(safe);
      if (!st) return { ok: false, reason: "not_found" };
      try {
        const text = await readFile(safe, "utf8");
        return { ok: true, text, stat: st };
      } catch {
        return { ok: false, reason: "not_found" };
      }
    },

    async write(path: string, data: Uint8Array | string): Promise<{ ok: true; stat: BlobStat }> {
      const safe = safeBlobPath(rootDir, path);
      if (!safe) throw new Error(`Invalid blob path: ${path}`);
      await atomicWriteFile(safe, data);
      const st = await statOrNull(safe);
      if (!st) throw new Error(`Wrote blob but stat failed: ${path}`);
      // Don't emit synthetically — fs.watch is the canonical source so
      // out-of-band writes (agent CLI editing source files directly)
      // and in-band writes both arrive on the same channel.
      return { ok: true, stat: st };
    },

    async delete(path: string): Promise<BlobDeleteResult> {
      const safe = safeBlobPath(rootDir, path);
      if (!safe) return { ok: false, reason: "not_found" };
      try { await unlink(safe); }
      catch { return { ok: false, reason: "not_found" }; }
      // fs.watch fires the event.
      return { ok: true };
    },

    async list(prefix?: string): Promise<{ path: string; stat: BlobStat }[]> {
      const startDir = prefix
        ? safeBlobPath(rootDir, prefix) ?? rootDir
        : rootDir;
      const startRel = prefix
        ? (safeBlobPath(rootDir, prefix) ? prefix.replace(/^\/+/, "").replace(/\/+$/, "") : "")
        : "";
      const out: { path: string; stat: BlobStat }[] = [];
      const startStat = await statOrNull(startDir);
      if (!startStat) return out;
      // If `prefix` points to a single file, return just it.
      if (startStat.size >= 0) {
        const isDir = await stat(startDir).then(s => s.isDirectory()).catch(() => false);
        if (!isDir) {
          out.push({ path: startRel, stat: startStat });
          return out;
        }
      }
      for await (const { abs, rel } of walk(startDir, startRel)) {
        const st = await statOrNull(abs);
        if (st) out.push({ path: rel, stat: st });
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      return out;
    },

    subscribe(listener): Unsubscribe {
      ensureWatcher();
      channel.refcount++;
      channel.emitter.on("change", listener);
      return () => {
        channel.emitter.off("change", listener);
        channel.refcount--;
        // Don't tear down the watcher on refcount=0; reload SSE clients
        // come and go and re-attaching the watcher every time would miss
        // events during the gap. Watcher is torn down on deleteProject().
      };
    },

    __destroy() {
      try { channel.watcher?.close(); } catch { /* ignore */ }
      if (channel.debounce) clearTimeout(channel.debounce);
      channel.emitter.removeAllListeners();
      channel.watcher = null;
      channel.debounce = null;
    },
  };
}

/* ─── AppendLog (stub — implemented in PR 2) ─────────────────────── */

function createStubAppendLog(): AppendLog {
  function notImpl(): never {
    throw new Error("AppendLog: filesystem driver does not implement this primitive yet (lands in PR 2).");
  }
  return {
    async append() { notImpl(); },
    async read() { notImpl(); },
    subscribe() { notImpl(); },
  };
}

/* ─── Driver assembly ────────────────────────────────────────────── */

export function createFsDriver(opts: FsDriverOptions): StorageDriver {
  const projectsRoot = resolvePath(opts.projectsRoot);
  const sharedRoot = resolvePath(opts.sharedRoot);
  const reloadDebounceMs = opts.reloadDebounceMs ?? 250;

  // Lazy per-project caches. Created on first project(id) call.
  const projectScopes = new Map<string, ProjectScope & { __destroy(): void }>();

  // Shared scope is process-singleton.
  let sharedScope: SharedScope | null = null;

  function projectDir(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid project id: ${id}`);
    const abs = resolvePath(projectsRoot, id);
    if (!isInside(projectsRoot, abs)) throw new Error(`Project id resolves outside projectsRoot: ${id}`);
    return abs;
  }

  function buildProjectScope(id: string): ProjectScope & { __destroy(): void } {
    const dir = projectDir(id);
    const meta = createFsJsonKv(resolvePath(dir, ".meta"));
    const files = createFsBlobStore(dir, { reloadDebounceMs });
    const history = createStubAppendLog();
    return {
      meta,
      files,
      history,
      __destroy() { files.__destroy(); },
    };
  }

  return {
    shared(): SharedScope {
      if (!sharedScope) {
        sharedScope = { kv: createFsJsonKv(sharedRoot) };
      }
      return sharedScope;
    },

    project(id: string): ProjectScope {
      let s = projectScopes.get(id);
      if (s) return s;
      s = buildProjectScope(id);
      projectScopes.set(id, s);
      return s;
    },

    async listProjectIds(): Promise<string[]> {
      const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
      const ids: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
        ids.push(e.name);
      }
      return ids;
    },

    async createProject(id: string): Promise<void> {
      const dir = projectDir(id);
      await mkdir(dir, { recursive: true });
      await mkdir(resolvePath(dir, "uploads"), { recursive: true });
      // Don't pre-create .meta — JsonKv creates it on first put().
    },

    async deleteProject(id: string): Promise<void> {
      const dir = projectDir(id);
      if (dir === projectsRoot) throw new Error("Refusing to delete projectsRoot itself");
      const cached = projectScopes.get(id);
      if (cached) {
        cached.__destroy();
        projectScopes.delete(id);
      }
      await rm(dir, { recursive: true, force: true });
    },

    info() {
      return { name: "fs", version: STORAGE_INTERFACE_VERSION };
    },
  };
}
