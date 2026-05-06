/* runLogger.ts — per-stream log file.
 *
 * Each /api/comment-edit POST gets its own log at
 *   <RUN_LOGS_DIR>/<YYYY-MM-DD>/<streamId>.log
 *
 * Path is surfaced via /api/_debug/runs so when a turn hangs you have
 * an exact `tail -f` target. Logger is a thin wrapper around appendFile —
 * synchronous-feeling but actually serialized async writes so we never
 * block the request loop.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { ENV } from "../env.ts";

export type RunLogger = {
  /** Absolute path the log is being written to. */
  path: string;
  /** Append a line (newline added automatically). */
  log: (line: string) => void;
  /** Wait for any in-flight writes to flush (best-effort). */
  flush: () => Promise<void>;
  /** Close the logger; subsequent log() calls are silently dropped. */
  close: () => void;
};

function ymd(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function openRunLog(streamId: string): Promise<RunLogger> {
  const path = resolvePath(ENV.RUN_LOGS_DIR, ymd(), `${streamId}.log`);
  await mkdir(dirname(path), { recursive: true }).catch(() => { /* best-effort */ });

  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const log = (line: string) => {
    if (closed) return;
    const stamp = new Date().toISOString();
    const entry = `${stamp} ${line}\n`;
    // Serialize writes via a tail-pinned promise chain. Each append waits
    // for the previous one before it starts, so we never get interleaved
    // partial lines from concurrent log() calls.
    queue = queue.then(() => appendFile(path, entry, "utf8")).catch(() => { /* drop */ });
  };

  return {
    path,
    log,
    flush: () => queue,
    close: () => { closed = true; },
  };
}
