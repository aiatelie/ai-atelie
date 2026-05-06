#!/usr/bin/env bun
// One-time setup so PR-evidence uploads use GitHub's user-attachments
// CDN (inline-renderable images + auto-playing videos) instead of the
// release-asset CDN (download links only).
//
// Pops a real Chromium window, you log into github.com, the script
// extracts the session cookies and saves them under
// ~/.local/state/aiatelie/. After that, ./scripts/upload-evidence.mjs
// runs headless using the saved profile.
//
// Refresh by re-running this script every few weeks (or whenever
// uploads start 401-ing). Never commit ~/.local/state/aiatelie/ —
// it's in $HOME, well outside the repo, but the path is also
// gitignored as defense-in-depth.
//
// Why this exists: GitHub's user-attachments upload endpoint requires
// a real browser session cookie (`_gh_sess`). PATs and gh CLI tokens
// are rejected. There's no public API in 2026; every working CLI
// solution boils down to "drive a real browser once, save the cookies."

import { chromium } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";

const STATE_DIR = `${homedir()}/.local/state/aiatelie`;
const PROFILE_DIR = `${STATE_DIR}/chromium-profile`;
const COOKIES_PATH = `${STATE_DIR}/gh-attach-cookies.txt`;

await mkdir(STATE_DIR, { recursive: true });

console.log("Launching Chromium with a persistent profile + anti-bot flags.");
console.log("State dir:    " + STATE_DIR);
console.log("Cookies file: " + COOKIES_PATH);
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

const wanted = cookies.filter((c) =>
  ["user_session", "_gh_sess", "logged_in", "dotcom_user", "_octo", "tz", "color_mode"].includes(c.name),
);
const cookieHeader = wanted.map((c) => `${c.name}=${c.value}`).join("; ");
await writeFile(COOKIES_PATH, cookieHeader, { mode: 0o600 });

console.log(`✓ Saved ${wanted.length} cookies to ${COOKIES_PATH}`);
console.log("✓ Persistent Chromium profile at " + PROFILE_DIR);
console.log();
console.log("Next: bun run upload:evidence <owner/repo/pull/N> <file1> [file2] ...");

await ctx.close();
