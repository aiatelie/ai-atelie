/* types.ts — domain types shared across repositories.
 *
 * The driver speaks `unknown`; the repos parse/validate at the boundary
 * and hand routes typed objects.
 */

export type ProjectManifestPage = {
  file: string;
  label: string;
  title?: string;
};

export type ProjectManifestComponent = {
  file: string;
  name: string;
};

export type ProjectManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: "sandbox";
  createdAt: number;
  updatedAt: number;
  pages: ProjectManifestPage[];
  components?: ProjectManifestComponent[];
  entry: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pages: ProjectManifestPage[];
};

export type SandboxFileKind = "page" | "component" | "asset" | "config";

export type SandboxFileEntry = {
  path: string;
  name: string;
  size: number;
  modified: number;
  kind: SandboxFileKind;
};
