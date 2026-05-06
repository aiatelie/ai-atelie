#!/usr/bin/env bun
// Upload one or more files to GitHub's user-attachments CDN — the
// only path that auto-renders videos inline in PR bodies and embeds
// images natively. Headless after one-time setup.
//
// Prereq: ./scripts/setup-attach-session.mjs (run once, refreshes
// every few weeks).
//
// Usage:
//   bun run upload:evidence <owner/repo/pull/N> <file1> [file2 ...]
//
// Output: prints a JSON object mapping each filename to its
// user-attachments URL. The script also auto-submits a single PR
// comment containing all the uploaded assets so the URLs are
// "claimed" and stay alive long-term.
//
// How it works (the only mechanism that survives in 2026):
//   1. Open a Chromium tab to the PR using the saved profile from
//      setup. The browser is already logged in.
//   2. Find the comment textarea and the surrounding <file-attachment>
//      custom element.
//   3. For each file, dispatch a synthetic `drop` DragEvent carrying
//      the file via DataTransfer. GitHub's JS performs its native
//      upload flow against /upload/policies/assets, returning a
//      user-attachments/assets/<uuid> URL that it inserts into the
//      textarea.
//   4. Wait for all uploads to complete (textarea no longer says
//      "Uploading...").
//   5. Click the Comment button to submit, claiming all assets.
//   6. Parse the URLs out of the textarea and report them.

import { chromium } from "@playwright/test";
import { homedir } from "node:os";
import { basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const target = process.argv[2];
const files = process.argv.slice(3);

if (!target || files.length === 0) {
  console.error("usage: bun scripts/upload-evidence.mjs <owner/repo/pull/N> <file1> [file2] ...");
  console.error('example: bun scripts/upload-evidence.mjs aiatelie/ai-atelie/pull/48 .evidence/run-1/canvas.png .evidence/run-1/run.mp4');
  process.exit(2);
}
for (const f of files) {
  if (!existsSync(f)) { console.error(`file not found: ${f}`); process.exit(2); }
}

const PROFILE_DIR = `${homedir()}/.local/state/aiatelie/chromium-profile`;
if (!existsSync(PROFILE_DIR)) {
  console.error(`No Chromium profile at ${PROFILE_DIR}.`);
  console.error(`Run: bun run setup:attach`);
  process.exit(2);
}

function mimeOf(name) {
  const ext = name.split(".").pop().toLowerCase();
  return ({
    webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  })[ext] || "application/octet-stream";
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto(`https://github.com/${target}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1500);

const ta = page.locator("textarea[name='comment[body]']").last();
await ta.scrollIntoViewIfNeeded();
await ta.click();
await page.waitForTimeout(500);

const fileAttachment = await ta.evaluateHandle((el) => {
  let n = el; while (n && n.tagName !== "FILE-ATTACHMENT") n = n.parentElement;
  return n;
});

for (const file of files) {
  const name = basename(file);
  const bytes = readFileSync(file);
  const mime = mimeOf(name);
  console.error(`[upload] ${name} (${bytes.length} bytes, ${mime})`);
  await fileAttachment.evaluate(async (el, [n, b64, m]) => {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const f = new File([buf], n, { type: m });
    const dt = new DataTransfer();
    dt.items.add(f);
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [name, Buffer.from(bytes).toString("base64"), mime]);
  await page.waitForTimeout(2500);
}

console.error("[upload] waiting for all uploads to finish");
const start = Date.now();
let allDone = false;
while (Date.now() - start < 10 * 60_000) {
  const v = await ta.inputValue();
  const uploadingCount = (v.match(/Uploading/gi) || []).length;
  if (uploadingCount === 0) {
    const urls = v.match(/https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/g) || [];
    if (urls.length >= files.length) { allDone = true; break; }
  }
  await page.waitForTimeout(2000);
}
if (!allDone) {
  console.error("[upload] timeout — final textarea:");
  console.error(await ta.inputValue());
  await ctx.close();
  process.exit(1);
}

const finalText = await ta.inputValue();
const lines = finalText.split(/\r?\n/);
const result = files.map((f) => {
  const baseName = basename(f).replace(/\.[^.]+$/, "");
  const matchLine = lines.find((l) => l.includes(baseName) && l.includes("user-attachments"));
  const url = matchLine?.match(/https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/)?.[0];
  return { file: basename(f), url };
});

// Submit the comment to claim all assets long-term.
const submitBtn = page.getByRole("button", { name: /^comment$/i }).last();
await submitBtn.scrollIntoViewIfNeeded();
await submitBtn.click();
console.error("[upload] submitted comment to claim assets");
await page.waitForTimeout(4000);

await ctx.close();
console.log(JSON.stringify(result, null, 2));
