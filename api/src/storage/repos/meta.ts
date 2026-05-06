/* meta.ts — per-project sidecar JSON repository.
 *
 * Thin pass-through over `driver.project(id).meta` (a JsonKv). Exists
 * mostly so route handlers don't import the driver directly — a future
 * driver swap rebinds one line in storage/index.ts and nothing in
 * routes changes.
 */

import type { ETag, KvDeleteResult, KvGetResult, KvPutResult, StorageDriver, Unsubscribe } from "../driver.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const KEY_RE = /^[a-zA-Z0-9_-]+$/;

export class ProjectMetaRepo {
  constructor(private readonly driver: StorageDriver) {}

  static isValidKey(key: string): boolean {
    return typeof key === "string" && KEY_RE.test(key);
  }

  static isValidProjectId(id: string): boolean {
    return typeof id === "string" && ID_RE.test(id);
  }

  async list(projectId: string): Promise<string[]> {
    if (!ProjectMetaRepo.isValidProjectId(projectId)) return [];
    return this.driver.project(projectId).meta.list();
  }

  async get<T = unknown>(projectId: string, key: string): Promise<KvGetResult<T>> {
    if (!ProjectMetaRepo.isValidProjectId(projectId) || !ProjectMetaRepo.isValidKey(key)) {
      return { ok: false, reason: "not_found" };
    }
    return this.driver.project(projectId).meta.get<T>(key);
  }

  async put<T = unknown>(
    projectId: string,
    key: string,
    value: T,
    opts?: { ifMatch?: ETag },
  ): Promise<KvPutResult> {
    if (!ProjectMetaRepo.isValidProjectId(projectId) || !ProjectMetaRepo.isValidKey(key)) {
      throw new Error(`Invalid projectId or key: ${projectId}/${key}`);
    }
    return this.driver.project(projectId).meta.put(key, value, opts);
  }

  async delete(
    projectId: string,
    key: string,
    opts?: { ifMatch?: ETag },
  ): Promise<KvDeleteResult> {
    if (!ProjectMetaRepo.isValidProjectId(projectId) || !ProjectMetaRepo.isValidKey(key)) {
      return { ok: false, reason: "not_found" };
    }
    return this.driver.project(projectId).meta.delete(key, opts);
  }

  /** Subscribe to all change events for a project's meta channel. The
   *  SSE route serializes these to clients. */
  subscribe(projectId: string, listener: (key: string) => void): Unsubscribe {
    if (!ProjectMetaRepo.isValidProjectId(projectId)) return () => {};
    return this.driver.project(projectId).meta.subscribe((e) => listener(e.key));
  }
}
