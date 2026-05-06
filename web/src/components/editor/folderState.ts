/* folderState.ts — per-project persistence for the FileBrowserView's
 * folder-collapse state. Mirrors `recents.ts`: tiny module, localStorage,
 * silent-drop on quota/private-mode failures.
 *
 * The browser groups files into "folders" by their first path segment
 * (e.g. "uploads/foo.png" → folder "uploads"). Each folder is open or
 * closed; the user toggles via the chevron row. Without persistence the
 * state resets on every project switch, so a user who collapsed
 * "uploads" once has to collapse it again every time they reopen the
 * project — issue #40 Phase 1. */

const FOLDERS_PREFIX = "cc-folders-open:";

export function folderStateKey(projectId: string): string {
  return `${FOLDERS_PREFIX}${projectId}`;
}

/** Read the persisted "is this folder open?" map for the project.
 *  Returns `{}` (every folder closed by default) when nothing is
 *  stored, the JSON is corrupt, or storage is inaccessible. */
export function readFolderState(projectId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(folderStateKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch { return {}; }
}

/** Persist the folder-collapse map. Drops silently on quota /
 *  private-mode failures — the live React state stays correct, the
 *  user just loses persistence in that one edge environment. */
export function writeFolderState(projectId: string, state: Record<string, boolean>): void {
  try { localStorage.setItem(folderStateKey(projectId), JSON.stringify(state)); }
  catch { /* quota or private mode — silently drop */ }
}
