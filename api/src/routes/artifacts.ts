/* artifacts.ts — proxy endpoint for `window.claude.complete()` calls
 * made from inside preview iframes (artifacts).
 *
 * Preview iframes are sandboxed (`sandbox="allow-scripts"` without
 * `allow-same-origin`), so artifacts can't directly call the Anthropic
 * API. Instead they postMessage `{ type: "__claude_complete", id, payload }`
 * up to the parent window; the parent forwards the body to this endpoint
 * and posts the result back.
 *
 * Rate limiting: simple rolling counter per (IP+UA) key, capped at
 * MAX_PER_MIN (10) over a 60s window. Returns 429 when exceeded so
 * the bridge can surface "rate limited" to the artifact.
 *
 * Persistence: rate-limit state is written to RATE_LIMIT_FILE on disk
 * (debounced) so bun --watch reloads don't silently reset the counters.
 * The daily token cap is persisted in the same file.
 *
 * Security:
 *   • The Anthropic API key never leaves the server.
 *   • max_tokens is capped at HARD_MAX (1024) regardless of caller input.
 *   • Model is fixed to claude-haiku-4-5-20251001 — fast + cheap.
 *   • Body shape is validated; messages array is bounded.
 *   • Request MUST originate from the same origin as the app
 *     (checked via Origin / Referer header). Requests from other origins
 *     are rejected with 403 before any processing.
 *   • CORS for this specific route is set to same-origin (no wildcard).
 *   • Daily token spend cap (DAILY_TOKEN_CAP) limits total Anthropic
 *     token usage per (IP+UA) key across restarts.
 *
 * Body cap: 256KB — accommodates multi-turn messages[] arrays while
 * still bounding abuse.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const MODEL = "claude-haiku-4-5-20251001";
const HARD_MAX_TOKENS = 1024;
const MAX_PER_MIN = 10;
const WINDOW_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 32;
const MAX_PROMPT_BYTES = 256 * 1024; // 256KB — fits multi-turn messages[]

/** Daily token cap per key. Configurable via env. Real money if breached. */
const DAILY_TOKEN_CAP = parseInt(process.env.ARTIFACT_DAILY_TOKEN_CAP ?? "100000", 10);

// ─── Rate-limit persistence ───────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
// api/src/routes/ → repo root = 3 levels up, then data/rate-limits.json
const RATE_LIMIT_FILE = resolvePath(HERE, "..", "..", "..", "data", "rate-limits.json");

type Bucket = { hits: number[]; dayStart: number; tokensToday: number };
const rateBuckets = new Map<string, Bucket>();

/** Load persisted rate-limit state from disk (best-effort; silent on error). */
async function loadRateLimits(): Promise<void> {
  try {
    const text = await Bun.file(RATE_LIMIT_FILE).text();
    const stored = JSON.parse(text) as Record<string, Bucket>;
    const now = Date.now();
    for (const [key, bucket] of Object.entries(stored)) {
      // Drop stale per-minute hits; keep daily totals if same UTC day.
      const freshHits = bucket.hits.filter((t) => now - t < WINDOW_MS);
      const tokensToday = now - bucket.dayStart < DAY_MS ? bucket.tokensToday : 0;
      const dayStart = now - bucket.dayStart < DAY_MS ? bucket.dayStart : now;
      if (freshHits.length > 0 || tokensToday > 0) {
        rateBuckets.set(key, { hits: freshHits, dayStart, tokensToday });
      }
    }
  } catch {
    // First run or corrupted file — start fresh.
  }
}

let saveDebounce: ReturnType<typeof setTimeout> | null = null;
function scheduleRateLimitSave(): void {
  if (saveDebounce) return;
  saveDebounce = setTimeout(async () => {
    saveDebounce = null;
    try {
      await mkdir(resolvePath(RATE_LIMIT_FILE, ".."), { recursive: true });
      const obj: Record<string, Bucket> = {};
      for (const [k, v] of rateBuckets.entries()) obj[k] = v;
      await Bun.write(RATE_LIMIT_FILE, JSON.stringify(obj));
    } catch (err) {
      console.warn("[artifacts] rate-limit persist failed (non-fatal):", err);
    }
  }, 2000); // 2s debounce
}

// Fire-and-forget load at module init so buckets survive bun --watch restarts.
loadRateLimits().catch(() => {});

// ─── Rate-limit + daily-cap logic ────────────────────────────────────────

function rateLimit(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = { hits: [], dayStart: now, tokensToday: 0 };
    rateBuckets.set(key, bucket);
  }
  // Reset daily window if day rolled over.
  if (now - bucket.dayStart >= DAY_MS) {
    bucket.dayStart = now;
    bucket.tokensToday = 0;
  }
  // Drop hits older than the per-minute window.
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
  if (bucket.hits.length >= MAX_PER_MIN) {
    const oldest = bucket.hits[0];
    return { ok: false, retryAfterMs: Math.max(0, WINDOW_MS - (now - oldest)) };
  }
  // Daily token cap check.
  if (bucket.tokensToday >= DAILY_TOKEN_CAP) {
    return { ok: false, retryAfterMs: DAY_MS - (now - bucket.dayStart) };
  }
  bucket.hits.push(now);
  scheduleRateLimitSave();
  return { ok: true };
}

/** Record tokens used after a successful upstream call. */
function recordTokens(key: string, tokens: number): void {
  const bucket = rateBuckets.get(key);
  if (!bucket) return;
  bucket.tokensToday += tokens;
  scheduleRateLimitSave();
}

// Periodic GC so we don't leak buckets for transient sessions / IPs.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
    const dayExpired = now - bucket.dayStart >= DAY_MS;
    if (bucket.hits.length === 0 && dayExpired) rateBuckets.delete(key);
  }
  scheduleRateLimitSave();
}, 5 * 60 * 1000).unref?.();

// ─── Body parsing / normalisation ────────────────────────────────────────

type Msg = { role: "user" | "assistant"; content: string };

function normalizeBody(body: unknown):
  | { ok: true; messages: Msg[] }
  | { ok: false; error: string }
{
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  // Form A: { prompt: string }
  if (typeof b.prompt === "string") {
    if (b.prompt.length === 0) return { ok: false, error: "prompt is empty" };
    return { ok: true, messages: [{ role: "user", content: b.prompt }] };
  }
  // Form B: { messages: [{role, content}] }
  if (Array.isArray(b.messages)) {
    if (b.messages.length === 0) return { ok: false, error: "messages is empty" };
    if (b.messages.length > MAX_MESSAGES) return { ok: false, error: `messages exceeds ${MAX_MESSAGES}` };
    const out: Msg[] = [];
    for (const m of b.messages) {
      if (!m || typeof m !== "object") return { ok: false, error: "message must be an object" };
      const mm = m as { role?: unknown; content?: unknown };
      const role = mm.role === "assistant" ? "assistant" : "user";
      const content = typeof mm.content === "string" ? mm.content : null;
      if (content === null) return { ok: false, error: "message.content must be a string" };
      out.push({ role, content });
    }
    return { ok: true, messages: out };
  }
  return { ok: false, error: "body must include `prompt` (string) or `messages` (array)" };
}

function extractText(apiResponse: unknown): string {
  // Anthropic Messages API response shape:
  //   { content: [{ type: "text", text: "..." }, ...], ... }
  const r = apiResponse as { content?: unknown };
  if (!r || !Array.isArray(r.content)) return "";
  const parts: string[] = [];
  for (const block of r.content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

function extractUsageTokens(apiResponse: unknown): number {
  const r = apiResponse as { usage?: { input_tokens?: number; output_tokens?: number } };
  if (!r?.usage) return 0;
  return (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0);
}

// ─── Origin enforcement ───────────────────────────────────────────────────

/**
 * Verify that the request originated from the same host as the API server.
 *
 * The Vite proxy forwards requests same-origin in dev; in prod the browser
 * always sends Origin (for cross-origin requests) or Referer. A request
 * from a foreign origin carries an Origin header that differs from our
 * host, or no Origin at all (which we treat as suspicious for a POST).
 *
 * Allowed through without an Origin: requests that also have no Referer
 * (curl / server-to-server — those are fine; the risk is *browser* XSRF).
 * When Origin is present it MUST match the host we're running on.
 */
function isSameOrigin(req: Request, expectedHost: string): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  // No origin + no referer = non-browser call (curl, server-to-server).
  // Allow these — the attack vector is a foreign *web page* making the call.
  if (!origin && !referer) return true;

  // If Origin is present, it must match our expected host exactly.
  if (origin) {
    // origin is like "http://localhost:5173"; strip trailing slash.
    return origin.replace(/\/$/, "") === expectedHost;
  }

  // Origin absent but Referer is present (some browsers omit Origin on
  // same-origin navigations). Accept if Referer starts with expectedHost.
  if (referer) {
    return referer.startsWith(expectedHost + "/") || referer === expectedHost;
  }

  return false;
}

// ─── Route ───────────────────────────────────────────────────────────────

export const artifactsRoutes = new Hono();

// Restrict CORS for this route to same-origin only (no wildcard).
// In production CORS_ORIGIN must be the exact editor origin.
// This overrides the global "*" CORS for this specific path.
artifactsRoutes.use("/api/artifacts/claude-complete", cors({
  origin: (origin) => {
    // Allow same-origin requests (no Origin header) and any configured host.
    const expected = process.env.CORS_ORIGIN;
    if (!expected || expected === "*") {
      // Fall back to same-origin-only: only reflect the Origin if it looks
      // like localhost / 127.0.0.1 to avoid blasting this open in prod.
      if (!origin) return null;
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      return null;
    }
    return origin === expected ? origin : null;
  },
  credentials: true,
  allowMethods: ["POST"],
  allowHeaders: ["content-type"],
}));

artifactsRoutes.post("/api/artifacts/claude-complete", async (c) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: "ANTHROPIC_API_KEY not configured on the server" }, 500);
  }

  // ── Origin / same-origin enforcement ──────────────────────────────────
  // Derive expected host from the request so this works for any port binding
  // without hard-coding (localhost:5174 in dev, real domain in prod).
  const reqHost = c.req.header("host") ?? "localhost";
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const expectedHost = `${proto}://${reqHost}`;

  if (!isSameOrigin(c.req.raw, expectedHost)) {
    console.warn(
      `[artifacts.claude-complete] rejected cross-origin request: origin=${c.req.header("origin") ?? "(none)"} referer=${c.req.header("referer") ?? "(none)"}`,
    );
    return c.json({ error: "forbidden: cross-origin requests are not allowed" }, 403);
  }

  // ── Rate-limit by IP + User-Agent ─────────────────────────────────────
  // Combining IP + UA makes NAT-collision much less likely and prevents the
  // attacker from simply spoofing X-Forwarded-For (different UA profile).
  const xff = c.req.header("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
  const ua = (c.req.header("user-agent") ?? "").slice(0, 64); // cap length
  const key = `ip:${ip}|ua:${ua}`;

  const limit = rateLimit(key);
  if (!limit.ok) {
    const retrySec = Math.ceil(limit.retryAfterMs / 1000);
    return new Response(
      JSON.stringify({ error: `rate limit: ${MAX_PER_MIN} requests/minute`, retry_after_ms: limit.retryAfterMs }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(retrySec) } },
    );
  }

  // ── Body cap + parse ───────────────────────────────────────────────────
  // Read raw text first so we can size-cap before JSON-parsing arbitrarily
  // large bodies. 256KB accommodates multi-turn messages[] while bounding
  // abuse.
  let raw: string;
  try { raw = await c.req.text(); }
  catch { return c.json({ error: "could not read body" }, 400); }
  if (raw.length > MAX_PROMPT_BYTES) {
    return c.json({ error: `body exceeds ${MAX_PROMPT_BYTES} bytes (256KB max)` }, 413);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return c.json({ error: "Bad JSON" }, 400); }

  const norm = normalizeBody(parsed);
  if (!norm.ok) return c.json({ error: norm.error }, 400);

  // ── Upstream call ──────────────────────────────────────────────────────
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: HARD_MAX_TOKENS,
        messages: norm.messages,
      }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      // Don't leak raw provider error bodies to the artifact — surface a
      // short message and the status. The full body is logged for ops.
      console.warn(`[artifacts.claude-complete] upstream ${upstream.status}: ${errText.slice(0, 500)}`);
      return c.json(
        { error: `upstream error ${upstream.status}` },
        upstream.status >= 500 ? 502 : 400,
      );
    }
    const data = (await upstream.json()) as unknown;
    const text = extractText(data);

    // Record token usage for daily cap tracking.
    const tokens = extractUsageTokens(data);
    if (tokens > 0) recordTokens(key, tokens);

    return c.json({ text });
  } catch (err) {
    console.error("[artifacts.claude-complete] fetch failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "upstream fetch failed" },
      502,
    );
  }
});
