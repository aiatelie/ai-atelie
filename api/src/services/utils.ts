/* utils.ts — small filesystem + data-url helpers shared across routes. */

import { stat } from "node:fs/promises";
import { resolve as resolvePath, extname } from "node:path";

export async function safeStat(p: string) {
  try { return await stat(p); } catch { return null; }
}

export function mimeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

/** Resolve a relative path to an absolute path *inside* `root`, rejecting
 *  any traversal that escapes the root. Returns null on invalid input.
 *  With `mustExist: false`, doesn't require the file to exist (used for
 *  upload destinations). */
export function safeUnder(root: string, rel: string, opts: { mustExist?: boolean } = {}): string | null {
  if (!rel || typeof rel !== "string") return null;
  if (rel.includes("\0")) return null;
  const abs = resolvePath(root, rel);
  if (!abs.startsWith(root + "/") && abs !== root) return null;
  if (opts.mustExist === false) return abs;
  return abs;
}

export function parseAnyDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

export function dataUrlToImage(dataUrl: string): { mediaType: string; data: string } | null {
  const m = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}
