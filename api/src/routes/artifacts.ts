/* artifacts.ts — proxy endpoint for `window.ai.complete()` calls made
 * from inside preview iframes (artifacts).
 *
 * Preview iframes are sandboxed (`sandbox="allow-scripts"` without
 * `allow-same-origin`), so artifacts can't talk to any LLM directly.
 * Instead they postMessage `{ type: "__ai_complete", id, payload }`
 * up to the parent window; the parent (web/src/lib/tweakBridge.ts)
 * forwards the body to this endpoint and posts the result back.
 *
 * The route is provider-neutral: it picks an adapter from the agent
 * registry based on the request's `modelId` (same dispatch the agent
 * path uses) and calls `adapter.complete()`. There is NO direct
 * Anthropic API call here. Authentication, model selection, and even
 * which provider answers the call all live with the adapter — exactly
 * the same way agent turns work. A user running an OpenCode-on-Ollama
 * project gets artifact completions served by Ollama; a Kimi user
 * gets Kimi; a Claude Code user gets the subscription OAuth they're
 * already paying for. No `ANTHROPIC_API_KEY` required.
 *
 * Rate limiting: simple rolling counter per (IP+UA) key, capped at
 * MAX_PER_MIN (10) over a 60s window. Returns 429 when exceeded so
 * the bridge can surface "rate limited" to the artifact.
 *
 * Persistence: rate-limit state is written to RATE_LIMIT_FILE on disk
 * (debounced) so bun --watch reloads don't silently reset the counters.
 * The daily token cap is persisted in the same file. Token totals are
 * adapter-agnostic — adapters return tokens when their CLI surfaces
 * usage, otherwise we count one request against the cap as a fallback.
 *
 * Security:
 *   • Body shape is validated; messages array is bounded.
 *   • Request MUST originate from the same origin as the app
 *     (checked via Origin / Referer header). Requests from other origins
 *     are rejected with 403 before any processing.
 *   • CORS for this specific route is set to same-origin (no wildcard).
 *   • Daily token spend cap (DAILY_TOKEN_CAP) limits total spend per
 *     (IP+UA) key across restarts.
 *
 * Back-compat: the old `/api/artifacts/claude-complete` path is still
 * routed for one release cycle so artifacts the agent authored against
 * the previous bridge keep working. New code should use
 * `/api/artifacts/complete`.
 *
 * Body cap: 256KB — accommodates multi-turn messages[] arrays while
 * still bounding abuse.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { pickAdapter } from "../agents/registry.ts";

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

// ─── Origin enforcement ───────────────────────────────────────────────────

/**
 * Verify that the request originated from the editor as opposed to a
 * foreign page in the user's browser. The threat being defended is XSRF
 * — `cors()` already filters CORS responses at the headers layer, this
 * is belt-and-suspenders.
 *
 * In production, expectedHost (derived from the request's Host header)
 * matches Origin exactly because editor and API share an origin.
 *
 * In dev, Vite proxies /api/* from :5173 to :5174 with changeOrigin:true,
 * which rewrites Host to localhost:5174 while preserving Origin as
 * http://localhost:5173. So the strict `origin === expectedHost` check
 * would reject every legitimate browser request. We allow this case
 * specifically: when no explicit CORS_ORIGIN is set (dev posture) and
 * the Origin is a localhost / 127.0.0.1 URL, treat it as same-origin.
 *
 * Requests with no Origin AND no Referer are non-browser (curl, server-
 * to-server) — XSRF doesn't apply, allow.
 */
function isSameOrigin(req: Request, expectedHost: string): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  if (!origin && !referer) return true;

  const corsOrigin = process.env.CORS_ORIGIN;
  const isDev = !corsOrigin || corsOrigin === "*";
  const isLocalhostUrl = (s: string) =>
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(s);

  if (origin) {
    const cleanOrigin = origin.replace(/\/$/, "");
    if (cleanOrigin === expectedHost) return true;
    if (isDev && isLocalhostUrl(cleanOrigin)) return true;
    return false;
  }

  if (referer) {
    if (referer.startsWith(expectedHost + "/") || referer === expectedHost) return true;
    if (isDev && isLocalhostUrl(referer)) return true;
    return false;
  }

  return false;
}

// ─── Route ───────────────────────────────────────────────────────────────

export const artifactsRoutes = new Hono();

// Restrict CORS for these routes to same-origin only (no wildcard).
// In production CORS_ORIGIN must be the exact editor origin. This
// overrides the global "*" CORS for these specific paths.
const completeCors = cors({
  origin: (origin) => {
    const expected = process.env.CORS_ORIGIN;
    if (!expected || expected === "*") {
      if (!origin) return null;
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      return null;
    }
    return origin === expected ? origin : null;
  },
  credentials: true,
  allowMethods: ["POST"],
  allowHeaders: ["content-type"],
});

artifactsRoutes.use("/api/artifacts/complete", completeCors);
// Back-compat: the old route name keeps working until the bridge alias
// is removed. Same handler, same shape.
artifactsRoutes.use("/api/artifacts/claude-complete", completeCors);

async function handleComplete(c: import("hono").Context): Promise<Response> {
  // ── Origin / same-origin enforcement ──────────────────────────────────
  const reqHost = c.req.header("host") ?? "localhost";
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const expectedHost = `${proto}://${reqHost}`;

  if (!isSameOrigin(c.req.raw, expectedHost)) {
    console.warn(
      `[artifacts.complete] rejected cross-origin request: origin=${c.req.header("origin") ?? "(none)"} referer=${c.req.header("referer") ?? "(none)"}`,
    );
    return c.json({ error: "forbidden: cross-origin requests are not allowed" }, 403);
  }

  // ── Rate-limit by IP + User-Agent ─────────────────────────────────────
  const xff = c.req.header("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
  const ua = (c.req.header("user-agent") ?? "").slice(0, 64);
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

  // Pull modelId from the body if the host passed it; otherwise let
  // pickAdapter() apply its default (claude). This is exactly the
  // dispatch the agent path uses, so artifact completions follow the
  // same provider as whoever authored the artifact in the first place.
  const modelId = typeof (parsed as { modelId?: unknown })?.modelId === "string"
    ? (parsed as { modelId: string }).modelId
    : undefined;
  const adapter = pickAdapter(modelId);

  if (!adapter.complete || !adapter.capabilities.supportsCompletion) {
    return c.json(
      {
        error:
          `provider "${adapter.id}" doesn't support window.ai.complete() yet — ` +
          `pick a different model in the chat composer to enable it.`,
      },
      501,
    );
  }

  // ── Adapter dispatch ───────────────────────────────────────────────────
  // 30s server-side cap, slightly under the iframe's 30s timeout so the
  // adapter has time to surface a clean error before the bridge gives up.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28_000);
  try {
    const result = await adapter.complete({
      messages: norm.messages,
      abortSignal: controller.signal,
      maxTokens: HARD_MAX_TOKENS,
      modelId,
    });
    clearTimeout(timer);
    if (typeof result.tokens === "number" && result.tokens > 0) {
      recordTokens(key, result.tokens);
    }
    return c.json({ text: result.text, provider: adapter.id });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[artifacts.complete] adapter=${adapter.id} failed: ${msg}`);
    if (msg === "aborted" || controller.signal.aborted) {
      return c.json({ error: "request timed out" }, 504);
    }
    return c.json({ error: `${adapter.id}: ${msg}` }, 502);
  }
}

artifactsRoutes.post("/api/artifacts/complete", handleComplete);
// Back-compat alias.
artifactsRoutes.post("/api/artifacts/claude-complete", handleComplete);
