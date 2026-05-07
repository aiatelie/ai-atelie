#!/usr/bin/env bun
// run-journeys — orchestrates the journey suite and attaches inline
// evidence (per-journey video + final screenshot) into the PR body.
//
// Each journey is one Playwright spec under web/tests/e2e/journeys/
// that asserts a focused user flow and emits a deterministic final.png
// next to its auto-recorded video.webm. The runner:
//
//   1. Runs each journey in turn (so one timeout doesn't kill the rest).
//   2. Locates artifacts via Playwright's JSON reporter.
//   3. Optionally compresses videos with ffmpeg (graceful fallback).
//   4. Uploads via scripts/upload-evidence.mjs (returns user-attachments
//      URLs that GitHub renders inline as video + img).
//   5. Rewrites a marker block in the PR body — idempotent re-run.
//
// Usage:
//   bun run journeys                    # run all baseline journeys against current PR
//   bun run journeys -- --pr 80         # explicit PR
//   bun run journeys -- --only home-loads # one journey by id
//   bun run journeys -- --no-upload     # bundle into .evidence/, skip GitHub
//   bun run journeys -- --skip-pr-edit  # upload, but don't touch the PR body
//
// Pre-reqs:
//   - bun run dev running on :5173 + :5174
//   - For upload: bun run setup:attach has been run once (Chromium profile)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import process from "node:process";

// ─── Journey catalog ────────────────────────────────────────────────
// `id` slug → matches the deterministic screenshot filename
// (test-results/journeys-<id>-final.png) and the marker the spec uses.
// `spec` is relative to the repo root.
const JOURNEYS = [
  {
    id: "home-loads",
    title: "Home loads",
    spec: "web/tests/e2e/journeys/home-loads.spec.ts",
    baseline: true,
  },
  {
    id: "create-project",
    title: "Create project",
    spec: "web/tests/e2e/journeys/create-project.spec.ts",
    baseline: true,
  },
  {
    id: "agent-edits-canvas",
    title: "Agent edits canvas",
    spec: "web/tests/e2e/journeys/agent-edits-canvas.spec.ts",
    baseline: true,
  },
  {
    id: "cleanup-snapshot",
    title: "Cleanup snapshot",
    spec: "web/tests/e2e/journeys/cleanup-snapshot.spec.ts",
    baseline: true,
  },
];

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TEST_RESULTS = join(REPO_ROOT, "test-results");
const EVIDENCE_ROOT = join(REPO_ROOT, ".evidence");
const TARGET_REPO = "aiatelie/ai-atelie";
const MARK_START = "<!-- journey-evidence:start -->";
const MARK_END = "<!-- journey-evidence:end -->";

// ─── CLI ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { pr: null, only: null, noUpload: false, skipPrEdit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") opts.pr = argv[++i];
    else if (a === "--only") opts.only = argv[++i];
    else if (a === "--no-upload") opts.noUpload = true;
    else if (a === "--skip-pr-edit") opts.skipPrEdit = true;
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: bun run journeys [-- options]
  --pr <n>          Target PR number (auto-detected from current branch)
  --only <id>       Run a single journey by id (e.g. home-loads)
  --no-upload       Skip the GitHub upload + body edit, just bundle locally
  --skip-pr-edit    Upload but leave the PR body alone`);
}

// ─── helpers ────────────────────────────────────────────────────────
function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function ghPRNumber() {
  const r = spawnSync("gh", ["pr", "view", "--json", "number"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).number; } catch { return null; }
}

function ghPRBody(n) {
  const r = spawnSync("gh", ["pr", "view", String(n), "--json", "body"], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`gh pr view ${n} failed: ${r.stderr}`);
  return JSON.parse(r.stdout).body || "";
}

function ghEditPRBody(n, body) {
  // Use the REST API directly. `gh pr edit` triggers extra GraphQL
  // calls (fetching project associations) that fail on repos which
  // never opted into the deprecated Projects-classic. The REST PATCH
  // doesn't carry that baggage.
  const r = spawnSync(
    "gh",
    ["api", "-X", "PATCH", `/repos/${TARGET_REPO}/pulls/${n}`, "-f", `body=${body}`],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`gh api PATCH /pulls/${n} failed: ${r.stderr}`);
}

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000).toString().padStart(2, "0");
  return `${m}m ${s}s`;
}

// ─── playwright runner ──────────────────────────────────────────────
function runPlaywright(spec) {
  const r = spawnSync("bunx", ["playwright", "test", spec, "--reporter=json"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { exitCode: r.status, report, stderr: r.stderr };
}

/** Walk Playwright's JSON report; return {status, durationMs, errorMessage,
 *  videoPath} for the single test we expect inside this spec. */
function extractTestSummary(report) {
  if (!report) return { status: "unknown", durationMs: -1 };
  const tests = [];
  function walk(suites) {
    for (const s of suites || []) {
      for (const sp of s.specs || []) {
        for (const t of sp.tests || []) tests.push(t);
      }
      walk(s.suites);
    }
  }
  walk(report.suites);
  if (tests.length === 0) return { status: "unknown", durationMs: -1 };
  // A spec usually has one test; if many, take the worst result.
  let worst = tests[0];
  for (const t of tests) {
    if (t.results?.[0]?.status === "failed") worst = t;
  }
  const result = worst.results?.[0] || {};
  const videoAtt = (result.attachments || []).find((a) => a.name === "video");
  const errorMessage = result.error?.message?.split("\n")[0] || result.errors?.[0]?.message?.split("\n")[0] || null;
  return {
    status: result.status || "unknown",
    durationMs: typeof result.duration === "number" ? result.duration : -1,
    videoPath: videoAtt?.path || null,
    errorMessage,
  };
}

// ─── ffmpeg compress ────────────────────────────────────────────────
function compressVideo(input, output) {
  if (!which("ffmpeg")) {
    copyFileSync(input, output);
    return { compressed: false };
  }
  // 1024px wide, vp8 webm, ~1.5MB target via -b:v 800k. Speed 8x.
  const r = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", input,
    "-vf", "setpts=PTS/8,scale=1024:-2",
    "-an",
    "-c:v", "libvpx", "-b:v", "800k",
    output,
  ], { encoding: "utf-8" });
  if (r.status !== 0) {
    // Fall back to copy on encode failure.
    copyFileSync(input, output);
    return { compressed: false };
  }
  return { compressed: true };
}

// ─── per-journey runner ─────────────────────────────────────────────
function runOne(journey, evidenceDir) {
  console.error(`\n── ${journey.id} ─────────────────────────────`);
  console.error(`spec: ${journey.spec}`);
  const { exitCode, report } = runPlaywright(journey.spec);
  const summary = extractTestSummary(report);
  console.error(`status: ${summary.status} (exit=${exitCode})  duration: ${fmtDuration(summary.durationMs)}`);
  if (summary.errorMessage) console.error(`error: ${summary.errorMessage}`);

  const journeyDir = join(evidenceDir, journey.id);
  ensureDir(journeyDir);

  const result = {
    ...journey,
    status: summary.status,
    durationMs: summary.durationMs,
    errorMessage: summary.errorMessage,
    artifacts: {},
  };

  // Final screenshot — deterministic path the spec writes to.
  // Filename intentionally distinct from the video's so the upload
  // helper's ext-stripping URL matcher can tell them apart.
  const finalPng = join(TEST_RESULTS, `journeys-${journey.id}-final.png`);
  if (existsSync(finalPng)) {
    const dst = join(journeyDir, `${journey.id}-screenshot.png`);
    copyFileSync(finalPng, dst);
    result.artifacts.screenshot = dst;
  }

  // Video — Playwright's path lives inside test-results; copy into
  // the evidence dir under a stable filename so downstream code can
  // find it even if Playwright re-slugs the directory.
  if (summary.videoPath && existsSync(summary.videoPath)) {
    const dst = join(journeyDir, `${journey.id}-video.webm`);
    const compressed = compressVideo(summary.videoPath, dst);
    result.artifacts.video = dst;
    result.artifacts.videoCompressed = compressed.compressed;
  }

  return result;
}

// ─── upload ─────────────────────────────────────────────────────────
function uploadAll(prNumber, files) {
  const args = [
    "scripts/upload-evidence.mjs",
    `${TARGET_REPO}/pull/${prNumber}`,
    ...files,
  ];
  const r = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`upload-evidence failed (exit=${r.status}):\n${r.stderr}`);
  }
  // Forward upload progress logs to caller stderr for visibility.
  if (r.stderr) process.stderr.write(r.stderr);
  // upload-evidence.mjs prints a JSON array on stdout.
  return JSON.parse(r.stdout);
}

// ─── markdown ───────────────────────────────────────────────────────
const STATUS_GLYPH = {
  passed: "✅", failed: "❌", timedOut: "⏱️", skipped: "⏭️", unknown: "❔",
};

function urlFor(uploadResults, filename) {
  const hit = uploadResults.find((u) => u.file === filename);
  return hit?.url || null;
}

function renderMarkdown(results, uploads) {
  const lines = [];
  lines.push("## Journey evidence");
  lines.push("");
  lines.push(`_Run ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC by \`scripts/run-journeys.mjs\`._`);
  lines.push("");
  // Failures first so reviewers see them immediately.
  const sorted = [...results].sort((a, b) => Number(a.status === "passed") - Number(b.status === "passed"));
  for (const r of sorted) {
    const glyph = STATUS_GLYPH[r.status] || STATUS_GLYPH.unknown;
    lines.push(`### ${glyph} ${r.title} · ${fmtDuration(r.durationMs)}`);
    lines.push("");
    if (r.errorMessage && r.status !== "passed") {
      lines.push(`> ${r.errorMessage}`);
      lines.push("");
    }
    const screenshotUrl = r.artifacts.screenshot ? urlFor(uploads, basename(r.artifacts.screenshot)) : null;
    const videoUrl = r.artifacts.video ? urlFor(uploads, basename(r.artifacts.video)) : null;
    if (screenshotUrl) {
      lines.push(`<img src="${screenshotUrl}" alt="${r.title} final" width="640" />`);
      lines.push("");
    }
    if (videoUrl) {
      lines.push(`[${basename(r.artifacts.video)}](${videoUrl})`);
      lines.push("");
    }
    if (!screenshotUrl && !videoUrl) {
      lines.push("_(no artifacts produced)_");
      lines.push("");
    }
  }
  return lines.join("\n").trim();
}

function spliceBody(body, block) {
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  if (re.test(body)) {
    return body.replace(re, `${MARK_START}\n${block}\n${MARK_END}`);
  }
  return `${body.trim()}\n\n${MARK_START}\n${block}\n${MARK_END}\n`;
}

// ─── main ───────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const selected = opts.only
    ? JOURNEYS.filter((j) => j.id === opts.only)
    : JOURNEYS.filter((j) => j.baseline);
  if (selected.length === 0) {
    console.error(`no journeys matched (only=${opts.only})`);
    process.exit(2);
  }

  // Pre-flight: dev server.
  const ping = spawnSync("curl", ["-sf", "http://localhost:5173/"], { stdio: "ignore" });
  if (ping.status !== 0) {
    console.error("dev server isn't responding on http://localhost:5173. Run `bun run dev` first.");
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const evidenceDir = join(EVIDENCE_ROOT, `journeys-${runId}`);
  ensureDir(evidenceDir);
  console.error(`evidence dir: ${evidenceDir}`);

  // Run each journey, collect results.
  const results = [];
  for (const j of selected) {
    try {
      results.push(runOne(j, evidenceDir));
    } catch (err) {
      console.error(`runOne(${j.id}) threw: ${err}`);
      results.push({ ...j, status: "unknown", durationMs: -1, errorMessage: String(err), artifacts: {} });
    }
  }

  // Persist a summary JSON for follow-up tooling / debugging.
  writeFileSync(join(evidenceDir, "summary.json"), JSON.stringify(results, null, 2));
  console.error(`\nsummary: ${results.map((r) => `${r.id}=${r.status}`).join(" ")}`);

  if (opts.noUpload) {
    console.error(`\n--no-upload: skipping GitHub upload + PR body edit. Local bundle: ${evidenceDir}`);
    process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
  }

  // Resolve PR.
  const prNumber = opts.pr ? Number(opts.pr) : ghPRNumber();
  if (!prNumber) {
    console.error("\nno PR detected for current branch and --pr not supplied; bundling locally.");
    console.error(`Local bundle: ${evidenceDir}`);
    process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
  }
  console.error(`\ntarget PR: #${prNumber}`);

  // Gather files to upload.
  const filesToUpload = [];
  for (const r of results) {
    if (r.artifacts.screenshot) filesToUpload.push(r.artifacts.screenshot);
    if (r.artifacts.video) filesToUpload.push(r.artifacts.video);
  }
  if (filesToUpload.length === 0) {
    console.error("no artifacts to upload; exiting.");
    process.exit(1);
  }

  // Upload.
  console.error(`uploading ${filesToUpload.length} files…`);
  let uploads;
  try {
    uploads = uploadAll(prNumber, filesToUpload);
  } catch (err) {
    console.error(`\nupload failed: ${err.message}`);
    console.error(`Local bundle preserved: ${evidenceDir}`);
    process.exit(1);
  }
  writeFileSync(join(evidenceDir, "uploads.json"), JSON.stringify(uploads, null, 2));

  // Build markdown + edit PR body.
  const block = renderMarkdown(results, uploads);
  console.error("\n--- markdown block ---\n" + block + "\n----------------------\n");

  if (opts.skipPrEdit) {
    console.error("--skip-pr-edit: leaving PR body alone.");
    process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
  }

  const oldBody = ghPRBody(prNumber);
  const newBody = spliceBody(oldBody, block);
  if (newBody === oldBody) {
    console.error("PR body unchanged.");
  } else {
    ghEditPRBody(prNumber, newBody);
    console.error(`PR #${prNumber} body updated with journey-evidence block.`);
  }

  process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
}

await main();
