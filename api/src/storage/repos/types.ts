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

/** Project type and the answers to the type-specific questions on the
 *  new-project form. Optional and additive: existing manifests without
 *  this field are treated as `kind: "other"`.
 *
 *  The agent reads this on first turn (via the intake preamble) so the
 *  initial conversation lands grounded in what the user said they were
 *  making. None of these values are load-bearing for the canvas/runtime
 *  — they steer the AI, not the file scaffold. */
export type ProjectTypeContext = {
  /** Discriminant from the new-project form's tab choice. */
  kind: "prototype" | "slide_deck" | "template" | "other";
  /** Prototype tab: which fidelity the user picked. */
  prototypeFidelity?: "wireframe" | "high_fidelity";
  /** Slide-deck tab: speaker-notes vs. less-text-on-slides preference. */
  slideStyle?: "speaker_notes" | "less_text";
  /** From-template tab: the chosen template id (empty when no templates exist). */
  templateId?: string;
  /** Free-form design system identifier. "none" when the user picked the
   *  default placeholder; otherwise a string the agent treats as a
   *  reference to attach later. */
  designSystem?: string;
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
  /** Type the user picked on the new-project form, plus any tab-specific
   *  follow-up answers. Optional — older manifests omit it. */
  projectType?: ProjectTypeContext;
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
