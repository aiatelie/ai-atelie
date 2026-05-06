/* Editor theme switcher.
 *
 * Themes are CSS-variable overrides on :root[data-theme="..."] (see
 * index.css). Switching is just toggling that attribute. The choice
 * persists to localStorage and a 'editor-theme-change' event fires so
 * subscribed components can react. Default theme has no attribute. */

export type ThemeName = "default" | "retro";

export const themes: { name: ThemeName; label: string }[] = [
  { name: "default", label: "Default" },
  { name: "retro", label: "Retro" },
];

const KEY = "editor.theme";
const EVENT = "editor-theme-change";

function isThemeName(v: unknown): v is ThemeName {
  return v === "default" || v === "retro";
}

let active: ThemeName = "default";
try {
  const saved = localStorage.getItem(KEY);
  if (isThemeName(saved)) active = saved;
} catch {
  // localStorage may be blocked (sandboxed iframe, private mode) — fall through.
}

function applyAttr(name: ThemeName) {
  if (typeof document === "undefined") return;
  if (name === "default") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", name);
  }
}

applyAttr(active);

export function setTheme(name: ThemeName) {
  if (name === active) return;
  active = name;
  try { localStorage.setItem(KEY, name); } catch { /* see above */ }
  applyAttr(name);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { name } }));
  }
}

export function getTheme(): ThemeName {
  return active;
}

// Cross-tab/cross-frame propagation: storage events fire in OTHER frames
// of the same origin when localStorage changes.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || !isThemeName(e.newValue) || e.newValue === active) return;
    active = e.newValue;
    applyAttr(e.newValue);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { name: e.newValue } }));
  });
}
