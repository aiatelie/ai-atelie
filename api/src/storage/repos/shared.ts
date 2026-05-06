/* shared.ts — workspace-wide JsonKv repository.
 *
 * Backs `/api/shared/:key` and the workspace SSE channel.
 */

import type { ETag, KvDeleteResult, KvGetResult, KvPutResult, StorageDriver, Unsubscribe } from "../driver.ts";

const KEY_RE = /^[a-zA-Z0-9_-]+$/;

export class SharedRepo {
  constructor(private readonly driver: StorageDriver) {}

  static isValidKey(key: string): boolean {
    return typeof key === "string" && KEY_RE.test(key);
  }

  async list(): Promise<string[]> {
    return this.driver.shared().kv.list();
  }

  async get<T = unknown>(key: string): Promise<KvGetResult<T>> {
    if (!SharedRepo.isValidKey(key)) return { ok: false, reason: "not_found" };
    return this.driver.shared().kv.get<T>(key);
  }

  async put<T = unknown>(
    key: string,
    value: T,
    opts?: { ifMatch?: ETag },
  ): Promise<KvPutResult> {
    if (!SharedRepo.isValidKey(key)) throw new Error(`Invalid shared key: ${key}`);
    return this.driver.shared().kv.put(key, value, opts);
  }

  async delete(key: string, opts?: { ifMatch?: ETag }): Promise<KvDeleteResult> {
    if (!SharedRepo.isValidKey(key)) return { ok: false, reason: "not_found" };
    return this.driver.shared().kv.delete(key, opts);
  }

  /** Subscribe to all shared kv change events. Callers may also want
   *  the `sharedEvents` workspace event-bus (in services/sseChannels.ts)
   *  for non-storage signals like "projects index changed". */
  subscribe(listener: (key: string) => void): Unsubscribe {
    return this.driver.shared().kv.subscribe((e) => listener(e.key));
  }
}
