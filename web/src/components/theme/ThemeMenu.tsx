/* ThemeMenu.tsx — compact foot-pill for switching the editor theme
 * without entering the Settings dialog. Renders the active label as a
 * pill; clicking opens a small popover with the four options. Outside
 * click + Esc dismiss; menuitemradio + aria-checked for screen readers.
 */

import { useEffect, useRef, useState } from "react";
import s from "./themeMenu.module.css";
import {
  getTheme,
  setTheme,
  subscribeTheme,
  themes,
  type ThemePreference,
} from "../../lib/theme";

type Props = {
  /** Optional label shown before the active theme name. Tightens
   *  scanning when the menu sits next to other foot chips. */
  label?: string;
  className?: string;
};

export function ThemeMenu({ label = "Theme", className }: Props) {
  const [pref, setPref] = useState<ThemePreference>(() => getTheme());
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // React to theme changes (other tabs, system flips, settings dialog)
  // so this menu stays in sync without rebuilding the whole tree.
  useEffect(() => subscribeTheme(setPref), []);

  // Outside click + Esc dismiss the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeLabel = themes.find((t) => t.name === pref)?.label ?? "System";

  return (
    <div className={`${s.root}${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        type="button"
        className={s.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change theme"
      >
        <span className={s.triggerLabel}>{label}</span>
        <span className={s.triggerValue}>{activeLabel}</span>
        <span className={s.triggerChevron} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={s.menu} role="menu">
          {themes.map((t) => {
            const checked = pref === t.name;
            return (
              <button
                key={t.name}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className={`${s.item} ${checked ? s.itemActive : ""}`}
                onClick={() => { setTheme(t.name); setOpen(false); }}
              >
                <span className={s.itemCheck} aria-hidden="true">{checked ? "✓" : ""}</span>
                <span className={s.itemLabel}>{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
