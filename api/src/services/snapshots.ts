/* snapshots.ts — disk-backed per-turn project snapshots for /api/comment-undo.
 *
 * Each comment-edit turn snapshots the project (or legacy editor src/) so
 * /api/comment-undo can revert. Snapshots live in workspace-scope JsonKv
 * under keys `snapshot-<turnId>` so they survive daemon restart and
 * `bun --watch` reloads — closes #11.
 *
 * Workspace scope (rather than project scope) means a single
 * /api/comment-undo lookup by turnId works without knowing the projectId.
 * The trade-off is that deleting a project leaves its snapshots dangling
 * until the LRU evicts them — acceptable because the LRU caps total
 * count at SNAPSHOTS_MAX_TOTAL.
 *
 * The legacy case (`projectId === null`, agent edits the SPA's own
 * `web/src/`) shares the same store — apply() routes through the
 * filesystem instead of ProjectFilesRepo for that scope.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative as relPath, resolve as resolvePath } from "node:path";
import { ENV } from "../env.ts";
import { getRepos } from "../storage/repos/index.ts";

const SNAP_KEY_PREFIX = "snapshot-";
const SNAPSHOTS_MAX_TOTAL = 64;
// JsonKv keys must be /^[a-zA-Z0-9_-]+$/ — turnIds from randomUUID() are
// hex+hyphens which match.
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/;

export type SnapshotFile = { path: string; contents: string };

export type SnapshotEntry = {
  turnId: string;
  /** null = legacy LEGACY_EDITOR_ROOT/src case (the SPA's own source). */
  projectId: string | null;
  createdAt: number;
  /** Paths are scope-relative:
   *  - projectId set → relative to project root (e.g. "index.html")
   *  - projectId null → relative to LEGACY_EDITOR_ROOT/src (e.g. "components/Foo.tsx")
   */
  files: SnapshotFile[];
};

/* ─── Walk helpers ──────────────────────────────────────────────────
 *
 * `walk` is also imported by routes/files.ts for the legacy file tree.
 */

export async function* walk(dir: string, opts: { allExt?: boolean } = {}): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full, opts);
    } else if (entry.isFile()) {
      const re = opts.allExt
        ? /\.(html?|tsx?|jsx?|css|json|svg|md|txt)$/i
        : /\.(tsx?|jsx?|css|json)$/;
      if (re.test(entry.name)) yield full;
    }
  }
}

/* ─── Capture: walk current state of disk into a snapshot entry ──── */

async function captureProject(projectId: string): Promise<SnapshotFile[]> {
  const allowExt = /\.(html?|tsx?|jsx?|css|json|svg|md|txt)$/i;
  const files: SnapshotFile[] = [];
  const list = await getRepos().projectFiles.list(projectId);
  for (const f of list.files) {
    if (!allowExt.test(f.name)) continue;
    const result = await getRepos().projectFiles.readText(projectId, f.path);
    if (result.ok) files.push({ path: f.path, contents: result.text });
  }
  return files;
}

async function captureLegacy(): Promise<SnapshotFile[]> {
  const root = resolvePath(ENV.LEGACY_EDITOR_ROOT, "src");
  const files: SnapshotFile[] = [];
  for await (const abs of walk(root, { allExt: false })) {
    try {
      const contents = await readFile(abs, "utf8");
      files.push({ path: relPath(root, abs), contents });
    } catch { /* skip unreadable */ }
  }
  return files;
}

/* ─── Public API ───────────────────────────────────────────────────── */

/** Capture the project (or legacy) state and persist a snapshot keyed
 *  by `turnId`. Returns null on failure — callers treat snapshot as
 *  best-effort and continue without undo. */
export async function recordSnapshot(turnId: string, projectId: string | null): Promise<SnapshotEntry | null> {
  if (!SAFE_KEY_RE.test(turnId)) return null;
  try {
    const files = projectId
      ? await captureProject(projectId)
      : await captureLegacy();
    const entry: SnapshotEntry = {
      turnId,
      projectId,
      createdAt: Date.now(),
      files,
    };
    const result = await getRepos().shared.put(SNAP_KEY_PREFIX + turnId, entry);
    if (!result.ok) return null;
    // Best-effort prune; failures here don't block the turn.
    pruneOld().catch((err) => {
      console.warn(`[snapshots] prune failed:`, err instanceof Error ? err.message : err);
    });
    return entry;
  } catch (err) {
    console.warn(`[snapshots] record failed turnId=${turnId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getSnapshot(turnId: string): Promise<SnapshotEntry | null> {
  if (!SAFE_KEY_RE.test(turnId)) return null;
  const result = await getRepos().shared.get<SnapshotEntry>(SNAP_KEY_PREFIX + turnId);
  if (!result.ok) return null;
  return result.value;
}

export async function deleteSnapshot(turnId: string): Promise<void> {
  if (!SAFE_KEY_RE.test(turnId)) return;
  await getRepos().shared.delete(SNAP_KEY_PREFIX + turnId);
}

/** Restore the snapshot's files to disk. Returns the number of files
 *  whose contents differed from current and were rewritten. */
export async function applySnapshot(snap: SnapshotEntry): Promise<{ reverted: number }> {
  let reverted = 0;
  if (snap.projectId) {
    const files = getRepos().projectFiles;
    for (const { path, contents } of snap.files) {
      const cur = await files.readText(snap.projectId, path);
      if (cur.ok && cur.text === contents) continue;
      await files.write(snap.projectId, path, contents);
      reverted++;
    }
  } else {
    const root = resolvePath(ENV.LEGACY_EDITOR_ROOT, "src");
    for (const { path, contents } of snap.files) {
      const abs = resolvePath(root, path);
      try {
        const cur = await readFile(abs, "utf8");
        if (cur === contents) continue;
        await writeFile(abs, contents, "utf8");
        reverted++;
      } catch { /* missing file or unreadable; skip */ }
    }
  }
  return { reverted };
}

/** Files that have been modified vs the snapshot. Used by the
 *  comment-edit timeout/abort branch to tell the user what landed. */
export async function diffSnapshot(snap: SnapshotEntry): Promise<{ modified: string[] }> {
  const modified: string[] = [];
  if (snap.projectId) {
    const files = getRepos().projectFiles;
    for (const { path, contents } of snap.files) {
      const cur = await files.readText(snap.projectId, path);
      if (cur.ok && cur.text === contents) continue;
      modified.push(path);
    }
  } else {
    const root = resolvePath(ENV.LEGACY_EDITOR_ROOT, "src");
    for (const { path, contents } of snap.files) {
      const abs = resolvePath(root, path);
      try {
        const cur = await readFile(abs, "utf8");
        if (cur === contents) continue;
        modified.push(path);
      } catch { /* skip */ }
    }
  }
  return { modified };
}

/* ─── LRU prune ────────────────────────────────────────────────────── */

async function pruneOld(): Promise<void> {
  const shared = getRepos().shared;
  const keys = await shared.list();
  const snapKeys = keys.filter((k) => k.startsWith(SNAP_KEY_PREFIX));
  if (snapKeys.length <= SNAPSHOTS_MAX_TOTAL) return;
  const entries: Array<{ key: string; createdAt: number }> = [];
  for (const k of snapKeys) {
    const r = await shared.get<SnapshotEntry>(k);
    if (r.ok && r.value && typeof r.value.createdAt === "number") {
      entries.push({ key: k, createdAt: r.value.createdAt });
    } else {
      await shared.delete(k);
    }
  }
  entries.sort((a, b) => a.createdAt - b.createdAt);
  const excess = entries.length - SNAPSHOTS_MAX_TOTAL;
  for (let i = 0; i < excess; i++) {
    await shared.delete(entries[i].key);
  }
}
