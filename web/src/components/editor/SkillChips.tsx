/* SkillChips.tsx — persistent toggleable composer chips.
 *
 * Renders a row of pill toggles that sit just above the chat composer
 * textarea. Each chip represents a "posture" the user can apply to
 * every message in this project (wireframe, hi-fi, interactive, etc.).
 * Clicking a chip activates / deactivates it; the active set is mirrored
 * to localStorage so toggles survive reloads, and is exposed back up to
 * the composer via `onChange` so the next send carries the right
 * preamble.
 *
 * Distinct from <ActiveSkillsStrip>:
 *   • ActiveSkillsStrip is a read-only summary of the project manifest's
 *     `design.active_skills` (server-resolved, click → opens Settings).
 *   • SkillChips are local-state toggles for the *composer*, hardcoded
 *     in `data/skills.ts`, and inject prompt text into outgoing turns.
 *
 * Disclosure semantics: each chip exposes its full prompt three ways so
 * every input modality gets a preview before activation:
 *   1. Native `title={prompt}` — sighted mouse users get the browser
 *      tooltip on hover. Matches the rest of this codebase's chip /
 *      icon-button convention (see context pills, message actions, etc.).
 *   2. `aria-describedby` pointing at a sibling .srOnly <span> that
 *      lives OUTSIDE the button — screen readers announce the
 *      description on focus, and because the span is a sibling (not a
 *      descendant), it doesn't pollute the button's accessible name.
 *   3. The button's own accessible name is the chip's short label
 *      ("Wireframe"), set via `aria-label` for stability if we ever
 *      add visual decoration that would otherwise leak into the name.
 *
 * Renders nothing when the SKILLS list is empty (defensive — keeps the
 * composer from sprouting an empty bar if we ever empty the catalog).
 */

import { SKILLS, toggleSkill } from "../../data/skills";
import s from "./skillChips.module.css";

export function SkillChips({
  activeIds,
  onToggle,
}: {
  activeIds: string[];
  /** Called with the new full list of active ids after a chip is
   *  clicked or the clear-all affordance is used. The parent persists
   *  + uses it to build the next send's preamble. We pass the resolved
   *  list (not the toggled id) so the parent doesn't have to know
   *  group / clear rules — they live in `data/skills.ts`. */
  onToggle: (nextActiveIds: string[]) => void;
}) {
  if (SKILLS.length === 0) return null;
  const activeSet = new Set(activeIds);
  const hasAny = activeIds.length > 0;

  return (
    <div className={s.row} role="group" aria-label="Composer skills">
      {SKILLS.map((sk, i) => {
        const isActive = activeSet.has(sk.id);
        const descId = `skill-desc-${sk.id}`;
        // Visually separate group transitions — when this chip's group
        // is different from the previous chip's, add a small gap so
        // the user can read the grouping at a glance. (The catalog is
        // ordered so grouped chips sit together; we don't sort here.)
        const prev = i > 0 ? SKILLS[i - 1] : undefined;
        const isGroupBoundary = !!prev && prev.group !== sk.group;
        return (
          // Wrapper so the .srOnly description sibling lives outside
          // the <button> — keeps the accessible name = aria-label only,
          // and aria-describedby still picks up the long prompt.
          <span
            key={sk.id}
            className={`${s.chipWrap} ${isGroupBoundary ? s.chipWrapBoundary : ""}`}
          >
            <button
              type="button"
              role={sk.group ? "radio" : "switch"}
              aria-checked={isActive}
              aria-label={sk.label}
              aria-describedby={descId}
              data-active={isActive ? "true" : "false"}
              data-skill-id={sk.id}
              data-skill-group={sk.group ?? ""}
              className={`${s.chip} ${isActive ? s.chipActive : ""}`}
              // Inline accent color as a CSS custom property so the
              // module CSS can use it for the active-state border / dot
              // without baking five color variants into the stylesheet.
              style={{ "--chip-accent": sk.color } as React.CSSProperties}
              // Native browser tooltip for sighted mouse users — the
              // full prompt text. Matches every other chip / icon
              // button in this composer (context pills, attach button,
              // etc.). aria-describedby covers the AT path; the two
              // are complementary, not redundant.
              title={sk.prompt}
              onClick={() => onToggle(toggleSkill(activeIds, sk.id))}
            >
              <span className={s.dot} aria-hidden="true" />
              <span className={s.label}>{sk.label}</span>
            </button>
            {/* Visually hidden description announced by AT via the
                button's aria-describedby. Sibling-not-descendant so it
                doesn't get folded into the button's accessible name. */}
            <span id={descId} className={s.srOnly}>
              {sk.label}: {sk.prompt}
            </span>
          </span>
        );
      })}
      {/* Clear-all affordance — only present when at least one chip is
          active, so the row stays minimal in its default state. Native
          title for hover; aria-label for screen readers. */}
      {hasAny && (
        <button
          type="button"
          className={s.clearAll}
          onClick={() => onToggle([])}
          title="Clear all skill chips"
          aria-label="Clear all skill chips"
          data-skill-clear="true"
        >
          ×
        </button>
      )}
    </div>
  );
}
