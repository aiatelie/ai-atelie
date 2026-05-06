/* Editor theme switcher.
 *
 * Themes are CSS-variable overrides on :root[data-theme="..."] (see
 * index.css). Switching is just toggling that attribute. The user's
 * preference persists to localStorage and a 'editor-theme-change'
 * event fires so subscribed components can react.
 *
 * Preferences:
 *   - system → resolves to light/dark via prefers-color-scheme; flips
 *     live when macOS appearance changes mid-session
 *   - light  → no attribute (the original token set in :root)
 *   - dark   → data-theme="dark"
 *   - retro  → data-theme="retro" (decorative skin)
 *
 * Pre-existing "default" values in localStorage from the old two-mode
 * (default | retro) infrastructure are migrated to "system" on read. */

export type ThemePreference = "system" | "light" | "dark" | "retro";
/** Resolved theme — what `data-theme` actually gets set to. "system"
 *  collapses to "light" or "dark"; "retro" passes through. */
export type ResolvedTheme = "light" | "dark" | "retro";

export const themes: { name: ThemePreference; label: string }[] = [
  { name: "system", label: "System" },
  { name: "light", label: "Light" },
  { name: "dark", label: "Dark" },
  { name: "retro", label: "Retro" },
];

const KEY = "editor.theme";
const EVENT = "editor-theme-change";

function isPref(v: unknown): v is ThemePreference {
  return v === "system" || v === "light" || v === "dark" || v === "retro";
}

function readStoredPref(): ThemePreference {
  try {
    const saved = localStorage.getItem(KEY);
    if (isPref(saved)) return saved;
    if (saved === "default") return "system";
  } catch { /* localStorage may be blocked (sandboxed iframe, private mode). */ }
  return "system";
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return prefersDark() ? "dark" : "light";
  return pref;
}

let active: ThemePreference = readStoredPref();

function applyAttr(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  if (resolved === "light") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", resolved);
  }
}

applyAttr(resolve(active));

export function setTheme(pref: ThemePreference) {
  if (pref === active) return;
  active = pref;
  try { localStorage.setItem(KEY, pref); } catch { /* see above */ }
  applyAttr(resolve(pref));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { name: pref } }));
  }
}

export function getTheme(): ThemePreference {
  return active;
}

/** Resolved theme right now (system → light|dark). Useful for code that
 *  needs to branch on the actual visual mode rather than the preference. */
export function getResolvedTheme(): ResolvedTheme {
  return resolve(active);
}

if (typeof window !== "undefined") {
  // Cross-tab/cross-frame propagation: storage events fire in OTHER frames
  // of the same origin when localStorage changes.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || !isPref(e.newValue) || e.newValue === active) return;
    active = e.newValue;
    applyAttr(resolve(e.newValue));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { name: e.newValue } }));
  });

  // System-appearance changes propagate live when the user has "system"
  // selected — flip dark↔light without a refresh.
  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (active !== "system") return;
      applyAttr(resolve(active));
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { name: active } }));
    };
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else if (mql.addListener) mql.addListener(onChange); // Safari < 14
  }
}

// Backwards-compat re-export so existing call sites that imported
// `ThemeName` keep compiling. New code should use ThemePreference.
export type ThemeName = ThemePreference;
