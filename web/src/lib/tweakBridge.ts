/* tweakBridge.ts — host side of the `make-tweakable` contract
 * + iframe self-description for canvas-aware UI choices
 * + window.claude.complete() proxy.
 *
 * Listens for postMessage events from the project iframe:
 *   { type: '__edit_mode_available' }    → page can be tweaked; enable toggle
 *   { type: '__edit_mode_set_keys', edits } → user moved a knob; persist
 *   { type: '__edit_mode_dismissed' }    → iframe closed its panel itself
 *   { type: '__page_is_canvas' }         → page is a workshop (DesignCanvas):
 *                                          owns its own viewport, suppress the
 *                                          editor's device-frame mode.
 *   { type: '__claude_complete', id, payload } → artifact called
 *                                          window.claude.complete(); proxy to
 *                                          /api/artifacts/claude-complete and
 *                                          post __claude_complete_response back.
 *
 * Sends to the iframe in response to the toolbar toggle:
 *   { type: '__activate_edit_mode' }     → show the in-page Tweaks panel
 *   { type: '__deactivate_edit_mode' }   → hide it
 *
 * Sends to canvas-mode iframes only:
 *   { type: '__dc_set_theme', tokens }   → push current theme tokens so the
 *                                          canvas chrome (bg, grid, label
 *                                          colors) reflects the user's
 *                                          choice in Settings → Theme. Sent
 *                                          on `__page_is_canvas` arrival
 *                                          and on every change to the host
 *                                          `<html data-theme>` attribute.
 *                                          See `mcp/CANVAS_PROTOCOL.md`.
 *
 * On `__edit_mode_set_keys`, POSTs `/api/projects/:id/tweak` which
 * rewrites the EDITMODE-marked JSON block in the active route's source
 * file. The iframe will reload via vite HMR with the new defaults.
 *
 * `available` and `isCanvas` reset every time the iframe navigates /
 * reloads (the new page must re-announce). We hook this on `load` events.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type TweakBridge = {
  /** True when the current iframe page declared __edit_mode_available. */
  available: boolean;
  /** True when the user toggled live-tweak mode on. */
  editing: boolean;
  /** True when the current iframe page declared __page_is_canvas — i.e.
   *  it's a workshop (DesignCanvas) that owns its own viewport. The
   *  editor uses this to suppress device-frame display mode. */
  isCanvas: boolean;
  /** Toggle live-tweak mode. Posts __activate / __deactivate to iframe. */
  toggle: () => void;
  /** Force a deactivation (e.g. on tab change). */
  deactivate: () => void;
};

type Args = {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Active project id — needed to call the right /api/projects/:id/tweak. */
  projectId: string;
  /** Current iframe route (project-relative path, e.g. "index.html").
   *  Used as the file to rewrite on `__edit_mode_set_keys`. */
  activeFile: string;
};

export function useTweakBridge({ iframeRef, projectId, activeFile }: Args): TweakBridge {
  const [available, setAvailable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [isCanvas, setIsCanvas] = useState(false);

  // Track latest activeFile in a ref so the message handler always picks
  // the current route, not whatever it was when the listener was attached.
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // Reset availability when the iframe navigates — the new page must
  // re-announce. The "load" listener has to be re-attached when the
  // iframe element identity changes, hence the dep on iframeRef.current.
  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    const onLoad = () => {
      setAvailable(false);
      setEditing(false);
      setIsCanvas(false);
    };
    ifr.addEventListener("load", onLoad);
    return () => ifr.removeEventListener("load", onLoad);
    // The ref is stable but its `.current` can change on iframe remount.
    // We re-run on every render of the parent so we don't miss a swap;
    // the dep array trick of including `iframeRef.current` would work
    // but causes lint noise — an empty array + manual reattach in the
    // toggle path also works. Keeping it simple: re-run if the active
    // route changes (a route change usually swaps the iframe src).
  }, [activeFile, iframeRef]);

  // Window-level message listener. The iframe is same-origin so we
  // could do `event.source === ifr.contentWindow` for tighter scoping,
  // but the message types are namespaced enough that we can accept all.
  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const data = e.data as
        | {
            type?: string;
            edits?: Record<string, unknown>;
            id?: string;
            payload?: unknown;
          }
        | undefined;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "__edit_mode_available") {
        setAvailable(true);
        return;
      }
      if (data.type === "__edit_mode_dismissed") {
        setEditing(false);
        return;
      }
      if (data.type === "__page_is_canvas") {
        setIsCanvas(true);
        // Push the current theme immediately so the canvas's first paint
        // matches the host. The canvas's own listener handles subsequent
        // updates triggered by the MutationObserver below.
        sendThemeToIframe(iframeRef);
        return;
      }
      if (data.type === "__edit_mode_set_keys") {
        const edits = data.edits;
        if (!edits || typeof edits !== "object") return;
        const file = activeFileRef.current;
        const id = projectIdRef.current;
        if (!file || !id) return;
        try {
          const res = await fetch(`/api/projects/${id}/tweak`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file, edits }),
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            console.warn("[tweakBridge] tweak rewrite failed:", j);
          }
        } catch (err) {
          console.warn("[tweakBridge] network error:", err);
        }
        return;
      }
      if (data.type === "__claude_complete") {
        // Artifact called window.claude.complete(). Proxy to the API and
        // post the response back to the originating iframe (use e.source
        // so we route to the right window even if multiple iframes are
        // mounted — iframeRef may not be the one that fired this).
        const id = typeof data.id === "string" ? data.id : null;
        const source = e.source as Window | null;
        if (!id || !source) return;
        const reply = (msg: { result?: string; error?: string }) => {
          try {
            source.postMessage(
              { type: "__claude_complete_response", id, ...msg },
              "*",
            );
          } catch {
            /* iframe may have unmounted; nothing to do */
          }
        };
        const body =
          typeof data.payload === "string"
            ? { prompt: data.payload }
            : (data.payload as Record<string, unknown> | null) ?? {};
        try {
          const res = await fetch("/api/artifacts/claude-complete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const json = (await res.json().catch(() => ({}))) as {
            text?: string;
            error?: string;
          };
          if (!res.ok) {
            reply({ error: json.error ?? `HTTP ${res.status}` });
          } else {
            reply({ result: typeof json.text === "string" ? json.text : "" });
          }
        } catch (err) {
          reply({ error: err instanceof Error ? err.message : "fetch failed" });
        }
        return;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const sendToIframe = useCallback((type: string) => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    try { w.postMessage({ type }, "*"); } catch { /* ignore */ }
  }, [iframeRef]);

  // Re-broadcast the current theme to the iframe whenever the host's
  // <html data-theme> attribute changes — i.e. the user picked a different
  // theme in Settings → Theme. Active only while isCanvas is true so we
  // don't pay the observer cost on non-canvas pages.
  useEffect(() => {
    if (!isCanvas) return;
    const html = document.documentElement;
    const obs = new MutationObserver(() => sendThemeToIframe(iframeRef));
    obs.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [isCanvas, iframeRef]);

  const toggle = useCallback(() => {
    setEditing((cur) => {
      const next = !cur;
      sendToIframe(next ? "__activate_edit_mode" : "__deactivate_edit_mode");
      return next;
    });
  }, [sendToIframe]);

  const deactivate = useCallback(() => {
    setEditing(false);
    sendToIframe("__deactivate_edit_mode");
  }, [sendToIframe]);

  return { available, editing, isCanvas, toggle, deactivate };
}

/** Snapshot the host's current theme tokens and post them to a canvas
 *  iframe as `__dc_set_theme`. Called on `__page_is_canvas` arrival and
 *  every time the host's `<html data-theme>` changes. The canvas's
 *  DCViewport listens for this and applies the tokens as CSS variables on
 *  the design-canvas root, with hex fallbacks if any token resolves empty.
 *
 *  Token names are the canvas-side keys (`bg`, `grid`, `label`, …). Each
 *  maps to a host token chosen for visual proximity to the role the
 *  canvas uses it for — the canvas background tracks the app background,
 *  the grid tracks the faintest ink stop, label/title/subtitle track the
 *  ink scale by emphasis. */
function sendThemeToIframe(iframeRef: React.RefObject<HTMLIFrameElement | null>): void {
  const w = iframeRef.current?.contentWindow;
  if (!w) return;
  if (typeof getComputedStyle === "undefined") return;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string) => cs.getPropertyValue(name).trim();
  const tokens = {
    bg: read("--app-bg"),
    grid: read("--ink-06"),
    label: read("--ink-65"),
    title: read("--ink-92"),
    subtitle: read("--ink-55"),
    surface: read("--surface"),
    brand: read("--brand"),
  };
  try { w.postMessage({ type: "__dc_set_theme", tokens }, "*"); } catch { /* ignore */ }
}
