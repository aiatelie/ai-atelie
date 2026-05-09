/* repos/index.ts — repository assembly + boot-time wiring.
 *
 * One repo per domain concern, all bound to the same driver picked in
 * `storage/index.ts`. Routes import the singletons from here.
 */

import { getStorage } from "../index.ts";
import type { StorageDriver } from "../driver.ts";
import { DesignSystemRepo } from "./designSystems.ts";
import { ProjectFilesRepo } from "./files.ts";
import { ProjectMetaRepo } from "./meta.ts";
import { ProjectRepo } from "./projects.ts";
import { SharedRepo } from "./shared.ts";

export type Repositories = {
  projects: ProjectRepo;
  projectMeta: ProjectMetaRepo;
  projectFiles: ProjectFilesRepo;
  shared: SharedRepo;
  designSystems: DesignSystemRepo;
};

let _repos: Repositories | null = null;

function build(driver: StorageDriver): Repositories {
  return {
    projects: new ProjectRepo(driver),
    projectMeta: new ProjectMetaRepo(driver),
    projectFiles: new ProjectFilesRepo(driver),
    shared: new SharedRepo(driver),
    designSystems: new DesignSystemRepo(driver),
  };
}

export function getRepos(): Repositories {
  if (!_repos) _repos = build(getStorage());
  return _repos;
}

/** Test helper — rebuild repos against a different driver. */
export function rebindRepos(driver: StorageDriver): Repositories {
  _repos = build(driver);
  return _repos;
}

export { ProjectRepo } from "./projects.ts";
export { ProjectMetaRepo } from "./meta.ts";
export { ProjectFilesRepo } from "./files.ts";
export { SharedRepo } from "./shared.ts";
export { DesignSystemRepo } from "./designSystems.ts";
export type {
  DesignSystem,
  DesignSystemSummary,
  ProjectManifest,
  ProjectManifestComponent,
  ProjectManifestPage,
  ProjectSummary,
  SandboxFileEntry,
  SandboxFileKind,
} from "./types.ts";
