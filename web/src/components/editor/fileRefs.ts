/* fileRefs.ts — shared text-extraction helpers for the file panels.
 * Used by ContextualFilesPanel for "Referenced" (forward) AND "Used by"
 * (reverse) lookups. Regex-based, so cheap to run; not a real parser. */

export const REFERENCE_PATTERNS: RegExp[] = [
  /(?:href|src)\s*=\s*["']([^"']+)["']/g,           // HTML attributes
  /@import\s+(?:url\()?["']([^"']+)["']/g,         // CSS @import
  /url\(\s*["']?([^"')]+)["']?\s*\)/g,             // CSS url()
  /\bimport\s+(?:[^"'`]+\s+from\s+)?["']([^"']+)["']/g, // ES imports
];

/** Return every project-relative path referenced from `text`, resolved
 *  against `fromPath`'s directory. External URLs / data URIs / anchors
 *  are filtered out. */
export function extractReferences(text: string, fromPath: string): string[] {
  const out = new Set<string>();
  const baseDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : "";
  for (const re of REFERENCE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const ref = m[1].trim();
      const resolved = resolveRef(ref, baseDir);
      if (resolved) out.add(resolved);
    }
  }
  return Array.from(out);
}

/** True if `text` (originating at `fromPath`) references `targetPath`.
 *  Cheap pre-check first: bail out if the basename doesn't appear at
 *  all, so we don't run the four regex passes on every project file. */
export function referencesPath(text: string, fromPath: string, targetPath: string): boolean {
  const targetName = targetPath.includes("/") ? targetPath.slice(targetPath.lastIndexOf("/") + 1) : targetPath;
  if (!text.includes(targetName)) return false;
  for (const ref of extractReferences(text, fromPath)) {
    if (ref === targetPath) return true;
  }
  return false;
}

export function resolveRef(ref: string, baseDir: string): string | null {
  if (!ref) return null;
  if (ref.startsWith("#")) return null;
  if (/^[a-z]+:/i.test(ref)) return null;
  if (ref.startsWith("//")) return null;
  if (ref.startsWith("/")) return ref.slice(1);
  const clean = ref.split("?")[0].split("#")[0];
  if (!clean) return null;
  return normalize(baseDir + clean);
}

export function normalize(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

/** Files we'll scan for backlinks. Anything text-based that could plausibly
 *  reference a CSS/component/asset. Excludes images, PDFs, video, etc. */
export function isScannable(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i === -1) return false;
  const ext = name.slice(i + 1).toLowerCase();
  return ext === "html" || ext === "htm" || ext === "css" || ext === "js"
    || ext === "mjs" || ext === "jsx" || ext === "tsx" || ext === "ts" || ext === "json";
}
