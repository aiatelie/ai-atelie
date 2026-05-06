/* snapshots.ts — bounded-LRU per-turn file snapshot store for /api/comment-undo.
 *
 * Every comment-edit turn snapshots its project before the AI runs so
 * /api/comment-undo can revert. Without a cap, long sessions across many
 * projects accumulated snapshots forever (each one holds every file's
 * contents in memory). 64 is plenty for "undo the last few turns";
 * older snapshots silently fall off (Map iteration order is insertion
 * order, so the first key is oldest). */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Snapshot = Map<string, string>; // absPath → contents

const SNAPSHOTS_MAX = 64;
const snapshots = new Map<string, Snapshot>(); // turnId → snapshot

export function recordSnapshot(turnId: string, snap: Snapshot): void {
  snapshots.set(turnId, snap);
  while (snapshots.size > SNAPSHOTS_MAX) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function getSnapshot(turnId: string): Snapshot | undefined {
  return snapshots.get(turnId);
}

export function deleteSnapshot(turnId: string): void {
  snapshots.delete(turnId);
}

/** Recursive walk used to populate snapshots from a project dir or the
 *  legacy editor src/. The `allExt` flag broadens the file filter for
 *  sandbox projects (html/jsx/css/json/svg/md/txt vs the legacy tsx/jsx/
 *  css/json filter). */
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

export async function snapshotDir(absDir: string, allExt: boolean): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  for await (const p of walk(absDir, { allExt })) {
    try { snap.set(p, await readFile(p, "utf8")); }
    catch { /* skip unreadable */ }
  }
  return snap;
}

export async function applySnapshot(snap: Snapshot): Promise<{ reverted: number }> {
  let reverted = 0;
  for (const [path, contents] of snap) {
    try {
      const cur = await readFile(path, "utf8");
      if (cur === contents) continue;
      await writeFile(path, contents, "utf8");
      reverted++;
    } catch { /* missing file; skip */ }
  }
  return { reverted };
}

/** Compute which files in `snap` have been modified vs the snapshot.
 *  Used when a turn aborts/times out so we can tell the user what the
 *  AI actually accomplished before the cliff-edge. Files added since
 *  the snapshot are tracked separately (we'd need a project-walk to
 *  detect them; keeping it simple — only tracks changes to files that
 *  existed at snapshot time). */
export async function diffSnapshot(snap: Snapshot, rootDir: string): Promise<{ modified: string[] }> {
  const modified: string[] = [];
  for (const [path, contents] of snap) {
    try {
      const cur = await readFile(path, "utf8");
      if (cur === contents) continue;
      // Show project-relative paths so the message reads cleanly.
      const rel = path.startsWith(rootDir + "/") ? path.slice(rootDir.length + 1) : path;
      modified.push(rel);
    } catch { /* file deleted or unreadable — skip */ }
  }
  return { modified };
}
