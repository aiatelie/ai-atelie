/* maintenance.ts — boot-time housekeeping. */

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ENV } from "../env.ts";

/** Best-effort cleanup of stale diagnostic screenshots on server boot.
 *  Without this the screenshot dir grows without bound (149+ files
 *  observed in practice). Only deletes files older than 24h. */
export async function purgeOldScreenshots(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const walk = async (dir: string) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      try {
        const st = await stat(p);
        if (st.mtimeMs < cutoff) await unlink(p);
      } catch { /* ignore */ }
    }
  };
  await walk(ENV.SCREENSHOT_TMP_ROOT);
}
