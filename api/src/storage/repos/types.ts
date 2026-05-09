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

/** Per-project design intelligence — which catalog skills are active
 *  for this project, plus the path to its aesthetic spec if any.
 *
 *  Optional. Absent = legacy default (frontend-design only, no DESIGN.md).
 *  See `skills/index.json` for the catalog of available skill names. */
export type ProjectDesignSelection = {
  /** Skill names from the catalog the agent should treat as active for
   *  this project. Order is priority for name collisions. Default when
   *  absent: ["frontend-design"]. */
  active_skills?: string[];
  /** Project-relative path to a Google-spec DESIGN.md, if the user
   *  authored or imported one. Convention: "DESIGN.md" at the project
   *  root. The agent reads this and prepends it to the system prompt
   *  when present. */
  design_md?: string;
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
  /** Design intelligence selection — see `ProjectDesignSelection`.
   *  Optional and additive: existing manifests without this field are
   *  treated as the default selection. */
  design?: ProjectDesignSelection;
  /** Fork/remix provenance. Set when this project was forked from another.
   *  All three fields are optional so existing manifests stay valid. */
  originProjectId?: string;
  /** The source project's name at fork time — stored in case the source is
   *  later renamed or deleted. */
  originProjectName?: string;
  /** Unix-ms timestamp of when the fork was created. */
  forkedAt?: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pages: ProjectManifestPage[];
  originProjectId?: string;
  originProjectName?: string;
  forkedAt?: number;
};

export type SandboxFileKind = "page" | "component" | "asset" | "config";

export type SandboxFileEntry = {
  path: string;
  name: string;
  size: number;
  modified: number;
  kind: SandboxFileKind;
};
