/* exportVideo.ts — orchestrates the video export pipeline.
 *
 *   1. Spawn playwright-tools/record-element.mjs to capture N frames at
 *      high DPI into a temp dir.
 *   2. Run ffmpeg on those frames with codec/quality settings derived
 *      from the user's choices (transparent → ProRes 4444 .mov;
 *      otherwise → H.264 .mp4 with the chosen background).
 *   3. Read the resulting video bytes, clean up the temp dir, return
 *      bytes + format metadata to the caller (commentEdit.ts /api/
 *      export-video → exportArtifacts.saveArtifact).
 *
 * The server only knows about codecs and ffmpeg flags here. Pixel-density
 * decisions (deviceScaleFactor) live in the recorder script — what hits
 * disk per-frame is already at the target DPI; ffmpeg only encodes.
 */

import { spawn } from "node:child_process";
import { readFile, rm, access } from "node:fs/promises";
import { resolve as resolvePath, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ENV } from "../env.ts";

const PLAYWRIGHT_TOOLS_DIR = ENV.PLAYWRIGHT_TOOLS_DIR;
const RECORD_SCRIPT = resolvePath(PLAYWRIGHT_TOOLS_DIR, "record-element.mjs");

export type VideoArgs = {
  url: string;
  selector: string;
  /** Target output resolution. Drives deviceScaleFactor calculation —
   *  the recorder's `scale` is set so the captured pixel dims match
   *  this target as closely as the source viewport allows. */
  resolution?: "1080p" | "1440p" | "4K" | "8K" | "custom";
  customWidth?: number;
  customHeight?: number;
  /** Quality preset. Maps to ffmpeg encoder + CRF. */
  quality?: "draft" | "standard" | "high" | "master";
  /** Either a number of seconds, or "auto" — recorder detects the
   *  longest CSS animation / Lottie duration in the captured subtree
   *  and uses that. "auto" is the right default; "explicit number"
   *  only when the user asks for a specific length. */
  duration?: number | "auto";
  fps?: number;          // 24 / 30 / 60
  backgroundColor?: "transparent" | "black" | "white" | string | null;
  timeoutMs?: number;
};

export type VideoResult = {
  bytes: Buffer;
  ext: "mp4" | "mov";
  mime: "video/mp4" | "video/quicktime";
  width: number;
  height: number;
  duration: number;
  fps: number;
  metadata: {
    codec: string;
    quality: string;
    crf?: number;
    backgroundColor: string;
    /** Mode the recorder used for duration. "explicit" when the user
     *  passed a number; "auto-detected" when an animation length was
     *  found in CSS / Lottie; "auto-fallback" when nothing was found. */
    durationMode: "explicit" | "auto-detected" | "auto-fallback";
    detectedSeconds: number;
  };
};

let probedReason: string | null | undefined;
export async function videoRendererAvailability(): Promise<string | null> {
  if (probedReason !== undefined) return probedReason;
  try {
    await access(RECORD_SCRIPT);
  } catch {
    probedReason = `playwright-tools/record-element.mjs not found at ${RECORD_SCRIPT}`;
    return probedReason;
  }
  // Probe ffmpeg on PATH. spawn `ffmpeg -version`; fail fast if missing.
  const ffmpegOk = await new Promise<boolean>((res) => {
    const c = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "ignore", "ignore"] });
    c.on("error", () => res(false));
    c.on("close", (code) => res(code === 0));
  });
  if (!ffmpegOk) {
    probedReason = "ffmpeg not found on PATH — install with `brew install ffmpeg` (macOS) or your platform equivalent";
    return probedReason;
  }
  probedReason = null;
  return null;
}

const RESOLUTION_DIMS: Record<NonNullable<Exclude<VideoArgs["resolution"], "custom">>, { w: number; h: number }> = {
  "1080p": { w: 1920, h: 1080 },
  "1440p": { w: 2560, h: 1440 },
  "4K": { w: 3840, h: 2160 },
  "8K": { w: 7680, h: 4320 },
};

/** Compute the deviceScaleFactor + viewport that get the captured
 *  element dimensions as close to the target resolution as possible.
 *  Capped at scale=4 because beyond that:
 *    • Chromium's renderer slows non-linearly
 *    • Visual gains plateau (raster source assets dominate)
 *    • Memory pressure for long recordings becomes real */
function deriveScaleAndViewport(args: VideoArgs): { scale: number; viewport: { w: number; h: number } } {
  let target: { w: number; h: number };
  if (args.resolution === "custom" && args.customWidth && args.customHeight) {
    target = { w: args.customWidth, h: args.customHeight };
  } else {
    // Default to 4K — AI Atelie's user works in 4K; high quality is the
    // expected baseline, not an opt-in.
    target = RESOLUTION_DIMS[(args.resolution ?? "4K") as keyof typeof RESOLUTION_DIMS] ?? RESOLUTION_DIMS["4K"];
  }
  // Default page viewport — most designs are authored for a 1920×1080
  // canvas. We don't reflow the page to match the target output; we
  // bump deviceScaleFactor so the rendered output hits target dims.
  const viewport = { w: 1920, h: 1080 };
  const ratio = Math.max(target.w / viewport.w, target.h / viewport.h);
  const scale = Math.max(1, Math.min(4, Math.round(ratio * 100) / 100));
  return { scale, viewport };
}

type RecordResult = {
  ok: true;
  dir: string;
  framePattern: string;
  count: number;
  fps: number;
  scale: number;
  /** Final duration the recorder used. May differ from the requested
   *  one when "auto" was passed and the recorder detected a natural
   *  animation length. */
  duration: number;
  durationMode: "explicit" | "auto-detected" | "auto-fallback";
  /** Length of the longest finite CSS animation / Lottie found in the
   *  captured subtree. 0 if nothing was detected. Surfaces in the
   *  artifact metadata so the user / AI can see why a given duration
   *  was chosen. */
  detectedSeconds: number;
  width: number;
  height: number;
  backgroundColor: string | null;
};

async function runRecorder(args: VideoArgs, scale: number, viewport: { w: number; h: number }): Promise<RecordResult> {
  const child = spawn(process.execPath, [RECORD_SCRIPT], {
    cwd: PLAYWRIGHT_TOOLS_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => { stdoutChunks.push(d); });
  child.stderr.on("data", (d: Buffer) => { stderrChunks.push(d); });

  child.stdin.write(JSON.stringify({
    url: args.url,
    selector: args.selector,
    // Default: "auto" — recorder picks the natural animation length.
    // Pass a number through verbatim only when the caller is explicit.
    duration: args.duration ?? "auto",
    fps: args.fps ?? 30,
    scale,
    viewport,
    backgroundColor: args.backgroundColor ?? null,
    timeoutMs: args.timeoutMs ?? 60_000,
  }));
  child.stdin.end();

  const code: number = await new Promise((res, rej) => {
    child.on("close", (c) => res(c ?? -1));
    child.on("error", rej);
  });
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) {
    throw new Error(`record-element produced no parseable result (exit=${code}): ${stderr.slice(0, 400)}`);
  }
  const parsed: { ok: boolean; error?: string } & Partial<RecordResult> = JSON.parse(line);
  if (!parsed.ok) throw new Error(parsed.error ?? "unknown recorder failure");
  return parsed as RecordResult;
}

/** Build the ffmpeg arg list for the chosen codec / quality / bg.
 *  Returns args, ext, mime, codec name, crf (when applicable). */
function buildFfmpegArgs(rec: RecordResult, args: VideoArgs): {
  ffmpegArgs: string[];
  ext: "mp4" | "mov";
  mime: "video/mp4" | "video/quicktime";
  codec: string;
  crf?: number;
} {
  const transparent = args.backgroundColor === "transparent";
  const quality = args.quality ?? "high";
  const fps = rec.fps;
  const inputPattern = join(rec.dir, rec.framePattern);

  // Video filter: drop fps onto stream + ensure even dimensions for h264.
  const evenDims = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

  if (transparent) {
    // ProRes 4444 with alpha — the only sane "real alpha" codec for NLEs.
    // -profile:v 4 = 4444 (yuv444 + alpha). -pix_fmt yuva444p10le for
    //  10-bit alpha. Slow but lossless-ish. Files are big.
    return {
      ffmpegArgs: [
        "-y",
        "-framerate", String(fps),
        "-i", inputPattern,
        "-c:v", "prores_ks",
        "-profile:v", "4",
        "-pix_fmt", "yuva444p10le",
        "-vendor", "apl0",
        "-vf", evenDims,
        "-r", String(fps),
      ],
      ext: "mov",
      mime: "video/quicktime",
      codec: "ProRes 4444",
    };
  }

  // H.264 path with chosen background. Frames come in with the bg
  // already painted (Playwright omitBackground=false + page CSS bg).
  // CRF presets:
  //   draft     28
  //   standard  23
  //   high      18
  //   master    14
  const crf = quality === "draft" ? 28 : quality === "high" ? 18 : quality === "master" ? 14 : 23;
  return {
    ffmpegArgs: [
      "-y",
      "-framerate", String(fps),
      "-i", inputPattern,
      "-c:v", "libx264",
      "-preset", quality === "master" ? "slow" : quality === "high" ? "medium" : "fast",
      "-crf", String(crf),
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-vf", evenDims,
      "-r", String(fps),
    ],
    ext: "mp4",
    mime: "video/mp4",
    codec: "H.264",
    crf,
  };
}

async function runFfmpeg(ffmpegArgs: string[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn("ffmpeg", [...ffmpegArgs, outPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    c.on("error", reject);
    c.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

export async function recordAndEncode(args: VideoArgs): Promise<VideoResult> {
  const reason = await videoRendererAvailability();
  if (reason) throw new Error(reason);

  const { scale, viewport } = deriveScaleAndViewport(args);
  const rec = await runRecorder(args, scale, viewport);

  try {
    const { ffmpegArgs, ext, mime, codec, crf } = buildFfmpegArgs(rec, args);
    const outDir = join(tmpdir(), `cc-video-${randomUUID()}`);
    const outPath = join(outDir, `out.${ext}`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    await runFfmpeg(ffmpegArgs, outPath);
    const bytes = await readFile(outPath);
    rm(outDir, { recursive: true, force: true }).catch(() => {});
    return {
      bytes,
      ext,
      mime,
      width: rec.width,
      height: rec.height,
      duration: rec.duration,
      fps: rec.fps,
      metadata: {
        codec,
        quality: args.quality ?? "high",
        crf,
        backgroundColor: args.backgroundColor ?? "transparent",
        durationMode: rec.durationMode,
        detectedSeconds: rec.detectedSeconds,
      },
    };
  } finally {
    // Clean up the recorder's frame dir regardless of success.
    rm(rec.dir, { recursive: true, force: true }).catch(() => {});
  }
}
