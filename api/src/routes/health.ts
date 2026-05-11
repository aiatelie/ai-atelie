/* health.ts — health probes for ambient dependencies the editor relies
 * on. Currently exposes:
 *
 *   GET /api/health/claude-auth
 *
 * Surfaces the state of the local Claude Code subscription OAuth so the
 * web UI can prompt the user to re-authenticate BEFORE they wait 5
 * seconds for a 401 to surface from a generative call. The token lives
 * either in macOS Keychain (`security find-generic-password -s
 * "Claude Code-credentials"`) or `~/.claude/credentials.json`. Both
 * shapes are the same JSON: `{ "claudeAiOauth": { accessToken,
 * refreshToken, expiresAt, scopes, … } }`.
 *
 * Response shape:
 *   { ok: true, expiresAt }                     // happy path
 *   { ok: false, reason: "missing" }            // no creds at all
 *   { ok: false, reason: "malformed" }          // file exists but
 *                                                  doesn't parse / lacks
 *                                                  the expected shape
 *   { ok: false, reason: "expired",
 *      expiresAt, hasRefresh }                  // token expired; user
 *                                                  must re-login if
 *                                                  refresh is empty
 *
 * The endpoint is non-blocking. If reading Keychain or the file errors,
 * we return `reason: "missing"` rather than 5xx — the UI's job is to
 * surface "looks like you're not logged in", not to debug filesystem
 * errors.
 */

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const healthRoute = new Hono();

type AuthState =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: "missing" | "malformed" }
  | { ok: false; reason: "expired"; expiresAt: number; hasRefresh: boolean };

/** Read keychain (macOS only) or credentials.json. Returns the raw JSON
 *  string or null on any failure. Never throws — caller decides what
 *  "no creds" means. */
function readCredsRaw(): string | null {
  // Keychain first on macOS — this is where the in-app `/login` writes
  // the token, ahead of the file. The file is a secondary fallback.
  if (platform() === "darwin") {
    try {
      const r = spawnSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", timeout: 2000 },
      );
      const out = r.stdout?.trim();
      if (r.status === 0 && out) return out;
    } catch {
      /* keychain miss is OK — fall through to file */
    }
  }
  try {
    // Synchronous readFile would require fs/promises here; using the
    // promised flavour means we need an async wrapper. Done in caller.
  } catch {
    /* unreachable */
  }
  return null;
}

async function readCredsFile(): Promise<string | null> {
  try {
    const path = join(homedir(), ".claude", "credentials.json");
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function probeAuth(): Promise<AuthState> {
  const raw = readCredsRaw() ?? (await readCredsFile());
  if (!raw) return { ok: false, reason: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed" };
  }
  const o = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (!o || typeof o !== "object") return { ok: false, reason: "malformed" };
  const expiresAt = (o as { expiresAt?: unknown }).expiresAt;
  const refreshToken = (o as { refreshToken?: unknown }).refreshToken;
  if (typeof expiresAt !== "number") return { ok: false, reason: "malformed" };
  const now = Date.now();
  // Treat anything within the next 30 seconds as already expired — gives
  // the UI a chance to prompt for re-auth before the next agent call
  // would 401 mid-flight.
  if (expiresAt <= now + 30_000) {
    return {
      ok: false,
      reason: "expired",
      expiresAt,
      hasRefresh: typeof refreshToken === "string" && refreshToken.length > 0,
    };
  }
  return { ok: true, expiresAt };
}

healthRoute.get("/api/health/claude-auth", async (c) => {
  const state = await probeAuth();
  return c.json(state);
});
