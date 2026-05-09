/* driver.ts — storage adapter interface.
 *
 * Three primitives, one driver. Routes call repositories; repositories
 * call this interface; implementations live next to it (fs-driver.ts,
 * memory-driver.ts, future sqlite-driver.ts, etc).
 *
 * The contract:
 *   • Expected outcomes (not_found, conflict) are returned as discriminated
 *     unions so callers handle them at the type level.
 *   • Real failures (disk full, permission denied) throw — the route turns
 *     them into 500s.
 *   • Subscriptions are best-effort: drivers may coalesce or drop events
 *     under load, callers must reconcile via re-fetch on reconnect.
 */

export type ETag = string;
export type Unsubscribe = () => void;

/* ─── JsonKv: versioned JSON blobs ──────────────────────────────────
 *
 * Backs `.meta/<key>.json` (per project) and `<SHARED_ROOT>/<key>.json`
 * (workspace). The mtime-based ETag scheme is a driver detail; callers
 * treat ETags as opaque strings.
 */

export type KvChange = { type: "put" | "delete"; key: string };

export type KvGetResult<T> =
  | { ok: true; value: T; etag: ETag }
  | { ok: false; reason: "not_found" };

export type KvPutResult =
  | { ok: true; etag: ETag }
  | { ok: false; reason: "conflict"; currentEtag: ETag | null };

export type KvDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; currentEtag: ETag };

export interface JsonKv {
  list(): Promise<string[]>;
  get<T = unknown>(key: string): Promise<KvGetResult<T>>;
  put<T = unknown>(
    key: string,
    value: T,
    opts?: { ifMatch?: ETag },
  ): Promise<KvPutResult>;
  delete(key: string, opts?: { ifMatch?: ETag }): Promise<KvDeleteResult>;
  subscribe(listener: (e: KvChange) => void): Unsubscribe;
}

/* ─── BlobStore: bytes ──────────────────────────────────────────────
 *
 * Backs project source files and uploads. Excludes `.meta/` — meta keys
 * live on JsonKv. The `subscribe()` event is what `/p/:id/__reload` SSE
 * forwards to the iframe.
 */

export type BlobStat = { size: number; mtime: number; etag: ETag };
export type BlobChange = { type: "put" | "delete"; path: string };

export type BlobReadResult =
  | { ok: true; bytes: Uint8Array; stat: BlobStat }
  | { ok: false; reason: "not_found" };

export type BlobReadTextResult =
  | { ok: true; text: string; stat: BlobStat }
  | { ok: false; reason: "not_found" };

export type BlobDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" };

export interface BlobStore {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<BlobStat | null>;
  read(path: string): Promise<BlobReadResult>;
  readText(path: string): Promise<BlobReadTextResult>;
  /** Atomic write (tmp + rename on FS). Last-write-wins; no concurrency
   *  control today. If two writers race, both succeed and one's bytes win.
   *  Add `ifMatch` later if the EDITMODE rewrite path needs it. */
  write(
    path: string,
    data: Uint8Array | string,
  ): Promise<{ ok: true; stat: BlobStat }>;
  delete(path: string): Promise<BlobDeleteResult>;
  list(prefix?: string): Promise<{ path: string; stat: BlobStat }[]>;
  subscribe(listener: (e: BlobChange) => void): Unsubscribe;
}

/* ─── AppendLog: append-only event sequence ─────────────────────────
 *
 * Per-project monotonic seq log. FS driver writes one JSON entry per
 * line to `<projectDir>/.meta/history.jsonl`; memory driver holds an
 * array. Subscribe with `sinceSeq` replays past entries then attaches
 * for live ones — the shape a Last-Event-ID-resumable run-events SSE
 * (issue #12) will plug into directly.
 */

export type LogEntry<T = unknown> = {
  seq: number;
  ts: number; // unix ms
  data: T;
};

export interface AppendLog {
  append<T = unknown>(entries: T[]): Promise<{ lastSeq: number }>;
  read<T = unknown>(opts?: {
    sinceSeq?: number;
    limit?: number;
    reverse?: boolean;
  }): Promise<LogEntry<T>[]>;
  subscribe<T = unknown>(
    opts: { sinceSeq?: number } | undefined,
    listener: (entry: LogEntry<T>) => void,
  ): Unsubscribe;
  /** Optional compaction. Not all drivers will offer it. */
  truncateBefore?(seq: number): Promise<{ removed: number }>;
}

/* ─── Driver scopes ─────────────────────────────────────────────────
 *
 * The driver hands out scoped views. The repository layer uses these
 * directly; route handlers should not import the driver — only repos.
 */

export type ProjectScope = {
  /** Per-project sidecar JSON (.meta/<key>.json today). */
  meta: JsonKv;
  /** Project source files and uploads. Excludes `.meta/`. */
  files: BlobStore;
  /** Append-only history. FS impl: `.meta/history.jsonl`. Used by
   *  the Last-Event-ID-resumable run-events SSE (issue #12) and any
   *  future replayable edit log. */
  history: AppendLog;
};

export type SharedScope = {
  /** Workspace-wide JSON (web/.data/<key>.json today). */
  kv: JsonKv;
};

/** Design systems are user-authored brand definitions, reusable across
 *  projects. Stored as one JSON file per DS in a dedicated directory
 *  next to projects/ (web/design_systems/<id>.json). The KV interface
 *  fits naturally — each DS is a versioned JSON blob keyed by id. */
export type DesignSystemsScope = {
  kv: JsonKv;
};

export interface StorageDriver {
  shared(): SharedScope;
  designSystems(): DesignSystemsScope;
  project(id: string): ProjectScope;
  /** Project list. Driver decides how — fs scan, SELECT, etc.
   *  Returns ids only; repos read manifests via `project(id).files`. */
  listProjectIds(): Promise<string[]>;
  /** Set up driver-internal bookkeeping for a new project (mkdir on FS,
   *  INSERT on SQL). The repo writes the manifest + starter files via
   *  `project(id).files` after this resolves. */
  createProject(id: string): Promise<void>;
  /** Remove the project and tear down its channels. Idempotent. */
  deleteProject(id: string): Promise<void>;
  /** Driver name + interface version. Surfaced in /api/health for ops
   *  visibility; not used for behavior switches. */
  info(): { name: string; version: number };
}

export const STORAGE_INTERFACE_VERSION = 1;
