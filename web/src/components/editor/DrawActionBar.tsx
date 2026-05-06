/* DrawActionBar.tsx — floating mini-bar that appears at the bottom of
 * the canvas when Draw mode is active.
 *
 * UX layout:
 *   [Discard] [Undo] | [text input] | [Send]
 *
 * Send composites the strokes onto a fresh iframe screenshot and hands
 * the result to the parent's `onSend` callback as a single PNG. The
 * parent decides whether that goes to chat or to a saved comment.
 * After Send/Discard the bar self-clears strokes and asks the parent
 * to leave Draw mode.
 */

import { useEffect, useRef, useState } from "react";
import s from "./drawBar.module.css";
import { listStrokes, popStroke, clearStrokes } from "../../lib/drawings";

type Props = {
  /** Active route — strokes are scoped per-route in localStorage. */
  route: string;
  /** Source-of-truth stroke count. Driving via prop (rather than re-
   *  calling listStrokes here) lets the parent keep one subscription
   *  with the useStrokes hook and pass us a stable number. */
  strokeCount: number;
  /** Current stroke color. Lifted to Editor so DrawOverlay + the
   *  composite-on-send pipeline both stay in sync with picker changes. */
  color: string;
  onColorChange: (color: string) => void;
  /** Send the composed drawing + text. The caller composites + ships. */
  onSend: (text: string) => Promise<void> | void;
  /** Called after Discard / successful Send so the editor can leave
   *  Draw mode and return the toolbar to its default state. */
  onLeaveDrawMode: () => void;
};

/** Preset palette. Five slots: red (default), orange, yellow, blue, ink.
 *  Picked for high contrast on cream/light backgrounds the editor's
 *  iframes typically carry. The user gets a quick switch without a
 *  full HSL picker — most annotation flows just need red+highlight. */
const COLOR_PRESETS = [
  "#e0524d", // red
  "#f59e0b", // amber
  "#facc15", // yellow
  "#2563eb", // blue
  "#1f2937", // ink
];

export function DrawActionBar({ route, strokeCount, color, onColorChange, onSend, onLeaveDrawMode }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const paletteWrapRef = useRef<HTMLDivElement>(null);

  // Auto-focus the input on mount so the user can start typing right
  // after they've sketched.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close the palette when clicking outside it.
  useEffect(() => {
    if (!paletteOpen) return;
    const onClickAway = (e: MouseEvent) => {
      if (!paletteWrapRef.current?.contains(e.target as Node)) setPaletteOpen(false);
    };
    window.addEventListener("mousedown", onClickAway);
    return () => window.removeEventListener("mousedown", onClickAway);
  }, [paletteOpen]);

  // Keyboard: ⌘Z undo, Esc discard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        // Don't fight a textarea undo when the user's caret is in the input.
        if (document.activeElement === inputRef.current) return;
        e.preventDefault();
        if (listStrokes(route).length > 0) popStroke(route);
      } else if (e.key === "Escape") {
        // Esc inside the input clears the field; outside, it discards.
        if (document.activeElement === inputRef.current && text) {
          setText("");
          return;
        }
        e.preventDefault();
        clearStrokes(route);
        onLeaveDrawMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route, text, onLeaveDrawMode]);

  // Auto-resize textarea up to ~3 lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 84) + "px";
  }, [text]);

  const canSend = !busy && (strokeCount > 0 || text.trim().length > 0);

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      await onSend(text.trim());
      setText("");
      clearStrokes(route);
      onLeaveDrawMode();
    } catch (err) {
      // Stay in draw mode — the user can retry. Surface the error to the
      // console; the chat will surface its own error bubble if the turn
      // started but failed downstream.
      // eslint-disable-next-line no-console
      console.error("[DrawActionBar] send failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    clearStrokes(route);
    onLeaveDrawMode();
  };

  const undo = () => {
    if (strokeCount > 0) popStroke(route);
  };

  return (
    <div className={s.drawBar} role="toolbar" aria-label="Draw actions">
      <button
        className={s.iconBtn}
        onClick={discard}
        title="Discard drawing and exit Draw mode (Esc)"
        aria-label="Discard"
        disabled={busy}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M3 3 L13 13 M3 13 L13 3" />
        </svg>
      </button>
      <button
        className={s.iconBtn}
        onClick={undo}
        title="Undo last stroke (⌘Z)"
        aria-label="Undo last stroke"
        disabled={busy || strokeCount === 0}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 8 L7 5 M4 8 L7 11 M4 8 H10 a3 3 0 0 1 0 6 H8" />
        </svg>
      </button>
      <div ref={paletteWrapRef} className={s.paletteWrap}>
        <button
          className={s.swatchBtn}
          onClick={() => setPaletteOpen((v) => !v)}
          aria-label="Stroke color"
          aria-haspopup="menu"
          aria-expanded={paletteOpen}
          title="Stroke color"
          disabled={busy}
        >
          <span className={s.swatchDot} style={{ background: color }} />
        </button>
        {paletteOpen && (
          <div className={s.palette} role="menu">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                role="menuitem"
                className={`${s.swatch} ${c === color ? s.swatchActive : ""}`}
                style={{ background: c }}
                onClick={() => { onColorChange(c); setPaletteOpen(false); }}
                aria-label={`Use ${c}`}
                title={c}
              />
            ))}
          </div>
        )}
      </div>
      <div className={s.sep} />
      <textarea
        ref={inputRef}
        className={s.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={strokeCount > 0 ? "Tell Claude about the drawing…" : "Sketch on the canvas, or type…"}
        rows={1}
        disabled={busy}
      />
      <button
        className={s.sendBtn}
        onClick={send}
        disabled={!canSend}
        title={strokeCount > 0 ? "Send drawing + text (Enter)" : "Send text (Enter)"}
      >
        {busy ? "…" : "Send"}
      </button>
    </div>
  );
}
