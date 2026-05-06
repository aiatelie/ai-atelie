/* domSnapshot.ts — capture + restore iframe DOM state.
 *
 * Used to store a "what the page looked like" record alongside every
 * comment / chat user message. So we can restore to that state on demand
 * (Figma's "version history" concept, scoped to one tab in the editor).
 *
 * Storage shape (per-record):
 *   { html, scrollX, scrollY, styles, thumbnail, ts }
 *
 * Two restore strategies, picked at restore time:
 *   1. Surgical (preferred): apply the stored `styles` map keyed by
 *      `data-dm-ref` to each matching element. Cheap, preserves React's
 *      hydration tree, and keeps inspector selections valid. Used when
 *      every ref from the snapshot still exists in the live DOM — i.e.
 *      the user only changed inline styles since (inspector edits, drag).
 *   2. Wholesale (fallback): replace `body.outerHTML` with the saved
 *      markup. Used when refs went missing — Kimi added/removed nodes,
 *      or HMR replaced the page wholesale. Disrupts handlers; the editor
 *      re-injects DM script + clears stale selection on success.
 *
 * `html` is heavy but perfectly fidelity-accurate. Thumbnail is a small
 * modern-screenshot data URL (<~30KB). The thread / comment lists cap
 * their entries; we also cap html below to avoid pathological cases.
 */

import { captureIframeAsDataUrl } from "./screenshot";

export type DomSnapshot = {
  html: string;
  scrollX: number;
  scrollY: number;
  /** Per-ref inline-style map for surgical restore. Keys are data-dm-ref
   *  values; values are the element's `style` attribute string ("" when
   *  no inline style was set). */
  styles?: Record<string, string>;
  thumbnail?: string;
  ts: number;
};

const HTML_LIMIT = 600_000; // ~600 KB before we drop the html portion

export async function captureDomSnapshot(
  iframe: HTMLIFrameElement | null,
  /** When provided, the thumbnail is cropped to that element instead of the
   *  whole document body. Falls back to the body if the element isn't found. */
  thumbnailSelector?: string
): Promise<DomSnapshot | null> {
  if (!iframe) return null;
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return null;

  let thumbnail: string | undefined;
  // Element thumbnails want a scale of 1 (they're already small) so they
  // stay legible. Whole-page thumbnails stay at 0.25 to keep size in budget.
  const isElement = !!(thumbnailSelector && doc.querySelector(thumbnailSelector));
  try {
    thumbnail = await captureIframeAsDataUrl(iframe, {
      scale: isElement ? 1 : 0.25,
      selector: isElement ? thumbnailSelector : undefined,
    });
  } catch { /* thumbnail is best-effort */ }

  let html = "";
  try {
    html = doc.body.outerHTML;
    if (html.length > HTML_LIMIT) html = ""; // pathological page; skip
  } catch { /* ignore */ }

  // Per-ref inline-style map. The inject-script stamps every element with
  // `data-dm-ref="rN"`; capturing the live `style` attribute by ref lets
  // us reverse inspector / drag mutations without destroying the tree.
  const styles: Record<string, string> = {};
  try {
    const stamped = doc.body.querySelectorAll<HTMLElement>("[data-dm-ref]");
    for (const el of stamped) {
      const ref = el.getAttribute("data-dm-ref");
      if (!ref) continue;
      styles[ref] = el.getAttribute("style") ?? "";
    }
  } catch { /* ignore */ }

  return {
    html,
    scrollX: win.scrollX || 0,
    scrollY: win.scrollY || 0,
    styles: Object.keys(styles).length > 0 ? styles : undefined,
    thumbnail,
    ts: Date.now(),
  };
}

export type RestoreResult =
  | { ok: false }
  | { ok: true; mode: "surgical" | "wholesale" };

export function restoreDomSnapshot(
  iframe: HTMLIFrameElement | null,
  snap: { html?: string; scrollX?: number; scrollY?: number; styles?: Record<string, string> }
): RestoreResult {
  if (!iframe) return { ok: false };
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win || !doc.body) return { ok: false };

  // Strategy 1 — surgical. If every ref from the snapshot still exists,
  // just rewrite inline styles. Preserves React's tree, scroll, listeners.
  if (snap.styles) {
    const refs = Object.keys(snap.styles);
    let allFound = true;
    const found: Array<{ el: HTMLElement; ref: string }> = [];
    for (const ref of refs) {
      const el = doc.querySelector<HTMLElement>(`[data-dm-ref="${ref}"]`);
      if (!el) { allFound = false; break; }
      found.push({ el, ref });
    }
    if (allFound && refs.length > 0) {
      try {
        for (const { el, ref } of found) {
          const css = snap.styles[ref];
          if (css) el.setAttribute("style", css);
          else el.removeAttribute("style");
        }
        win.scrollTo(snap.scrollX ?? 0, snap.scrollY ?? 0);
        return { ok: true, mode: "surgical" };
      } catch { /* fall through to wholesale */ }
    }
  }

  // Strategy 2 — wholesale. Last resort when refs went missing (Kimi
  // added/removed nodes, page reloaded, etc.). Disruptive but accurate.
  if (!snap.html) return { ok: false };
  try {
    doc.body.outerHTML = snap.html;
    win.scrollTo(snap.scrollX ?? 0, snap.scrollY ?? 0);
    return { ok: true, mode: "wholesale" };
  } catch {
    return { ok: false };
  }
}
