/* exportRender.ts — bridge to playwright-tools/export-element.mjs.
 *
 * Spawns the script as a child Node process, pipes JSON args via stdin,
 * parses the stdout result line, reads the temp file the script wrote,
 * and returns the bytes. Cleans up the temp file after.
 *
 * Why spawn instead of importing playwright directly?
 *   - playwright is a 150MB dep with a Chromium binary; we already have it
 *     installed in /playwright-tools and don't want to duplicate it in
 *     web/node_modules.
 *   - keeps the dev server's process clean (no zombie Chromium if Vite
 *     restarts during a render).
 */

import { spawn } from "node:child_process";
import { readFile, unlink, access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { ENV } from "../env.ts";

const PLAYWRIGHT_TOOLS_DIR = ENV.PLAYWRIGHT_TOOLS_DIR;
const SCRIPT_PATH = resolvePath(PLAYWRIGHT_TOOLS_DIR, "export-element.mjs");

export type RenderArgs = {
  url: string;
  selector: string;
  scale?: number;
  format?: "png" | "jpeg" | "jpg";
  backgroundColor?: "transparent" | "white" | null;
  /** JPEG only, 0–100 (Playwright's scale; not 0–1 like canvas.toDataURL). */
  quality?: number;
  /** Page viewport in CSS px. Larger viewport = more of the page laid out
   *  before screenshot, but locator.screenshot() only returns the element's
   *  own bbox, so this mostly affects layout decisions for responsive CSS. */
  viewport?: { w: number; h: number };
  timeoutMs?: number;
};

export type RenderResult = {
  /** Raw image bytes — png or jpeg per `format`. */
  bytes: Buffer;
  format: "png" | "jpeg";
};

/** Once-per-process probe to verify the script is on disk. Returns the
 *  reason the renderer is unavailable, or null if everything looks fine.
 *  Doesn't actually launch Chromium — that happens per-render. */
let probedReason: string | null | undefined;
export async function exportRendererAvailability(): Promise<string | null> {
  if (probedReason !== undefined) return probedReason;
  try {
    await access(SCRIPT_PATH);
    probedReason = null;
  } catch {
    probedReason = `playwright-tools/export-element.mjs not found at ${SCRIPT_PATH}`;
  }
  return probedReason;
}

export async function renderElement(args: RenderArgs): Promise<RenderResult> {
  const unavailable = await exportRendererAvailability();
  if (unavailable) throw new Error(unavailable);

  const child = spawn(process.execPath, [SCRIPT_PATH], {
    cwd: PLAYWRIGHT_TOOLS_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Buffer the stdio bytes — `chunk.toString("utf8")` can corrupt
  // multi-byte characters split across data events, and `exit` fires
  // before flush finishes. Use Buffer.concat after `close`.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => { stdoutChunks.push(d); });
  child.stderr.on("data", (d: Buffer) => { stderrChunks.push(d); });

  child.stdin.write(JSON.stringify(args));
  child.stdin.end();

  const exitCode: number = await new Promise((res, rej) => {
    child.on("close", (code) => res(code ?? -1));
    child.on("error", rej);
  });
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  // The script prints one JSON line on stdout. Find it (there might be
  // stray Playwright/browser logs on stdout or stderr).
  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  let result: { ok: boolean; path?: string; bytes?: number; error?: string } | null = null;
  if (line) {
    try { result = JSON.parse(line); } catch { /* fall through */ }
  }

  if (!result) {
    throw new Error(
      `export-element produced no parseable result (exit=${exitCode}). ` +
      `stderr: ${stderr.trim().slice(0, 400)}`,
    );
  }

  if (!result.ok || !result.path) {
    throw new Error(`export-element failed: ${result.error ?? "unknown"}`);
  }

  const bytes = await readFile(result.path);
  // Best-effort cleanup of the temp file.
  unlink(result.path).catch(() => {});

  const format: "png" | "jpeg" = (args.format === "jpeg" || args.format === "jpg") ? "jpeg" : "png";
  return { bytes, format };
}
