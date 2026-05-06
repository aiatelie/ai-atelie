#!/usr/bin/env bun
// One-time setup so PR-evidence uploads use GitHub's user-attachments
// CDN (inline-renderable images + auto-playing videos) instead of the
// release-asset CDN (download links only).
//
// Pops a real Chromium window, you log into github.com, the script
// keeps the session in Chromium's persistent profile dir under
// ~/.local/state/aiatelie/chromium-profile/. After that,
// scripts/upload-evidence.mjs launches Chromium against this same
// profile headless and the session is preserved.
//
// Refresh by re-running this script every few weeks (or whenever
// uploads start 401-ing). The profile dir is mode 0700, in $HOME,
// well outside any repo; .gitignore also excludes the pattern as
// defense-in-depth. NO plaintext cookie or token file is ever
// written — the only sensitive data lives in Chromium's own
// (binary) cookies DB which Playwright manages.
//
// Why this exists: GitHub's user-attachments upload endpoint requires
// a real browser session cookie (`_gh_sess`). PATs and gh CLI tokens
// are rejected. There's no public API in 2026; every working CLI
// solution boils down to "drive a real browser once, keep the
// session profile."

import { chromium } from "@playwright/test";
import { mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";

const STATE_DIR = `${homedir()}/.local/state/aiatelie`;
const PROFILE_DIR = `${STATE_DIR}/chromium-profile`;

await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });

console.log("Launching Chromium with a persistent profile + anti-bot flags.");
console.log("Session storage: " + PROFILE_DIR);
console.log("(Chromium-managed, binary, owner-only access, never copied to a flat file)");
console.log();
console.log("Tip: log in with your GitHub USERNAME/PASSWORD directly —");
console.log('Google\'s "Continue with Google" path is detected as automation');
console.log("and blocked by Google. GitHub\'s native form auth works fine.");
console.log("After login, leave the dashboard tab open. Script polls and exits.");
console.log();

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
  viewport: { width: 1280, height: 800 },
});

await ctx.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://github.com/login");

const start = Date.now();
let cookies = [];
while (Date.now() - start < 5 * 60_000) {
  cookies = await ctx.cookies("https://github.com");
  if (cookies.find((c) => c.name === "user_session")) break;
  await new Promise((r) => setTimeout(r, 2000));
}
if (!cookies.find((c) => c.name === "user_session")) {
  console.error("Timed out — did you complete the login?");
  await ctx.close();
  process.exit(1);
}

console.log(`✓ Logged in (user_session cookie detected)`);
console.log(`✓ Session saved inside Chromium profile at ${PROFILE_DIR}`);
console.log();
console.log("This profile is mode 0700, in $HOME, gitignored at the pattern level.");
console.log("No plaintext cookie or token file is created — Chromium owns the");
console.log("session data and Playwright reads it back via persistent context.");
console.log();
console.log("Next: bun run upload:evidence <owner/repo/pull/N> <file1> [file2] ...");

await ctx.close();
await chmod(PROFILE_DIR, 0o700).catch(() => {}); // belt-and-suspenders
