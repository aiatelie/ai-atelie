/* recents.ts — tiny shared utility for "recently opened files" tracking.
 * Keyed by projectId so each project keeps its own list. Used by both
 * FileBrowserView (Recent section) and QuickSwitcher (empty-query view). */

const RECENTS_PREFIX = "cc-recents:";
export const RECENTS_LIMIT = 6;

export function recentsKey(projectId: string): string {
  return `${RECENTS_PREFIX}${projectId}`;
}

export function readRecents(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(recentsKey(projectId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export function writeRecents(projectId: string, paths: string[]): void {
  try { localStorage.setItem(recentsKey(projectId), JSON.stringify(paths.slice(0, RECENTS_LIMIT))); }
  catch { /* quota or private mode — silently drop */ }
}

export function pushRecent(projectId: string, path: string): string[] {
  const prev = readRecents(projectId);
  const next = [path, ...prev.filter((p) => p !== path)].slice(0, RECENTS_LIMIT);
  writeRecents(projectId, next);
  return next;
}
