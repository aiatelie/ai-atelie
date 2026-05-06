/* projects.ts — Project repository.
 *
 * Wraps the driver to give routes a typed, domain-shaped API for
 * project lifecycle and the manifest. The manifest itself lives as
 * `manifest.json` in the project's BlobStore (not on JsonKv) because
 * it sits at the project root, alongside source files.
 */

import { basename } from "node:path";
import type { StorageDriver } from "../driver.ts";
import type { ProjectManifest, ProjectSummary } from "./types.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;

export type CreateProjectInput = {
  id: string;
  name: string;
  /** Starter HTML for index.html. The repo doesn't synthesize this —
   *  routes pass the rendered starter so the templates stay close to
   *  the route handler that owns project creation UX. */
  indexHtml: string;
  /** Starter CSS for style.css. */
  styleCss: string;
};

export class ProjectRepo {
  constructor(private readonly driver: StorageDriver) {}

  async list(): Promise<ProjectSummary[]> {
    const ids = await this.driver.listProjectIds();
    const summaries: ProjectSummary[] = [];
    for (const id of ids) {
      const m = await this.getManifest(id);
      if (!m) continue;
      summaries.push({
        id: m.id,
        name: m.name,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        pages: m.pages,
      });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  async exists(id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false;
    const ids = await this.driver.listProjectIds();
    return ids.includes(id);
  }

  async getManifest(id: string): Promise<ProjectManifest | null> {
    if (!ID_RE.test(id)) return null;
    const result = await this.driver.project(id).files.readText("manifest.json");
    if (!result.ok) return null;
    try { return JSON.parse(result.text) as ProjectManifest; }
    catch { return null; }
  }

  async writeManifest(id: string, manifest: ProjectManifest): Promise<void> {
    if (!ID_RE.test(id)) throw new Error(`Invalid project id: ${id}`);
    await this.driver.project(id).files.write("manifest.json", JSON.stringify(manifest, null, 2));
  }

  async updateManifest(id: string, patch: Partial<ProjectManifest>): Promise<ProjectManifest | null> {
    const cur = await this.getManifest(id);
    if (!cur) return null;
    const next: ProjectManifest = {
      ...cur,
      ...patch,
      id,
      kind: "sandbox",
      updatedAt: Date.now(),
    };
    await this.writeManifest(id, next);
    return next;
  }

  async create(input: CreateProjectInput): Promise<ProjectManifest> {
    if (!ID_RE.test(input.id)) throw new Error(`Invalid project id: ${input.id}`);
    const now = Date.now();
    const manifest: ProjectManifest = {
      schemaVersion: 1,
      id: input.id,
      name: input.name,
      kind: "sandbox",
      createdAt: now,
      updatedAt: now,
      pages: [{ file: "index.html", label: "index.html", title: input.name }],
      components: [],
      entry: "index.html",
    };
    await this.driver.createProject(input.id);
    const files = this.driver.project(input.id).files;
    await files.write("index.html", input.indexHtml);
    await files.write("style.css", input.styleCss);
    await this.writeManifest(input.id, manifest);
    return manifest;
  }

  async delete(id: string): Promise<void> {
    if (!ID_RE.test(id)) throw new Error(`Invalid project id: ${id}`);
    await this.driver.deleteProject(id);
  }

  /** Validate a project-relative file path, refusing manifest.json
   *  overwrites and any traversal/dot-prefix attempt. Used by the
   *  upload + delete + tweak routes. */
  validateFilePath(rel: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (typeof rel !== "string" || rel.length === 0) {
      return { ok: false, reason: "empty path" };
    }
    if (rel.includes("\0")) return { ok: false, reason: "null byte" };
    const cleaned = rel.replace(/^\/+/, "");
    for (const seg of cleaned.split("/")) {
      if (seg === "" || seg === "." || seg === "..") return { ok: false, reason: "invalid segment" };
      if (seg.startsWith(".")) return { ok: false, reason: "dot-prefix segment" };
    }
    if (basename(cleaned) === "manifest.json") {
      return { ok: false, reason: "refusing to touch manifest.json" };
    }
    return { ok: true, path: cleaned };
  }
}
