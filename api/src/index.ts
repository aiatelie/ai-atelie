/* index.ts — AI Atelie API server (Bun + Hono).
 *
 * Boots a single Bun.serve on ENV.API_PORT, mounts every /api/* and /p/*
 * route, and runs the boot-time housekeeping (screenshot dir purge).
 * Vite (web/) proxies these paths to us; nothing else listens here.
 *
 * No /index, no SPA serving — the SPA is Vite's job in dev and a static
 * bundle behind any HTTP server in prod. This process is API-only.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { ENV } from "./env.ts";
import { purgeOldScreenshots } from "./services/maintenance.ts";
import { observabilityMiddleware } from "./services/observability.ts";
import { abortAllRuns, killAllChildren } from "./services/runRegistry.ts";

import { commentEditRoutes } from "./routes/commentEdit.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { exportsRoutes } from "./routes/exports.ts";
import { filesRoutes } from "./routes/files.ts";
import { elicitRoutes } from "./routes/elicit.ts";
import { sharedRoutes } from "./routes/shared.ts";
import { debugRoutes } from "./routes/debug.ts";
import { capabilitiesRoute } from "./routes/capabilitiesRoute.ts";
import { agentsRoute } from "./routes/agents.ts";
import { internalRoutes } from "./routes/internal.ts";
import { skillsCatalogRoute } from "./routes/skillsCatalog.ts";

const app = new Hono();

// Observability comes first so `request-id` is stamped before anything
// else can fail. Sets `c.get("requestId")` for downstream handlers and
// adds request-id + server-timing response headers.
app.use("*", observabilityMiddleware);

// CORS: in dev the Vite proxy keeps requests same-origin so this is mostly
// a safety net. In prod, set CORS_ORIGIN to the editor's exact origin.
app.use("*", cors({ origin: ENV.CORS_ORIGIN, credentials: true }));

// Lightweight request log — parity with the [comment-edit] / [runKimi]
// console traces in the original middleware so existing greps still work.
app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  if (c.req.path.startsWith("/api") || c.req.path.startsWith("/p/")) {
    const elapsed = Date.now() - t0;
    if (elapsed > 50) {
      // Only log slow ones so streaming SSE turns don't spam — those
      // hold the connection open for minutes by design.
      const id = c.get("requestId" as never) ?? "-";
      console.log(`[api] ${id} ${c.req.method} ${c.req.path} ${c.res.status} ${elapsed}ms`);
    }
  }
});

app.get("/api/health", (c) => c.json({ ok: true, port: ENV.API_PORT }));

// Mount route families. Order doesn't matter for non-overlapping paths,
// but `projectsRoutes` includes the /p/:id/* catch-all so it goes last.
app.route("/", capabilitiesRoute);
app.route("/", skillsCatalogRoute);
app.route("/", agentsRoute);
app.route("/", debugRoutes);
app.route("/", internalRoutes);
app.route("/", filesRoutes);
app.route("/", elicitRoutes);
app.route("/", sharedRoutes);
app.route("/", exportsRoutes);
app.route("/", commentEditRoutes);
app.route("/", projectsRoutes);

// Centralised error handler — ensures every 500 carries a request-id and
// a structured payload so the SPA can surface meaningful diagnostics. Without
// this, Hono falls back to a bare text response that loses the correlation id.
app.onError((err, c) => {
  const requestId = c.get("requestId" as never) as string | undefined;
  console.error(`[api] ${requestId ?? "-"} unhandled error:`, err instanceof Error ? err.message : String(err));
  return c.json(
    { error: err instanceof Error ? err.message : String(err), requestId },
    { status: 500 } as any,
  );
});

// One-time startup work — clean stale diagnostic screenshots.
purgeOldScreenshots().catch((err) => {
  console.warn("[boot] purgeOldScreenshots failed (non-fatal):", err?.message ?? err);
});

/* ─── Lifecycle ─────────────────────────────────────────────────
 *
 * SIGTERM/SIGINT (Ctrl+C, `kill <pid>`, bun --watch restart): stop
 * the listener so the port is freed immediately, abort all in-flight
 * runs, give children a brief window to exit cleanly, then kill the
 * survivors.
 *
 * `runRegistry` is pinned to globalThis so it survives reloads — when
 * --watch kills us and respawns, the new process can still find any
 * children we orphaned and clean them up.
 */
let shuttingDown = false;
function shutdown(reason: string, exit: boolean) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`[api] shutdown reason=${reason} exit=${exit}`);
  // Stop accepting new connections + close existing ones forcibly so
  // the port is released before --watch spawns the next process.
  try { server.stop(true); } catch { /* already stopped */ }
  abortAllRuns(reason);
  // Children listen for SIGTERM via their per-spawn onAbort handlers,
  // which the abortAllRuns above triggered. Give them a moment to flush;
  // then SIGTERM directly anything still running. No .unref() — we MUST
  // wait so child processes are killed before the process exits.
  setTimeout(() => {
    killAllChildren();
    if (exit) process.exit(0);
  }, 500);
}

// Register signal handlers BEFORE Bun.serve so we never have a
// window where a SIGTERM/SIGINT kills the process without cleanup,
// orphaning agent subprocesses.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => shutdown(sig, /*exit*/ true));
}

/* Explicitly call Bun.serve so we control the server lifecycle. The
 * `export default { fetch }` auto-serve pattern interacts badly with
 * `bun --watch` (the runtime wrapper double-spawns on reload, causing
 * EADDRINUSE on every file save). Running serve ourselves means the
 * port is released cleanly via server.stop(true) on SIGTERM/SIGINT
 * before --watch spawns the next process. */
const server = Bun.serve({
  port: ENV.API_PORT,
  fetch: app.fetch,
  // Generous timeout so SSE streams (multi-minute kimi turns) aren't
  // killed by Bun's default. The per-request hard cap is enforced
  // inside commentEdit (RUN_MAX_DURATION_MS).
  idleTimeout: 255, // seconds; 255 is Bun's max
});
