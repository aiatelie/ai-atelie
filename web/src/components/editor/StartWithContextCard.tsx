/* StartWithContextCard.tsx — empty-state hint shown above the chat
 * composer before the user has sent any message in a thread.
 *
 * Four pill buttons, each with a tinted circular icon, that wire into
 * the existing context-attach flows:
 *
 *   • Design System    → seeds @design-system into the composer so the
 *                        AI links the project's design system on the
 *                        next turn.
 *   • Add screenshot   → opens the composer's image file-picker.
 *   • Attach codebase  → seeds @codebase into the composer; the agent
 *                        treats that mention as "explore my repo".
 *   • Drag in a Figma  → click → toast/tooltip explaining drag-drop
 *     file                isn't an action; we can't pick a file via
 *                        click in the browser, the user has to drag
 *                        the link onto the composer.
 *
 * Wiring is via two window events the Composer listens for:
 *   `cc-composer-open-files`  → triggers the hidden <input type=file>
 *   `cc-composer-append-text` → appends the detail string to the textarea
 *
 * Anything more invasive (passing refs through the chat tree) would
 * couple the card tightly to ChatSidebar internals. Events keep it loose
 * — the same card can be dropped into Onboard or any other surface that
 * hosts Composer with no plumbing changes.
 */

import { useState, type ReactElement } from "react";
import s from "./startWithContext.module.css";

type ActionKey = "design-system" | "screenshot" | "codebase" | "figma";

const ACTIONS: Array<{
  key: ActionKey;
  label: string;
  /** "tone" picks one of four CSS classes that paint the icon circle. */
  tone: "orange" | "green" | "blue" | "purple";
  icon: ReactElement;
}> = [
  {
    key: "design-system",
    label: "Design System",
    tone: "orange",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1.4" />
        <rect x="14" y="3" width="7" height="7" rx="1.4" />
        <rect x="3" y="14" width="7" height="7" rx="1.4" />
        <circle cx="17.5" cy="17.5" r="3.5" />
      </svg>
    ),
  },
  {
    key: "screenshot",
    label: "Add screenshot",
    tone: "green",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="12" cy="12" r="3.5" />
        <path d="M8 5l1.5-2h5L16 5" />
      </svg>
    ),
  },
  {
    key: "codebase",
    label: "Attach codebase",
    tone: "blue",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="8 6 2 12 8 18" />
        <polyline points="16 6 22 12 16 18" />
        <line x1="13.5" y1="4" x2="10.5" y2="20" />
      </svg>
    ),
  },
  {
    key: "figma",
    label: "Drag in a Figma file",
    tone: "purple",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3h3v6H9a3 3 0 0 1 0-6z" />
        <path d="M12 3h3a3 3 0 0 1 0 6h-3z" />
        <path d="M9 9h3v6H9a3 3 0 0 1 0-6z" />
        <circle cx="13.5" cy="12" r="3" />
        <path d="M9 15h3v3a3 3 0 0 1-3 3 3 3 0 0 1 0-6z" />
      </svg>
    ),
  },
];

function dispatchAppend(text: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("cc-composer-append-text", { detail: text }));
}

function dispatchOpenFiles() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("cc-composer-open-files"));
}

export function StartWithContextCard() {
  // Figma row toggles a small inline hint instead of doing nothing —
  // there's no browser API to "open" a Figma drag, so we tell the user
  // what to do. Auto-clears on the next click of any button.
  const [hint, setHint] = useState<string | null>(null);

  const onAction = (key: ActionKey) => {
    setHint(null);
    if (key === "design-system") {
      dispatchAppend("@design-system");
      return;
    }
    if (key === "screenshot") {
      dispatchOpenFiles();
      return;
    }
    if (key === "codebase") {
      dispatchAppend("@codebase");
      return;
    }
    if (key === "figma") {
      setHint("Drag a Figma share link onto the composer to attach it.");
      return;
    }
  };

  return (
    <section className={s.card} aria-label="Start with context">
      <div className={s.title}>Start with context</div>
      <div className={s.subtitle}>Designs grounded in real context turn out better.</div>
      <div className={s.pillGrid}>
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            type="button"
            className={s.pill}
            data-tone={a.tone}
            data-testid={`start-context-${a.key}`}
            onClick={() => onAction(a.key)}
            title={a.label}
          >
            <span className={s.pillIcon} aria-hidden="true">{a.icon}</span>
            <span className={s.pillLabel}>{a.label}</span>
          </button>
        ))}
      </div>
      {hint && (
        <div className={s.hint} role="status">{hint}</div>
      )}
    </section>
  );
}
