/* files.ts — per-project source files repository.
 *
 * Wraps the project's BlobStore. Adds:
 *   • the page/component/asset/config classification used by the
 *     /api/projects/:id/files response (frontend uses it for icons)
 *   • a `subscribe()` helper that the /p/:id/__reload SSE forwards
 *     to the iframe.
 *
 * The repo deliberately leaves the EDITMODE rewrite and inspector-CSS
 * generation in the route handlers — those are HTTP-shaped logic that
 * uses readText/write but isn't itself storage.
 */

import { basename, extname } from "node:path";
import type { BlobReadResult, BlobReadTextResult, BlobStore, StorageDriver, Unsubscribe } from "../driver.ts";
import type { SandboxFileEntry, SandboxFileKind } from "./types.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;

function classifyFile(path: string): SandboxFileKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "page";
  if (ext === ".jsx" || ext === ".tsx") return "component";
  if (ext === ".css" || ext === ".js" || ext === ".mjs" || ext === ".json") return "config";
  return "asset";
}

export class ProjectFilesRepo {
  constructor(private readonly driver: StorageDriver) {}

  private store(projectId: string): BlobStore {
    if (!ID_RE.test(projectId)) throw new Error(`Invalid project id: ${projectId}`);
    return this.driver.project(projectId).files;
  }

  async list(projectId: string): Promise<{ files: SandboxFileEntry[] }> {
    const entries = await this.store(projectId).list();
    const files: SandboxFileEntry[] = [];
    for (const e of entries) {
      // Manifest is metadata, not part of the file tree the frontend lists.
      if (e.path === "manifest.json") continue;
      files.push({
        path: e.path,
        name: basename(e.path),
        size: e.stat.size,
        modified: e.stat.mtime,
        kind: classifyFile(e.path),
      });
    }
    return { files };
  }

  async exists(projectId: string, path: string): Promise<boolean> {
    return this.store(projectId).exists(path);
  }

  async read(projectId: string, path: string): Promise<BlobReadResult> {
    return this.store(projectId).read(path);
  }

  async readText(projectId: string, path: string): Promise<BlobReadTextResult> {
    return this.store(projectId).readText(path);
  }

  async write(projectId: string, path: string, data: Uint8Array | string): Promise<void> {
    await this.store(projectId).write(path, data);
  }

  async delete(projectId: string, path: string): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
    return this.store(projectId).delete(path);
  }

  /** Subscribe to file changes — used by the /p/:id/__reload SSE.
   *  fs.watch on the FS driver coalesces bursts via a 250ms debounce. */
  subscribe(projectId: string, listener: () => void): Unsubscribe {
    if (!ID_RE.test(projectId)) return () => {};
    return this.store(projectId).subscribe(() => listener());
  }
}
