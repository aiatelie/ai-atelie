/* exportArtifacts.ts — every export saves into a project's exports/ dir
 * and is referenced by URL after that. Both the toolbar (which fetches
 * the URL to trigger a download) and the AI (which surfaces the URL in
 * its tool result so the chat ArtifactCard can render it inline) read
 * from the same shape.
 *
 * No more streaming raw bytes through chat — the AI sees a small JSON
 * envelope; the host renders the artifact from disk via the existing
 * /p/<id>/exports/<file> static route.
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve as resolvePath, extname, basename } from "node:path";

export type ArtifactKind = "image" | "video" | "html-graphics" | "lottie" | "asset";

export type ArtifactResult = {
  ok: true;
  kind: ArtifactKind;
  /** Final on-disk filename (after sanitization + collision-suffixing). */
  filename: string;
  /** Path relative to the project root, useful when AI / future code
   *  wants to address the file via the project's own filesystem. */
  projectRelativePath: string;
  /** URL the host can use to fetch the artifact (download / preview).
   *  Same /p/<id>/... route every other project asset uses. */
  url: string;
  /** MIME from the caller — informs the chat card on how to preview. */
  mime: string;
  bytes: number;
  /** Free-form per-kind metadata (width/height for images, duration/fps
   *  for video, etc.). Surfaces in the chat card's secondary line. */
  metadata?: Record<string, unknown>;
};

export type ArtifactInput = {
  /** Project to save into — `web/projects/<projectId>/exports/`. Must
   *  already pass projectDirOf() validation in the caller. */
  projectDir: string;
  /** Project id used to construct the public URL. */
  projectId: string;
  /** AI- or user-chosen basename, without extension. Will be sanitized
   *  to filesystem-safe characters; if a name collision exists, suffix
   *  '-2', '-3', ... up to 50 attempts. */
  basename: string;
  /** File extension (without the dot). Forced lowercase. */
  ext: string;
  kind: ArtifactKind;
  mime: string;
  bytes: Buffer;
  metadata?: Record<string, unknown>;
};

const SAFE_NAME = /[^A-Za-z0-9._-]/g;
const MAX_NAME_LEN = 80;

function sanitize(name: string): string {
  const cleaned = name.replace(SAFE_NAME, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, MAX_NAME_LEN) || "export";
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Resolve a non-colliding filename inside `dir`. Tries the bare name
 *  first, then -2, -3, ... up to MAX_TRIES. Returns the absolute path
 *  to write to and the final filename to surface. */
async function resolveUniqueName(dir: string, base: string, ext: string): Promise<{ filename: string; absPath: string }> {
  const MAX_TRIES = 50;
  let candidate = `${base}.${ext}`;
  for (let i = 0; i < MAX_TRIES; i++) {
    const abs = resolvePath(dir, candidate);
    if (!(await exists(abs))) return { filename: candidate, absPath: abs };
    candidate = `${base}-${i + 2}.${ext}`;
  }
  // Highly unlikely; fall through with a uuid-ish suffix.
  candidate = `${base}-${Date.now()}.${ext}`;
  return { filename: candidate, absPath: resolvePath(dir, candidate) };
}

/** Persist bytes to web/projects/<projectId>/exports/ and return the
 *  ArtifactResult both the toolbar and the AI will consume. */
export async function saveArtifact(input: ArtifactInput): Promise<ArtifactResult> {
  const exportsDir = resolvePath(input.projectDir, "exports");
  await mkdir(exportsDir, { recursive: true });

  const cleanBase = sanitize(input.basename);
  const cleanExt = input.ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const { filename, absPath } = await resolveUniqueName(exportsDir, cleanBase, cleanExt);

  await writeFile(absPath, input.bytes);

  return {
    ok: true,
    kind: input.kind,
    filename,
    projectRelativePath: `exports/${filename}`,
    url: `/p/${encodeURIComponent(input.projectId)}/exports/${encodeURIComponent(filename)}`,
    mime: input.mime,
    bytes: input.bytes.byteLength,
    metadata: input.metadata,
  };
}

/** Helper for callers that received a name like 'photo.png' and want to
 *  split off the extension. Returns the base + ext (no dots). */
export function splitFilename(filename: string): { base: string; ext: string } {
  const ext = extname(filename).replace(/^\./, "").toLowerCase();
  const base = basename(filename, ext ? `.${ext}` : "");
  return { base, ext };
}
