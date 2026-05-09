/* designSystems.ts — DesignSystem repository.
 *
 * A Design System (DS) is a user-authored brand definition Claude follows
 * on every design turn. DSes belong to the workspace (not to a project)
 * so they're reusable: bind the same DS to several projects and every
 * agent message in those projects gets the brand preamble.
 *
 * Storage: one JSON file per DS in the driver's `designSystems().kv`
 * scope (web/design_systems/<id>.json on the FS driver).
 */

import { randomBytes } from "node:crypto";
import type { StorageDriver } from "../driver.ts";
import type { DesignSystem, DesignSystemSummary } from "./types.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 64 * 1024; // 64KB — generous; longer specs should live in a project DESIGN.md.

export type CreateDesignSystemInput = {
  /** Optional explicit id; auto-generated when omitted. */
  id?: string;
  name: string;
  description: string;
};

export type UpdateDesignSystemInput = {
  name?: string;
  description?: string;
  published?: boolean;
};

function newDesignSystemId(): string {
  return "ds_" + randomBytes(4).toString("hex");
}

function clampName(name: unknown): string {
  if (typeof name !== "string") throw new Error("name must be a string");
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("name cannot be empty");
  if (trimmed.length > NAME_MAX) return trimmed.slice(0, NAME_MAX);
  return trimmed;
}

function clampDescription(description: unknown): string {
  if (typeof description !== "string") throw new Error("description must be a string");
  if (description.length > DESCRIPTION_MAX) return description.slice(0, DESCRIPTION_MAX);
  return description;
}

export class DesignSystemRepo {
  constructor(private readonly driver: StorageDriver) {}

  static isValidId(id: string): boolean {
    return typeof id === "string" && ID_RE.test(id);
  }

  /** List every DS as a lightweight summary. Sorted by updatedAt desc. */
  async list(): Promise<DesignSystemSummary[]> {
    const kv = this.driver.designSystems().kv;
    const ids = await kv.list();
    const out: DesignSystemSummary[] = [];
    for (const id of ids) {
      const r = await kv.get<DesignSystem>(id);
      if (!r.ok) continue;
      const v = r.value;
      // Defensive parse — old shapes won't crash the list.
      if (!v || typeof v !== "object") continue;
      out.push({
        id: v.id ?? id,
        name: typeof v.name === "string" ? v.name : "(unnamed)",
        published: v.published === true,
        createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
        updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  async exists(id: string): Promise<boolean> {
    if (!DesignSystemRepo.isValidId(id)) return false;
    const r = await this.driver.designSystems().kv.get(id);
    return r.ok;
  }

  async get(id: string): Promise<DesignSystem | null> {
    if (!DesignSystemRepo.isValidId(id)) return null;
    const r = await this.driver.designSystems().kv.get<DesignSystem>(id);
    if (!r.ok) return null;
    // Heal old shapes by filling in missing required fields.
    const v = r.value;
    if (!v || typeof v !== "object") return null;
    return {
      schemaVersion: 1,
      id: v.id ?? id,
      name: typeof v.name === "string" ? v.name : "(unnamed)",
      description: typeof v.description === "string" ? v.description : "",
      published: v.published === true,
      createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
      updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
    };
  }

  async create(input: CreateDesignSystemInput): Promise<DesignSystem> {
    const id = input.id && DesignSystemRepo.isValidId(input.id) ? input.id : newDesignSystemId();
    const now = Date.now();
    const ds: DesignSystem = {
      schemaVersion: 1,
      id,
      name: clampName(input.name),
      description: clampDescription(input.description),
      published: false,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.driver.designSystems().kv.put(id, ds);
    if (!result.ok) throw new Error("Conflict creating design system");
    return ds;
  }

  async update(id: string, patch: UpdateDesignSystemInput): Promise<DesignSystem | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    const next: DesignSystem = {
      ...cur,
      updatedAt: Date.now(),
    };
    if (patch.name !== undefined) next.name = clampName(patch.name);
    if (patch.description !== undefined) next.description = clampDescription(patch.description);
    if (patch.published !== undefined) next.published = patch.published === true;
    const r = await this.driver.designSystems().kv.put(id, next);
    if (!r.ok) throw new Error("Conflict updating design system");
    return next;
  }

  async setPublished(id: string, published: boolean): Promise<DesignSystem | null> {
    return this.update(id, { published });
  }

  async delete(id: string): Promise<boolean> {
    if (!DesignSystemRepo.isValidId(id)) return false;
    const r = await this.driver.designSystems().kv.delete(id);
    return r.ok;
  }
}

// Re-exports kept narrow — types live in repos/types.ts to match the
// other repositories.
export type { DesignSystem, DesignSystemSummary };

// Helpers exported for tests.
export const _internals = { newDesignSystemId, clampName, clampDescription };
