/* AddTweaksPopover.tsx — light popover invoked by the "Add tweaks"
 * toolbar button.
 *
 * Replaces the old TweaksPreviewDialog modal. The popover asks one
 * optional question ("What should be tweakable?") and sends a tiny
 * skill-invocation message to the agent:
 *
 *   Apply the make-tweakable skill to `${route}`.
 *   Focus on: ${userFocus}.   <- only if userFocus is non-empty
 *
 * The full protocol details (EDITMODE block, _meta hints, decision rule
 * between cheap path and tweaks_panel.jsx starter, listener-before-
 * announce order, opt-out flag) live in `skills/make-tweakable/SKILL.md`,
 * which is mounted via additionalDirectories on every agent turn. The
 * agent reads it on demand — we don't re-explain the protocol in this
 * outgoing message, because that's what the skill body is for.
 *
 * UX:
 *   - Anchored under the "Add tweaks" toolbar button (positioning is
 *     the caller's job — pass `anchorRect`).
 *   - Single-line input, no scary modal.
 *   - "Add tweaks" button (primary) and an Escape / outside-click to
 *     dismiss.
 *   - Cmd/Ctrl+Enter or plain Enter sends.
 */

import { useEffect, useRef, useState } from "react";

type Props = {
  /** When true the popover renders. */
  open: boolean;
  /** Project-relative route the agent should make tweakable. Surfaced
   *  as inline subtitle so the user sees which file is targeted. */
  route: string;
  /** DOMRect of the toolbar button — popover anchors its top-right
   *  corner to the button's bottom-right. Skipped if null. */
  anchorRect?: DOMRect | null;
  onClose: () => void;
  /** Caller wires this to the actual send-message path (Editor's
   *  runTurn). The string is the FULL message body to send. */
  onSubmit: (message: string) => void;
};

const popover: React.CSSProperties = {
  position: "fixed",
  zIndex: 9999,
  background: "var(--surface, #fff)",
  border: "1px solid var(--ink-10)",
  borderRadius: 10,
  padding: 14,
  width: 360,
  boxShadow: "0 10px 40px rgba(0,0,0,0.18), 0 1px 0 rgba(0,0,0,0.04) inset",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const subtitle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-44)",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  wordBreak: "break-all",
};

const label: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: "var(--ink-92)",
};

const input: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--ink-10)",
  background: "var(--surface)",
  color: "var(--ink-92)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
};

const help: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-44)",
  lineHeight: 1.4,
};

const row: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  alignItems: "center",
};

const button: React.CSSProperties = {
  appearance: "none",
  background: "var(--surface)",
  color: "var(--ink-92)",
  border: "1px solid var(--ink-10)",
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const buttonPrimary: React.CSSProperties = {
  ...button,
  background: "var(--brand, #D97757)",
  color: "var(--on-brand, #FBF7EE)",
  borderColor: "transparent",
};

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9998,
  background: "transparent",
};

export function AddTweaksPopover({ open, route, anchorRect, onClose, onSubmit }: Props) {
  const [focus, setFocus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setFocus("");
      // Defer so the input is in the DOM.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Compose the message. Short, skill-driven. The agent reads the
  // skill body via additionalDirectories for the full protocol. We
  // explicitly remind the model NOT to build a panel inside the
  // artifact — that's a recurring failure mode from other Claude
  // environments. In AI Atelie the panel ALWAYS lives in the
  // editor's sidebar; the artifact just emits a JSON block.
  const compose = (): string => {
    const trimmed = focus.trim();
    const guard =
      `Apply the make-tweakable skill to \`${route}\`. ` +
      `The editor renders the tweak panel in its sidebar — embed an ` +
      `EDITMODE JSON block with _meta hints and wire each knob via ` +
      `CSS variables / data-tweak-* / window.__applyTweaks. Do NOT ` +
      `build a panel inside the artifact; do NOT import any ` +
      `tweaks_panel or useTweaks library; do NOT set ` +
      `\`window.__editModeOwned\`.`;
    return trimmed ? `${guard} Focus on: ${trimmed}.` : guard;
  };

  const submit = () => {
    onSubmit(compose());
    onClose();
  };

  // Position the popover under the anchor button. Fall back to a
  // sensible top-right placement when no anchor is provided.
  const pos: React.CSSProperties = anchorRect
    ? {
        top: anchorRect.bottom + 8,
        // Right-align to the button's right edge.
        right: Math.max(8, window.innerWidth - anchorRect.right),
      }
    : { top: 80, right: 24 };

  return (
    <>
      <div style={backdrop} onClick={onClose} aria-hidden="true" />
      <div
        style={{ ...popover, ...pos }}
        role="dialog"
        aria-label="Add tweaks"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={label}>Add tweaks</span>
          <span style={subtitle}>{route || "(active file)"}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ ...label, fontWeight: 400, color: "var(--ink-65)" }}>
            What should be tweakable? <span style={{ color: "var(--ink-44)" }}>(optional)</span>
          </label>
          <input
            ref={inputRef}
            type="text"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="headline, accent color, font size — leave blank to let Claude pick"
            style={input}
            aria-label="What should be tweakable"
          />
          <span style={help}>
            Claude reads the <code>make-tweakable</code> skill and embeds an
            EDITMODE JSON block wired to CSS variables. The panel renders here
            in the editor sidebar — not inside the design.
          </span>
        </div>
        <div style={row}>
          <button type="button" style={button} onClick={onClose}>
            Cancel
          </button>
          <button type="button" style={buttonPrimary} onClick={submit}>
            Add tweaks
          </button>
        </div>
      </div>
    </>
  );
}
