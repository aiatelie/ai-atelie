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
  /** Bound design system id (user-authored brand definition). When set,
   *  the agent receives the DS contents as a high-priority preamble on
   *  every turn. Reusable across projects — DSes are stored under
   *  SHARED_ROOT/design_systems/, not in the project itself. */
  designSystemId?: string;
};

/** A user-authored Design System — the brand definition Claude follows
 *  on every design turn. Reusable across projects.
 *
 *  Stored as one JSON blob per DS in SHARED_ROOT/design_systems/<id>.json.
 *  The published flag is informational today; future revs may use it to
 *  gate exposure to imported templates / co-workers.
 */
export type DesignSystem = {
  schemaVersion: 1;
  id: string;
  name: string;
  /** User-written brand definition — colors, typography, voice, component
   *  rules. Free-form Markdown. Pasted verbatim into the agent's system
   *  prompt when the DS is bound to a project. */
  description: string;
  published: boolean;
  createdAt: number;
  updatedAt: number;
};

export type DesignSystemSummary = {
  id: string;
  name: string;
  published: boolean;
  createdAt: number;
  updatedAt: number;
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
