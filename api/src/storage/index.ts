/* index.ts — process-singleton storage driver.
 *
 * The driver is picked once at boot and exported as `getStorage()`.
 * Tests can call `setStorage()` to swap a memory driver in.
 *
 * To switch backends in production, change the line below to call a
 * different `create<Kind>Driver(...)`. Nothing in routes/, services/, or
 * web/ needs to know.
 */

import { ENV } from "../env.ts";
import type { StorageDriver } from "./driver.ts";
import { createFsDriver } from "./fs-driver.ts";

let _driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (!_driver) {
    _driver = createFsDriver({
      projectsRoot: ENV.PROJECTS_ROOT,
      sharedRoot: ENV.SHARED_ROOT,
      designSystemsRoot: ENV.DESIGN_SYSTEMS_ROOT,
    });
  }
  return _driver;
}

/** Test/runtime override. Pass null to revert to the default fs driver
 *  on the next getStorage() call. */
export function setStorage(driver: StorageDriver | null): void {
  _driver = driver;
}

export type { StorageDriver } from "./driver.ts";
