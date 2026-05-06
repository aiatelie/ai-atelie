// Persisted style overrides per (route, selector). Replayed when an iframe
// loads to restore the visual state.

import { useEffect, useState } from "react";
import { trackEvent } from "./telemetry";

export type StyleProps = Record<string, string>;
export type RouteOverrides = Record<string /* selector */, StyleProps>;
export type AllOverrides = Record<string /* route */, RouteOverrides>;

const KEY = "editor-overrides.v1";

export function readAll(): AllOverrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AllOverrides) : {};
  } catch {
    return {};
  }
}

export function writeAll(all: AllOverrides) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
  // Notify subscribers (the toolbar's "Save N edits" badge etc.) that
  // the override map changed. Custom event keeps this lib free of any
  // React/store imports for code that just calls set/clear.
  if (typeof window !== "undefined") {
    try { window.dispatchEvent(new CustomEvent("editor-overrides:change")); }
    catch { /* ignore */ }
  }
}

export function readRoute(route: string): RouteOverrides {
  return readAll()[route] ?? {};
}

export function setOverride(route: string, selector: string, prop: string, value: string) {
  const all = readAll();
  const r = all[route] ?? {};
  const sel = r[selector] ?? {};
  if (value === "") delete sel[prop];
  else sel[prop] = value;
  if (Object.keys(sel).length === 0) delete r[selector];
  else r[selector] = sel;
  if (Object.keys(r).length === 0) delete all[route];
  else all[route] = r;
  writeAll(all);
  trackEvent("override_apply", { route, prop });
}

export function clearRoute(route: string) {
  const all = readAll();
  delete all[route];
  writeAll(all);
  trackEvent("override_clear", { route });
}

/** Subscribe to the count of overrides for a single route. Re-reads on
 *  every `editor-overrides:change` event (fired by writeAll) so the
 *  toolbar can show a live "Save N edits" badge without polling. */
export function useOverrideCount(route: string): number {
  const [count, setCount] = useState(() => Object.keys(readRoute(route)).length);
  useEffect(() => {
    const recompute = () => setCount(Object.keys(readRoute(route)).length);
    recompute();
    window.addEventListener("editor-overrides:change", recompute);
    return () => window.removeEventListener("editor-overrides:change", recompute);
  }, [route]);
  return count;
}

// Apply every override for a given route to its document. Used on iframe load.
export function applyOverrides(doc: Document, route: string) {
  const r = readRoute(route);
  for (const [selector, props] of Object.entries(r)) {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (!el) continue;
    for (const [k, v] of Object.entries(props)) {
      // setProperty handles kebab-case ("border-radius"). Priority must
      // be "important" so the live preview beats _inspector_edits.css —
      // that file uses !important to beat source rules, and an inline
      // style without !important loses the cascade duel.
      el.style.setProperty(k, v, "important");
    }
  }
}
