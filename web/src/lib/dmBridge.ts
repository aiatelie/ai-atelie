/* dmBridge.ts — typed parent-side wrapper for the inject-script bus.
 *
 * The inject-script (web/public/inject-script.js) runs inside the iframe
 * and posts `{ __DM_MSG__: ... }` to window.parent. We send commands the
 * other way as `{ __DM_CMD__: ... }`.
 *
 * Usage:
 *   const dm = new DmBridge(iframe);
 *   dm.on("ready", () => dm.send({ type: "ping" }));
 *   dm.on("pong", () => …);
 *   dm.send({ type: "setStyles", ref, styles: { color: "red" } });
 *   dm.dispose();
 */

export type DmInbound =
  | { type: "ready"; v: number }
  | { type: "pong" }
  | { type: "selection"; ref: string | null; tag?: string; rect?: { x: number; y: number; w: number; h: number }; computed?: Record<string, string>; innerText?: string; descriptor?: import("./cssPath").ElementDescriptor }
  | { type: "hover"; ref: string | null; rect?: { x: number; y: number; w: number; h: number }; tag?: string }
  | { type: "rect"; ref: string; rect: { x: number; y: number; w: number; h: number } }
  | { type: "undoDepth"; depth: number; empty?: boolean; restored?: boolean }
  | { type: "positionModeChanged"; ref: string; mode: string; before: string }
  /** A JS throw or unhandled promise rejection inside the iframe.
   *  The inject-script's window.onerror / unhandledrejection listeners
   *  forward these so the host can render an in-canvas overlay. Same-
   *  origin iframe makes this possible — sandboxed previews can't do it. */
  | { type: "runtime-error"; message: string; filename?: string | null; lineno?: number | null; colno?: number | null; stack?: string | null; source: "error" | "unhandledrejection"; timestamp: number }
  /** Legacy: pre-rewrite snapshot event. Kept for back-compat. New
   *  clients should listen on `undoDepth` instead. */
  | { type: "snapshot"; depth: number; empty?: boolean; restored?: boolean };

export type DmOutbound =
  | { type: "ping" }
  | { type: "pick"; x: number; y: number; select?: boolean; extend?: boolean }
  | { type: "hoverRef"; ref: string | null }
  | { type: "describe"; ref: string }
  | { type: "setStyles"; ref: string; styles: Record<string, string> }
  | { type: "setText"; ref: string; text: string }
  | { type: "setPositionMode"; ref: string; mode: "static" | "relative" | "absolute" | "fixed" }
  | { type: "snapshot" }
  | { type: "undo" };

type Listener = (msg: DmInbound) => void;

export class DmBridge {
  private listeners = new Set<Listener>();
  private win: Window | null;
  private boundOnMsg = this.onMsg.bind(this);
  /** Inject-script ready? Resolves on first `ready` message. */
  readonly ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(iframe: HTMLIFrameElement) {
    this.win = iframe.contentWindow;
    this.ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });
    window.addEventListener("message", this.boundOnMsg);
  }

  /** Idempotently inject inject-script.js into the iframe doc. */
  static inject(iframe: HTMLIFrameElement): boolean {
    const doc = iframe.contentDocument;
    if (!doc) return false;
    if (doc.querySelector('script[data-dm="inject"]')) return true;
    const s = doc.createElement("script");
    s.src = "/inject-script.js";
    s.dataset.dm = "inject";
    s.async = false;
    doc.body.appendChild(s);
    return true;
  }

  /** Idempotently add the inspector-edits stylesheet link to the iframe.
   *  The page resolves `_inspector_edits.css` against the project's
   *  static-served base (`/p/<id>/...`), so a project-relative href just
   *  works. If the file doesn't exist yet, the browser logs a benign
   *  404 — first save creates it.
   *
   *  We append a cache-buster `?t=<timestamp>` so the iframe reload
   *  after a Save action picks up the new file even if the browser
   *  cached the old one. Pass `bust` to force a unique URL. */
  static injectInspectorCSS(iframe: HTMLIFrameElement, bust?: number): boolean {
    const doc = iframe.contentDocument;
    if (!doc) return false;
    const existing = doc.querySelector('link[data-dm="inspector-css"]') as HTMLLinkElement | null;
    const href = `_inspector_edits.css${bust ? `?t=${bust}` : ""}`;
    if (existing) {
      if (bust) existing.href = href;
      return true;
    }
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.dm = "inspector-css";
    doc.head.appendChild(link);
    return true;
  }

  send(cmd: DmOutbound) {
    if (!this.win) return;
    try { this.win.postMessage({ __DM_CMD__: cmd }, "*"); } catch { /* ignore */ }
  }

  on(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  dispose() {
    window.removeEventListener("message", this.boundOnMsg);
    this.listeners.clear();
    this.win = null;
  }

  private onMsg(e: MessageEvent) {
    if (!this.win || e.source !== this.win) return;
    const data = e.data as { __DM_MSG__?: DmInbound } | undefined;
    if (!data || !data.__DM_MSG__) return;
    const msg = data.__DM_MSG__;
    if (msg.type === "ready") this.resolveReady();
    for (const l of this.listeners) l(msg);
  }
}
