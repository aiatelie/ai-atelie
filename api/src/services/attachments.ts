/* attachments.ts — diagnostic screenshots + user-attached binaries.
 *
 * Iframe screenshots are diagnostic context for the AI and stay in
 * SCREENSHOT_TMP_ROOT/<projectId|_workspace>/. Things the user actively
 * *attached* (paste/drop) are part of the project itself — they live at
 * <projectDir>/uploads/ so the AI can reference them from code with a
 * stable relative path. No binary-copy primitive needed in the AI's toolbox.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataUrlToImage } from "./utils.ts";
import { screenshotDirFor } from "../env.ts";
import type { Attachment } from "./types.ts";

export async function saveScreenshot(b64: string, projectId?: string): Promise<string> {
  const dir = screenshotDirFor(projectId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `comment-${Date.now()}.png`);
  await writeFile(path, Buffer.from(b64, "base64"));
  return path;
}

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

function extForMediaType(mediaType: string): string {
  return EXT_BY_MEDIA_TYPE[mediaType] ?? "bin";
}

function sanitizeAttachmentStem(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "image";
  const stem = base.replace(/\.[^.]+$/, "") || "image";
  const safe = stem
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.slice(0, 40) || "image";
}

/** Write a user attachment into <projectDir>/uploads/ and return both
 *  the absolute and project-relative paths. The relative path is what
 *  goes into prompts and into the JSX the AI eventually edits. */
export async function saveAttachmentToProject(
  projectDir: string,
  attachment: Attachment,
): Promise<{ absPath: string; relPath: string } | null> {
  const parsed = dataUrlToImage(attachment.dataUrl);
  if (!parsed) return null;
  const ext = extForMediaType(parsed.mediaType);
  const stem = sanitizeAttachmentStem(attachment.name);
  // Timestamp suffix avoids collisions without a stat round-trip.
  const stamp = Date.now().toString(36);
  const tail = Math.random().toString(36).slice(2, 6);
  const filename = `${stem}-${stamp}${tail}.${ext}`;
  const uploadsDir = join(projectDir, "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const absPath = join(uploadsDir, filename);
  await writeFile(absPath, Buffer.from(parsed.data, "base64"));
  return { absPath, relPath: `uploads/${filename}` };
}
