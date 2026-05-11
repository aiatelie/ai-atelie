/* tweakBridge.ts — host side of the `make-tweakable` contract
 * + iframe self-description for canvas-aware UI choices
 * + window.ai.complete() proxy.
 *
 * Listens for postMessage events from the project iframe:
 *   { type: '__edit_mode_available', defaults? } → page can be tweaked.
 *                                          Enable toggle. If `defaults` is
 *                                          present (auto-bridge case), the
 *                                          host can render its own typed
 *                                          Tweaks sidebar from those keys.
 *                                          When absent (legacy: iframe
 *                                          ships its own panel), the host
 *                                          only flips the toggle and lets
 *                                          the iframe own the UI.
 *   { type: '__edit_mode_set_keys', edits } → user moved a knob; persist
 *   { type: '__edit_mode_dismissed' }    → iframe closed its panel itself
 *   { type: '__page_is_canvas' }         → page is a workshop (DesignCanvas):
 *                                          owns its own viewport, suppress the
 *                                          editor's device-frame mode.
 *   { type: '__ai_complete', id, payload }  → artifact called
 *                                          window.ai.complete(); proxy to
 *                                          /api/artifacts/complete (with the
 *                                          active modelId) and post
 *                                          __ai_complete_response back.
 *                                          `__claude_complete` accepted as a
 *                                          legacy alias.
 *
 * Sends to the iframe in response to the toolbar toggle:
 *   { type: '__activate_edit_mode' }     → show the in-page Tweaks panel
 *   { type: '__deactivate_edit_mode' }   → hide it
 *   { type: '__edit_mode_set_keys', edits } → push host-panel knob changes
 *                                          into the iframe so it can apply
 *                                          them live (CSS vars, hooks, etc).
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
 * On `__edit_mode_set_keys` (either direction), POSTs
 * `/api/projects/:id/tweak` which rewrites the EDITMODE-marked JSON
 * block in the active route's source file. The iframe will reload via
 * vite HMR with the new defaults.
 *
 * `available`, `defaults`, and `isCanvas` reset every time the iframe
 * navigates / reloads (the new page must re-announce). We hook this on
 * `load` events.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { loadModelId } from "../components/editor/ModelPicker";

/** Plain values you'd find in an EDITMODE block — the JSON the host
 *  panel knows how to render typed controls for. */
export type TweakValue = string | number | boolean;
export type TweakDefaults = Record<string, TweakValue>;

export type TweakBridge = {
  /** True when the current iframe page declared __edit_mode_available. */
  available: boolean;
  /** True when the user toggled live-tweak mode on. */
  editing: boolean;
  /** True when the current iframe page declared __page_is_canvas — i.e.
   *  it's a workshop (DesignCanvas) that owns its own viewport. The
   *  editor uses this to suppress device-frame display mode. */
  isCanvas: boolean;
  /** Defaults parsed from the EDITMODE-marked block, when the iframe's
   *  auto-bridge included them in __edit_mode_available. The host
   *  Tweaks sidebar uses this to render typed controls per key. Null
   *  when the iframe is the legacy kind that ships its own panel and
   *  doesn't expose its values to the host. */
  defaults: TweakDefaults | null;
  /** Push a partial edit to the iframe AND persist it via /tweak. Used
   *  by the host-side Tweaks panel; the iframe applies edits live via
   *  CSS variables / data-tweak hooks / window.__applyTweaks. */
  applyEdits: (edits: TweakDefaults) => void;
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
  const [defaults, setDefaults] = useState<TweakDefaults | null>(null);

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
      setDefaults(null);
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

  // Window-level message listener. Gate on origin AND source so only the
  // project iframe can post messages we act on — prevents any hostile
  // page framed inside an artifact from injecting tweak edits or
  // window.ai.complete() proxy calls.
  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      // Security: accept only same-origin messages from the known iframe.
      if (e.origin !== window.location.origin) return;
      const expectedSource = iframeRef.current?.contentWindow;
      if (expectedSource && e.source !== expectedSource) return;

      const data = e.data as
        | {
            type?: string;
            edits?: Record<string, unknown>;
            defaults?: Record<string, unknown>;
            id?: string;
            payload?: unknown;
          }
        | undefined;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "__edit_mode_available") {
        setAvailable(true);
        // The auto-bridge variant carries the parsed EDITMODE block as
        // `defaults`. Legacy iframe-shipped panels omit it; we fall
        // back to null and the host renders nothing of its own.
        const d = data.defaults;
        if (d && typeof d === "object" && !Array.isArray(d)) {
          const filtered: TweakDefaults = {};
          for (const [k, v] of Object.entries(d)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              filtered[k] = v;
            }
          }
          if (Object.keys(filtered).length > 0) setDefaults(filtered);
        }
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
        await persistEdits(projectIdRef.current, activeFileRef.current, edits);
        return;
      }
      if (data.type === "__ai_complete" || data.type === "__claude_complete") {
        // Artifact called window.ai.complete() (or the legacy
        // window.claude.complete()). Proxy to /api/artifacts/complete
        // with the user's currently-selected model so the server
        // dispatches through the right adapter (claude / kimi /
        // opencode / whatever opencode is fanning out to). Post the
        // response back to the originating iframe via e.source so we
        // route to the right window even if multiple iframes are
        // mounted — iframeRef may not be the one that fired this.
        // Origin is already validated at the top of this handler.
        //
        // Reply with both response types so artifacts authored against
        // the legacy `__claude_complete_response` listener still resolve.

        const id = typeof data.id === "string" ? data.id : null;
        const source = e.source as Window | null;
        if (!id || !source) return;
        const reply = (msg: { result?: string; error?: string }) => {
          const payload = { id, ...msg };
          try {
            source.postMessage(
              { type: "__ai_complete_response", ...payload },
              window.location.origin,
            );
            // Legacy alias for back-compat with artifacts that only
            // listen for __claude_complete_response.
            source.postMessage(
              { type: "__claude_complete_response", ...payload },
              window.location.origin,
            );
          } catch {
            /* iframe may have unmounted; nothing to do */
          }
        };
        const payload = data.payload;
        const body: Record<string, unknown> =
          typeof payload === "string"
            ? { prompt: payload }
            : (payload as Record<string, unknown> | null) ?? {};
        // Always tag the request with the active model so the server
        // can pickAdapter() exactly the same way the agent path does.
        // localStorage read; falls back to the global default when
        // unset (handled by pickAdapter on the server).
        body.modelId = loadModelId();

        const controller = new AbortController();
        const TIMEOUT_MS = 28_000;
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
          const res = await fetch("/api/artifacts/complete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          clearTimeout(timer);
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
          clearTimeout(timer);
          if (err instanceof Error && err.name === "AbortError") {
            reply({ error: "request timed out" });
          } else {
            reply({ error: err instanceof Error ? err.message : "fetch failed" });
          }
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
    // Use explicit origin — the iframe is always same-origin.
    try { w.postMessage({ type }, window.location.origin); } catch { /* ignore */ }
  }, [iframeRef]);

  /** Push partial edits from the host-side Tweaks panel into the iframe
   *  AND persist them via /api/projects/:id/tweak. Mirrors the path the
   *  iframe-shipped panel takes when it posts __edit_mode_set_keys to
   *  the parent — same code path, just driven from the other side. */
  const applyEdits = useCallback((edits: TweakDefaults) => {
    if (!edits || typeof edits !== "object") return;
    // Merge into the host's known defaults so the panel inputs reflect
    // the new value immediately (the iframe's `__applyTweaks` hook /
    // CSS variables are async-ish from the host's perspective).
    setDefaults((prev) => (prev ? { ...prev, ...edits } : { ...edits }));
    const w = iframeRef.current?.contentWindow;
    if (w) {
      // Use explicit origin — the iframe is always same-origin.
      try { w.postMessage({ type: "__edit_mode_set_keys", edits }, window.location.origin); } catch { /* ignore */ }
    }
    // Fire-and-forget — failures land in console.warn via persistEdits.
    void persistEdits(projectIdRef.current, activeFileRef.current, edits);
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

  return { available, editing, isCanvas, defaults, applyEdits, toggle, deactivate };
}

/** POST partial edits to /api/projects/:id/tweak so the EDITMODE-marked
 *  block on disk picks up the change. Shared between the iframe-driven
 *  message handler and the host-side panel's applyEdits callback so
 *  there's exactly one place that knows the URL shape. */
async function persistEdits(
  projectId: string,
  file: string,
  edits: Record<string, unknown>,
): Promise<void> {
  if (!projectId || !file) return;
  try {
    const res = await fetch(`/api/projects/${projectId}/tweak`, {
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
  // Use explicit origin — canvas iframes are always same-origin.
  try { w.postMessage({ type: "__dc_set_theme", tokens }, window.location.origin); } catch { /* ignore */ }
}
