/* observability.ts — request IDs + server-timing.
 *
 * Surfaces an Anthropic-style "request-id: req_<27 alnum>" header and a
 * "server-timing: x-originResponse;dur=<ms>" header so logs can be
 * joined across services and the browser's network panel surfaces
 * backend wall time at a glance.
 *
 * The id is also propagated as REQ_ID env var to spawned subprocesses
 * (kimi, claude SDK, MCP servers) so their logs join the same trace.
 */

import type { MiddlewareHandler } from "hono";
import { randomBytes } from "node:crypto";

/** Anthropic-style id: 27 chars of base62-ish noise after the `req_` prefix. */
function makeRequestId(): string {
  const buf = randomBytes(20);
  // Base64url-safe → trim to 27 chars.
  const s = buf.toString("base64url").slice(0, 27);
  return `req_${s}`;
}

/** Hono middleware: stamps an id on every request, exposes it on the
 *  context, sets `request-id` + `server-timing` headers on the response.
 *
 *  Inside a handler:  c.get("requestId")
 *  In response logs:  the id is in the request-id header.
 *  Subprocesses:      pass `c.get("requestId")` as REQ_ID env. */
export const observabilityMiddleware: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming ?? makeRequestId();
  c.set("requestId", id);
  // Set early so even error responses carry it.
  c.res.headers.set("request-id", id);
  const t0 = performance.now();
  await next();
  const elapsed = performance.now() - t0;
  c.res.headers.set("server-timing", `total;dur=${elapsed.toFixed(1)}`);
};

/** Build the env block we hand to spawned subprocesses, propagating the
 *  trace id alongside whatever else the caller wants. */
export function withReqId(env: NodeJS.ProcessEnv, requestId: string): NodeJS.ProcessEnv {
  return { ...env, REQ_ID: requestId };
}
