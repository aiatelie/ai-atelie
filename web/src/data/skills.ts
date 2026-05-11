/* skills.ts — toggleable composer skill chips.
 *
 * These are the persistent, user-toggleable "skill chips" that sit
 * above the chat composer. Distinct from the project-manifest
 * `design.active_skills` selection rendered by ActiveSkillsStrip
 * (which surfaces server-resolved aesthetic skills from the catalog) —
 * these chips are local to the composer and inject their prompt
 * payload as a hidden preamble on every message the user sends until
 * they're toggled off.
 *
 * Why hardcoded here instead of pulled from the server catalog: these
 * are *intent shaping* chips, not capability skills. A user toggling
 * "Wireframe" isn't picking which agent capability to invoke — they're
 * telling the model what posture to take for this turn. The prompt
 * text below is what matters; the catalog name is just a shorthand.
 *
 * The chip set is intentionally small (5 entries). Any more and the
 * row stops being scannable. If we add more, consider grouping or a
 * "More…" overflow.
 */

export type ComposerSkill = {
  /** Stable id used as the localStorage key segment and React key. */
  id: string;
  /** Short label rendered on the chip itself. Keep ≤ 16 chars so the
   *  row stays compact at narrow sidebar widths. */
  label: string;
  /** Hex color for the chip's accent border / dot when active. Should
   *  be distinguishable from the others at a glance — picked to span
   *  the warm-cool spectrum so the row reads as a palette, not a
   *  monochrome stack. */
  color: string;
  /** Full prompt payload injected as a hidden preamble on every send
   *  while this chip is active. Shown verbatim in the hover tooltip
   *  so the user always knows what they're activating. */
  prompt: string;
  /** Optional group key. Chips that share a group are mutually
   *  exclusive — activating one deactivates the others in the same
   *  group. Used for the fidelity axis (wireframe / hifi /
   *  interactive) where the prompts contradict each other and
   *  multi-activating just confuses the model. Ungrouped chips are
   *  independent toggles. */
  group?: string;
};

// The "fidelity" group key — wireframe / hifi / interactive contradict
// each other ("sketchy low-fi" vs "polished production" vs "fully
// interactive prototype"). Picking one is the user's intent; letting
// the model see two of them at once just makes Claude pick one
// silently or interpolate.
const FIDELITY_GROUP = "fidelity";

export const SKILLS: ComposerSkill[] = [
  {
    id: "wireframe",
    label: "Wireframe",
    color: "#6B7280",
    group: FIDELITY_GROUP,
    prompt:
      "Help the user explore design ideas quickly. Generate multiple rough wireframes to map out the design space before committing to a direction. Prioritize breadth over polish: show 3-5 distinctly different approaches. Use simple shapes, placeholder text, and minimal color. Sketchy vibe — handwritten but readable fonts, b&w with some color, low-fi and simple.",
  },
  {
    id: "hifi",
    label: "High fidelity",
    color: "#7C3AED",
    group: FIDELITY_GROUP,
    prompt:
      "Produce polished, production-quality designs. Use real typography, refined spacing, carefully considered color. Every detail should feel intentional. Avoid placeholders — if you need copy, write real copy. If you need images, use CSS gradients or SVG illustrations.",
  },
  {
    id: "interactive",
    label: "Interactive",
    color: "#0EA5E9",
    group: FIDELITY_GROUP,
    prompt:
      "Create a fully interactive prototype with realistic state management and transitions. Use React useState/useEffect for dynamic behavior. Include hover states, click interactions, form validation, animated transitions, and multi-step navigation flows. It should feel like a real working app, not a static mockup.",
  },
  {
    // Deliberately NOT "frontend-design" — that id collides with the
    // catalog skill of the same name in DEFAULT_ACTIVE_SKILLS
    // (api/src/services/promptBuilder.ts). If the chip and the manifest
    // default share an id, the skill prompt gets injected twice: once
    // via the system-prompt `active skills` block and again via the
    // hidden chip preamble on the user turn. Using a distinct id keeps
    // the two injection paths orthogonal. The visible label is also
    // distinct ("Bold direction" vs the manifest's "Frontend design")
    // so the chip row and the ActiveSkillsStrip don't surface two
    // identical-looking controls one above the other.
    id: "posture-frontend-design",
    label: "Bold direction",
    color: "#D97706",
    prompt:
      "Pick an extreme visual direction: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel. Avoid generic fonts like Inter, Roboto, Arial — choose distinctive, characterful typography. NEVER converge on the same choices across generations.",
  },
  {
    id: "tweakable",
    label: "Make tweakable",
    color: "#10B981",
    prompt:
      "Add a Tweaks panel to your design with key adjustable parameters — key colors, a layout variant, headline copy, a feature flag. Keep the panel small and tasteful; it should feel native to the design, not bolted on.",
  },
];

/** Build the hidden preamble injected before the user's text on send.
 *  Returns `undefined` when no skills are active so the caller can
 *  cheaply branch on truthiness. The format is a labeled header line
 *  followed by one `### Skill\nprompt` block per active skill. The
 *  caller (Composer / queueOrSend) concatenates this preamble with the
 *  user's typed text, separated by a blank line — no `---` separator is
 *  inserted by this function.
 *
 *  Unknown ids in `activeIds` are silently skipped — defensive against
 *  stale localStorage entries from a previous bundle that referenced
 *  a skill we've since removed. */
export function buildSkillsPreamble(activeIds: string[]): string | undefined {
  const active = activeIds
    .map((id) => SKILLS.find((s) => s.id === id))
    .filter((s): s is ComposerSkill => s != null);
  if (active.length === 0) return undefined;
  const header = `[Active skills: ${active.map((s) => s.id).join(", ")}]`;
  const body = active.map((s) => `### ${s.label}\n${s.prompt}`).join("\n\n");
  return `${header}\n${body}`;
}

/** Compute the next active-skill set after the user clicks a chip.
 *
 *  Semantics:
 *    • If the clicked chip is already active, remove it (toggle off).
 *    • If it's inactive and belongs to a group, replace whatever else
 *      is active in that group with the clicked id (radio behavior).
 *    • If it's inactive and ungrouped, append it (plain toggle).
 *
 *  New ids land at the end of the array — the resulting order is
 *  "first activated → most recently activated", which is what
 *  buildSkillsPreamble surfaces to the model. Unknown ids in
 *  `activeIds` are preserved (defensive against stale storage
 *  predating a chip rename).
 */
export function toggleSkill(activeIds: string[], toggledId: string): string[] {
  if (activeIds.includes(toggledId)) {
    return activeIds.filter((id) => id !== toggledId);
  }
  const toggled = SKILLS.find((s) => s.id === toggledId);
  if (!toggled) return activeIds;
  const group = toggled.group;
  if (group) {
    // Drop any other id from the same group, then append the new one.
    // Keep unrelated ids untouched and in order.
    const groupSiblings = new Set(
      SKILLS.filter((s) => s.group === group).map((s) => s.id),
    );
    const filtered = activeIds.filter((id) => !groupSiblings.has(id));
    return [...filtered, toggledId];
  }
  return [...activeIds, toggledId];
}

/** Normalize an active-skill list so it satisfies the group constraint:
 *  at most one chip from each group, with the LAST occurrence in the
 *  array winning (most-recent-intent semantics, since new ids are
 *  appended to the end). Unknown ids are dropped silently — they refer
 *  to chips that no longer exist.
 *
 *  Used by `loadActiveSkills` to repair localStorage written by an
 *  older bundle (pre-grouping) where two fidelity chips could be on
 *  at once.
 */
export function normalizeActiveSkills(ids: string[]): string[] {
  const known = ids.filter((id) => SKILLS.some((s) => s.id === id));
  const seenGroups = new Set<string>();
  const result: string[] = [];
  // Walk in reverse so we keep the LAST occurrence of each group, then
  // reverse back to preserve activation order. (Set + walking forward
  // would keep the FIRST occurrence, which is the opposite of
  // toggleSkill's append-at-end intent.)
  for (let i = known.length - 1; i >= 0; i--) {
    const id = known[i];
    const sk = SKILLS.find((s) => s.id === id)!;
    if (sk.group) {
      if (seenGroups.has(sk.group)) continue;
      seenGroups.add(sk.group);
    }
    result.push(id);
  }
  return result.reverse();
}

/** localStorage key for the per-project active-skills set. The chips
 *  persist independently per project so toggling "wireframe" on for
 *  one project doesn't bleed into another. When projectId is missing
 *  (Onboard before the project is fully hydrated, edge cases) we fall
 *  back to a global key so the user's choice still sticks across
 *  reloads. */
export function skillsStorageKey(projectId: string | undefined): string {
  return projectId ? `composer-skills:${projectId}` : "composer-skills:_default";
}

/** Read the persisted active-skill ids for a project. Defensive against
 *  parse errors and shape drift — returns [] on anything unexpected.
 *  Result is normalized through `normalizeActiveSkills`, which drops
 *  unknown ids and collapses any same-group co-activation to the most
 *  recently added one. This silently repairs localStorage written by
 *  an older bundle that allowed e.g. wireframe + hifi at once. */
export function loadActiveSkills(projectId: string | undefined): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(skillsStorageKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const strings = parsed.filter((x): x is string => typeof x === "string");
    return normalizeActiveSkills(strings);
  } catch {
    return [];
  }
}

/** Persist the active-skill ids for a project. Empty arrays remove the
 *  key entirely so we don't leave dead `[]` rows in storage. */
export function saveActiveSkills(projectId: string | undefined, ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    const key = skillsStorageKey(projectId);
    if (ids.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* quota exceeded / private mode — chip set is non-critical, drop silently */
  }
}
