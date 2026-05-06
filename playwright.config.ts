import { defineConfig } from "@playwright/test";

// AI Atelie e2e config — used by `verify-with-playwright` skill to
// drive the local dev server and produce PR-evidence artifacts
// (screenshots + video + trace). Specs live under `web/tests/e2e/`.
//
// Assumption: `bun run dev` is already running on :5173 in another
// terminal. We set `reuseExistingServer: true` so we don't try to
// spawn a parallel one (HMR conflicts with dual `bun run dev` are
// hostile). If the server is NOT running, Playwright will start it
// for the duration of the test run and tear it down after.
export default defineConfig({
  testDir: "./web/tests/e2e",
  outputDir: "./test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Video: 'on' keeps a .webm of every run (used by the
    // verify-with-playwright skill to attach evidence to PRs).
    // Switch to 'retain-on-failure' once you don't need every run's
    // video, just regression captures.
    video: "on",
  },
  webServer: {
    command: "bun run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
