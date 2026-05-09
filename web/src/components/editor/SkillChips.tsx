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
 * Tooltip semantics: native `title` attribute. We deliberately don't
 * build a custom popover — the prompt text is long, native tooltips
 * handle wrapping/positioning correctly, and the chip row already
 * fights for vertical space at narrow widths.
 *
 * Renders nothing when the SKILLS list is empty (defensive — keeps the
 * composer from sprouting an empty bar if we ever empty the catalog).
 */

import { SKILLS } from "../../data/skills";
import s from "./skillChips.module.css";

export function SkillChips({
  activeIds,
  onToggle,
}: {
  activeIds: string[];
  /** Called with the new full list of active ids after a chip is
   *  clicked. The parent persists + uses it to build the next send's
   *  preamble. We pass the resolved list (not the toggled id) so the
   *  parent doesn't have to know the diff rule. */
  onToggle: (nextActiveIds: string[]) => void;
}) {
  if (SKILLS.length === 0) return null;
  const activeSet = new Set(activeIds);

  return (
    <div className={s.row} role="group" aria-label="Composer skills">
      {SKILLS.map((sk) => {
        const isActive = activeSet.has(sk.id);
        return (
          <button
            key={sk.id}
            type="button"
            role="switch"
            aria-checked={isActive}
            data-active={isActive ? "true" : "false"}
            data-skill-id={sk.id}
            className={`${s.chip} ${isActive ? s.chipActive : ""}`}
            // The full prompt rides as the title so the user can hover
            // any chip to see exactly what they're activating before
            // committing. Native tooltips delay before showing — that's
            // fine; we don't want a busy popover for a low-frequency
            // inspect gesture.
            title={`${sk.label}\n\n${sk.prompt}`}
            // Inline accent color as a CSS custom property so the
            // module CSS can use it for the active-state border / dot
            // without baking five color variants into the stylesheet.
            style={{ "--chip-accent": sk.color } as React.CSSProperties}
            onClick={() => {
              const next = isActive
                ? activeIds.filter((id) => id !== sk.id)
                : [...activeIds, sk.id];
              onToggle(next);
            }}
          >
            <span className={s.dot} aria-hidden="true" />
            <span className={s.label}>{sk.label}</span>
          </button>
        );
      })}
    </div>
  );
}
