/* artifacts.ts — proxy endpoint for `window.claude.complete()` calls
 * made from inside preview iframes (artifacts).
 *
 * Preview iframes are sandboxed (`sandbox="allow-scripts"` without
 * `allow-same-origin`), so artifacts can't directly call the Anthropic
 * API. Instead they postMessage `{ type: "__claude_complete", id, payload }`
 * up to the parent window; the parent forwards the body to this endpoint
 * and posts the result back.
 *
 * Rate limiting: simple in-memory rolling counter per client IP, capped
 * at MAX_PER_MIN (10) over a 60s window. Returns 429 when exceeded so
 * the bridge can surface "rate limited" to the artifact.
 *
 * Security:
 *   • The Anthropic API key never leaves the server.
 *   • max_tokens is capped at HARD_MAX (1024) regardless of caller input.
 *   • Model is fixed to claude-haiku-4-5-20251001 — fast + cheap.
 *   • Body shape is validated; messages array is bounded.
 */

import { Hono } from "hono";

const MODEL = "claude-haiku-4-5-20251001";
const HARD_MAX_TOKENS = 1024;
const MAX_PER_MIN = 10;
const WINDOW_MS = 60 * 1000;
const MAX_MESSAGES = 32;
const MAX_PROMPT_BYTES = 32 * 1024; // 32KB cap on incoming prompt body

type Bucket = { hits: number[] };
const rateBuckets = new Map<string, Bucket>();

function rateLimit(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    rateBuckets.set(key, bucket);
  }
  // Drop hits older than the window.
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
  if (bucket.hits.length >= MAX_PER_MIN) {
    const oldest = bucket.hits[0];
    return { ok: false, retryAfterMs: Math.max(0, WINDOW_MS - (now - oldest)) };
  }
  bucket.hits.push(now);
  return { ok: true };
}

// Periodic GC so we don't leak buckets for transient sessions / IPs.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
    if (bucket.hits.length === 0) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

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

export const artifactsRoutes = new Hono();

artifactsRoutes.post("/api/artifacts/claude-complete", async (c) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: "ANTHROPIC_API_KEY not configured on the server" }, 500);
  }

  // Rate-limit by client IP (best we have without sessions; behind a proxy
  // the reverse-proxy should set X-Forwarded-For, which Bun surfaces via
  // the standard Request headers).
  const xff = c.req.header("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
  const key = `ip:${ip}`;
  const limit = rateLimit(key);
  if (!limit.ok) {
    const retrySec = Math.ceil(limit.retryAfterMs / 1000);
    return new Response(
      JSON.stringify({ error: `rate limit: ${MAX_PER_MIN} requests/minute`, retry_after_ms: limit.retryAfterMs }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(retrySec) } },
    );
  }

  // Read raw text first so we can size-cap before JSON-parsing arbitrarily
  // large bodies.
  let raw: string;
  try { raw = await c.req.text(); }
  catch { return c.json({ error: "could not read body" }, 400); }
  if (raw.length > MAX_PROMPT_BYTES) {
    return c.json({ error: `body exceeds ${MAX_PROMPT_BYTES} bytes` }, 413);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return c.json({ error: "Bad JSON" }, 400); }

  const norm = normalizeBody(parsed);
  if (!norm.ok) return c.json({ error: norm.error }, 400);

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
    return c.json({ text });
  } catch (err) {
    console.error("[artifacts.claude-complete] fetch failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "upstream fetch failed" },
      502,
    );
  }
});
