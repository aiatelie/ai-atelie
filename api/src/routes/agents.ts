/* agents.ts — GET /api/agents.
 *
 * Returns the registered adapter list with capability flags so the
 * frontend can gate UI features (e.g. comment-mode, silent watchdog
 * timing, model-picker availability) on what each adapter actually
 * supports — instead of hardcoding "kimi" | "claude" assumptions.
 *
 * Today's response is static (the registry is built at module load)
 * so this is effectively a one-shot fetch on the frontend. When
 * detection lands (PATH probe per CLI install, auth state), the
 * shape stays the same but values become dynamic per request.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { spawn } from "node:child_process";
import { listAdapters } from "../agents/registry.ts";
import { probeAll, invalidateProbe } from "../agents/detection.ts";
import { codexAdapter } from "../agents/codex/adapter.ts";
import { registerChild, unregisterChild } from "../services/runRegistry.ts";

export const agentsRoute = new Hono();

agentsRoute.get("/api/agents", async (c) => {
  // ?refresh=1 evicts the per-adapter probe cache before re-probing.
  // The Settings UI's Rescan button hits this — without it, a user who
  // just ran `opencode auth login` would wait up to 5 min for the TTL.
  if (c.req.query("refresh") === "1") {
    for (const a of listAdapters()) invalidateProbe(a.id);
  }
  const adapters = listAdapters();
  const probes = await probeAll(adapters);
  const out = adapters.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    capabilities: a.capabilities,
    installed: probes[a.id]?.installed ?? true,
    models: probes[a.id]?.models ?? [],
    authRequired: probes[a.id]?.authRequired ?? false,
    setupHint: probes[a.id]?.setupHint,
  }));
  return c.json({ adapters: out });
});

/* ── Codex sign-in ───────────────────────────────────────────────────
 * POST /api/agents/codex/login — runs `codex logout` then `codex login`
 * as a subprocess. Because the API runs locally on the user's machine,
 * `codex login` opens THEIR browser for the ChatGPT OAuth flow. We
 * stream progress over SSE (status / url / done / error) so the UI can
 * show "waiting for sign-in…" and surface the auth URL as a fallback if
 * the browser doesn't auto-open. Re-probes codex on completion so the
 * picker/adapter card flips to "Ready" without a manual rescan.
 *
 * logout-first is deliberate: the revoked-refresh-token error reads
 * "log out and sign in again", and a bare login won't clear bad creds. */

let codexLoginInProgress = false;

type CodexCmdResult = { code: number | null; timedOut: boolean; stdout: string; stderr: string };

function runCodexCmd(
  args: string[],
  timeoutMs: number,
  onData?: (text: string) => void,
  abortSignal?: AbortSignal,
): Promise<CodexCmdResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn("codex", args, {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerChild(child.pid);

    const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 1500).unref?.();
    }, timeoutMs);
    timer.unref?.();
    abortSignal?.addEventListener("abort", onAbort);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      unregisterChild(child.pid);
      resolve({ code, timedOut, stdout, stderr });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { stdout += c; onData?.(c); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { stderr += c; onData?.(c); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

agentsRoute.post("/api/agents/codex/login", (c) => {
  if (codexLoginInProgress) {
    return c.json({ error: "A Codex sign-in is already in progress." }, 409);
  }
  codexLoginInProgress = true;
  const ac = new AbortController();

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    stream.onAbort(() => ac.abort());

    // Surface the first auth URL codex prints, so the user has a manual
    // fallback if the browser didn't open. Loopback URLs work too — it's
    // the user's own machine.
    const urlRe = /(https?:\/\/[^\s"'<>]+)/;
    let urlSent = false;
    const watchForUrl = (text: string) => {
      if (urlSent) return;
      const m = text.match(urlRe);
      if (m?.[1]) { urlSent = true; send("url", { url: m[1] }); }
    };

    try {
      send("status", { message: "Clearing stale credentials…" });
      await runCodexCmd(["logout"], 15_000, undefined, ac.signal).catch(() => undefined);

      send("status", { message: "Opening your browser to sign in to ChatGPT…" });
      const result = await runCodexCmd(["login"], 180_000, watchForUrl, ac.signal);
      if (ac.signal.aborted) return;

      if (result.timedOut) {
        send("error", { message: "Sign-in timed out after 3 min. Try again, or run `codex login` in a terminal." });
        return;
      }

      invalidateProbe("codex");
      const probe = codexAdapter.probe
        ? await codexAdapter.probe().catch(() => undefined)
        : undefined;
      const authed = result.code === 0 || (!!probe && probe.installed && !probe.authRequired);
      if (authed) {
        send("done", { authed: true });
      } else {
        const tail = (result.stderr || result.stdout).slice(-400).trim();
        send("error", { message: tail || "Codex sign-in didn't complete. Check the browser window and try again." });
      }
    } catch (err) {
      send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      codexLoginInProgress = false;
    }
  });
});
