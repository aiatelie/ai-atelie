/* IframeErrorOverlay.tsx — surface JS throws + unhandled rejections that
 * happen inside the canvas iframe.
 *
 * Why this exists: a runtime error in the artifact silently breaks the
 * page; without an overlay the user only notices when interactions stop
 * working. Same-origin iframe lets us read the message/stack directly from
 * the inject-script's `runtime-error` postMessage.
 *
 * Behaviour:
 *   - Stacked dismissible cards bottom-right of the canvas (max 3 visible,
 *     overflow shows a "+N more" badge).
 *   - Click a card → expand to show file:line + stack.
 *   - "Send to chat" → dispatches `cc-canvas-attach-error` window event.
 *     ChatSidebar listens and prefills the composer with a formatted block.
 *   - Throttle: identical message within 1s collapses into a count badge.
 *   - Auto-dismiss after 30s of no interaction.
 *
 * Listening: subscribes to window `message` events scoped to the passed
 * iframe's contentWindow so cross-frame noise doesn't leak in.
 */

import { useEffect, useRef, useState } from "react";
import s from "./iframeErrorOverlay.module.css";

export type RuntimeError = {
  /** Stable id for React keys + dismiss tracking. */
  id: number;
  message: string;
  filename: string | null;
  lineno: number | null;
  colno: number | null;
  stack: string | null;
  source: "error" | "unhandledrejection";
  /** Hits — incremented when an identical message arrives within the
   *  throttle window. Surfaced as a "×N" badge so the user knows the
   *  error is firing repeatedly without the overlay drowning them. */
  count: number;
  /** ms since epoch — when the card was first surfaced. Used for
   *  auto-dismiss after a 30s window of no interaction. */
  firstAt: number;
  /** Bumped on any user interaction with this card (expand toggle, hit
   *  count change). Resets the auto-dismiss timer. */
  touchedAt: number;
};

/** Format a runtime error as a markdown code block for the chat composer.
 *  Exported for unit tests; the component dispatches the result on
 *  `cc-canvas-attach-error` so ChatSidebar can prefill the textarea. */
export function formatErrorForChat(card: Pick<RuntimeError, "message" | "filename" | "lineno" | "colno" | "stack" | "source">): string {
  const where = card.filename
    ? `${stripOrigin(card.filename)}${card.lineno ? `:${card.lineno}${card.colno ? `:${card.colno}` : ""}` : ""}`
    : null;
  return [
    "Iframe runtime error:",
    "```",
    `${card.source === "unhandledrejection" ? "[unhandledrejection] " : ""}${card.message}`,
    where ? `at ${where}` : null,
    card.stack ? "" : null,
    card.stack ? card.stack : null,
    "```",
  ].filter((x) => x !== null).join("\n");
}

/** Trim the dev origin off a filename so the chip stays scannable.
 *  `http://localhost:5173/p/my-proj/index.html` → `/p/my-proj/index.html`. */
export function stripOrigin(filename: string): string {
  try {
    const u = new URL(filename);
    return u.pathname + u.search;
  } catch {
    return filename;
  }
}

type Props = {
  iframe: HTMLIFrameElement | null;
  /** Render as nothing if false — lets the parent skip overlay work in
   *  view-only / panic states without unmounting the listener wholesale. */
  enabled?: boolean;
};

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 30_000;
const THROTTLE_MS = 1_000;

let nextErrorId = 1;

export function IframeErrorOverlay({ iframe, enabled = true }: Props) {
  const [errors, setErrors] = useState<RuntimeError[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Most-recent-of-message → most-recent-id, used for throttle/dedupe
  // without scanning the whole list. Cleared when its entry ages out.
  const lastByMessage = useRef<Map<string, { id: number; at: number }>>(new Map());

  useEffect(() => {
    if (!iframe || !enabled) return;
    const win = iframe.contentWindow;
    if (!win) return;

    const onMsg = (e: MessageEvent) => {
      // Scope: only this iframe's window. Other iframes (or extensions)
      // can post anything and we'd rather not surface their errors here.
      if (e.source !== win) return;
      const data = e.data as { __DM_MSG__?: { type: string } } | undefined;
      const msg = data?.__DM_MSG__;
      if (!msg || msg.type !== "runtime-error") return;
      const err = msg as RuntimeError & { type: "runtime-error" };

      const now = Date.now();
      const prev = lastByMessage.current.get(err.message);
      if (prev && now - prev.at < THROTTLE_MS) {
        // Bump the count on the existing card instead of stacking a dup.
        setErrors((cur) => cur.map((c) =>
          c.id === prev.id ? { ...c, count: c.count + 1, touchedAt: now } : c,
        ));
        prev.at = now;
        return;
      }
      const id = nextErrorId++;
      const card: RuntimeError = {
        id,
        message: err.message,
        filename: err.filename ?? null,
        lineno: err.lineno ?? null,
        colno: err.colno ?? null,
        stack: err.stack ?? null,
        source: err.source ?? "error",
        count: 1,
        firstAt: now,
        touchedAt: now,
      };
      lastByMessage.current.set(err.message, { id, at: now });
      setErrors((cur) => [...cur, card]);
    };

    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [iframe, enabled]);

  // Auto-dismiss aged-out cards. Single ticker for the whole stack.
  useEffect(() => {
    if (errors.length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setErrors((cur) => {
        const next = cur.filter((c) => now - c.touchedAt < AUTO_DISMISS_MS);
        if (next.length === cur.length) return cur;
        // Clean up the throttle map for cards that aged out.
        for (const c of cur) {
          if (!next.find((n) => n.id === c.id)) {
            const e = lastByMessage.current.get(c.message);
            if (e && e.id === c.id) lastByMessage.current.delete(c.message);
          }
        }
        return next;
      });
    }, 1_000);
    return () => clearInterval(t);
  }, [errors.length]);

  const dismiss = (id: number) => {
    setErrors((cur) => {
      const card = cur.find((c) => c.id === id);
      if (card) {
        const e = lastByMessage.current.get(card.message);
        if (e && e.id === id) lastByMessage.current.delete(card.message);
      }
      return cur.filter((c) => c.id !== id);
    });
    setExpanded((cur) => {
      if (!cur.has(id)) return cur;
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  };

  const dismissAll = () => {
    setErrors([]);
    setExpanded(new Set());
    lastByMessage.current.clear();
  };

  const toggleExpand = (id: number) => {
    setErrors((cur) => cur.map((c) => (c.id === id ? { ...c, touchedAt: Date.now() } : c)));
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sendToChat = (card: RuntimeError) => {
    const body = formatErrorForChat(card);
    window.dispatchEvent(new CustomEvent("cc-canvas-attach-error", { detail: body }));
    dismiss(card.id);
  };

  if (!enabled || errors.length === 0) return null;

  // Newest-first; the visible window is the last MAX_VISIBLE.
  const ordered = [...errors].reverse();
  const visible = ordered.slice(0, MAX_VISIBLE);
  const hidden = ordered.length - visible.length;

  return (
    <div className={s.stack} data-testid="iframe-error-overlay" data-cc-no-inspect>
      {hidden > 0 && (
        <button
          type="button"
          className={s.overflow}
          onClick={dismissAll}
          title={`${hidden} more error${hidden === 1 ? "" : "s"} hidden — click to dismiss all`}
        >
          +{hidden} more · dismiss all
        </button>
      )}
      {visible.map((card) => {
        const isOpen = expanded.has(card.id);
        const where = card.filename
          ? `${stripOrigin(card.filename)}${card.lineno ? `:${card.lineno}${card.colno ? `:${card.colno}` : ""}` : ""}`
          : null;
        return (
          <div key={card.id} className={s.card} role="alert">
            <div className={s.head}>
              <span className={s.icon} aria-hidden>!</span>
              <button
                type="button"
                className={s.message}
                onClick={() => toggleExpand(card.id)}
                title={isOpen ? "Collapse" : "Expand for stack"}
              >
                <span className={s.messageText}>{card.message}</span>
                {card.count > 1 && <span className={s.count}>×{card.count}</span>}
              </button>
              <button
                type="button"
                className={s.dismiss}
                onClick={() => dismiss(card.id)}
                aria-label="Dismiss"
                title="Dismiss"
              >
                ×
              </button>
            </div>
            {isOpen && (
              <div className={s.body}>
                {where && <div className={s.where}>{where}</div>}
                {card.stack && <pre className={s.stackTrace}>{card.stack}</pre>}
                <div className={s.actions}>
                  <button
                    type="button"
                    className={s.sendBtn}
                    onClick={() => sendToChat(card)}
                  >
                    Send to chat
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
