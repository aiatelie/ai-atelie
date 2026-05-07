/* KeyboardShortcutsModal — Cmd/Ctrl+/ cheat sheet.
 *
 * Static catalog of every shortcut currently shipping in the app, grouped
 * by section. Single source of truth: when a new shortcut is wired up,
 * add a row here so users can discover it without hunting through code.
 *
 * Mirrors the QuickSwitcher overlay shape (z-index, surface tokens) so
 * the two palettes feel like one family. Esc / overlay-click close.
 *
 * Phase A of #44 — phases B (Cmd+K command palette) + C (Help icon +
 * settings search) stay open on that issue for follow-up. */

import { useEffect } from "react";
import s from "./keyboardShortcutsModal.module.css";

type Props = {
  onClose: () => void;
};

type Shortcut = {
  /** Key tokens, in order. "mod" renders ⌘ on macOS, Ctrl elsewhere. */
  keys: string[];
  /** What the shortcut does — keep concise, present-tense. */
  label: string;
};

type Section = {
  title: string;
  rows: Shortcut[];
};

// macOS detection runs once at module load. Modifier rendering is purely
// cosmetic — the actual handlers everywhere already accept either
// metaKey OR ctrlKey, so we pick the symbol that matches the user's OS.
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

const SECTIONS: Section[] = [
  {
    title: "Navigation",
    rows: [
      { keys: ["mod", "P"], label: "Quick file switcher" },
      { keys: ["mod", "B"], label: "Toggle left panel" },
      { keys: ["?"], label: "Show this shortcuts cheat sheet" },
      { keys: ["mod", "/"], label: "Show this shortcuts cheat sheet" },
      { keys: ["Esc"], label: "Close any popover or modal" },
    ],
  },
  {
    title: "Chat",
    rows: [
      { keys: ["Enter"], label: "Send message" },
      { keys: ["Shift", "Enter"], label: "Newline in composer" },
      { keys: ["mod", "Enter"], label: "Send (alt shortcut)" },
      { keys: ["/"], label: "Open slash command menu" },
      { keys: ["↑", "↓"], label: "Navigate slash menu" },
      { keys: ["Tab"], label: "Complete highlighted slash command" },
    ],
  },
  {
    title: "Inspector & forms",
    rows: [
      { keys: ["mod", "Enter"], label: "Submit Inspector edit, comment, or elicit form" },
      { keys: ["mod", "S"], label: "Save pending Inspector edits to source" },
    ],
  },
  {
    title: "Drawing",
    rows: [
      { keys: ["mod", "Z"], label: "Undo last stroke (in Draw mode)" },
    ],
  },
  {
    title: "Tabs",
    rows: [
      { keys: ["mod", "click"], label: "Reveal tab in browser (click tab title)" },
      { keys: ["Enter"], label: "Commit tab rename" },
      { keys: ["Esc"], label: "Cancel tab rename" },
    ],
  },
];

export function KeyboardShortcutsModal({ onClose }: Props) {
  // Esc closes from anywhere, even before the dialog has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={s.overlay}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div className={s.dialog} onMouseDown={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <span className={s.title}>Keyboard shortcuts</span>
          <button
            type="button"
            className={s.close}
            onClick={onClose}
            aria-label="Close shortcuts"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div className={s.body}>
          {SECTIONS.map((section) => (
            <div key={section.title} className={s.section}>
              <div className={s.sectionTitle}>{section.title}</div>
              {section.rows.map((row, i) => (
                <div key={i} className={s.row}>
                  <span className={s.label}>{row.label}</span>
                  <span className={s.keys}>{renderKeys(row.keys)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className={s.footer}>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

/** Render `["mod", "P"]` as `<kbd>⌘</kbd> + <kbd>P</kbd>`. */
function renderKeys(keys: string[]): React.ReactNode {
  const out: React.ReactNode[] = [];
  keys.forEach((key, i) => {
    if (i > 0) out.push(<span key={`p${i}`} className={s.plus}>+</span>);
    const display = key === "mod" ? MOD_LABEL : key;
    out.push(<kbd key={i}>{display}</kbd>);
  });
  return out;
}
