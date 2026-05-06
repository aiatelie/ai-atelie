/* elicit.ts — POST /api/elicit-response, POST /api/elicit-ask-user.
 *
 * Both routes resolve into the same in-memory elicit bus.
 *
 *   /api/elicit-response: the editor's ElicitForm POSTs here when the
 *     user submits (or dismisses) a structured-question form. We resolve
 *     the matching pending elicitation, which unblocks either:
 *       • The Claude SDK's onElicitation callback in the active comment-
 *         edit stream so Claude can continue with the user's answer; OR
 *       • The /api/elicit-ask-user long-poll for the kimi HTTP-bridge MCP.
 *
 *   /api/elicit-ask-user: HTTP bridge for ask-user under kimi.
 *     mcp/ask-user-http-server.mjs POSTs here with { streamId, message,
 *     schema }; we look up the registered SSE emitter for that stream,
 *     dispatch an `elicit` event, and long-poll on the matching
 *     /api/elicit-response. Returns the response as JSON to the MCP
 *     server, which forwards it to the model. */

import { Hono } from "hono";
import { dispatchElicit, resolvePending, type ElicitAction } from "../services/elicitBus.ts";

export const elicitRoutes = new Hono();

elicitRoutes.post("/api/elicit-response", async (c) => {
  let body: { id?: string; action?: ElicitAction; content?: Record<string, unknown> };
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  if (!body.id || !body.action || !["accept", "decline", "cancel"].includes(body.action)) {
    return c.json({ error: "Need { id, action: accept|decline|cancel, content? }" }, 400);
  }
  const matched = resolvePending(body.id, { action: body.action, content: body.content });
  return c.json({ ok: matched }, matched ? 200 : 404);
});

elicitRoutes.post("/api/elicit-ask-user", async (c) => {
  type AskBody = {
    streamId?: string;
    message?: string;
    schema?: Record<string, unknown>;
    serverName?: string;
  };
  let body: AskBody;
  try { body = await c.req.json(); }
  catch { return c.text("Bad JSON", 400); }
  if (!body.streamId || !body.message || !body.schema) {
    return c.json({ error: "Need { streamId, message, schema }" }, 400);
  }
  const response = await dispatchElicit(body.streamId, {
    message: body.message,
    schema: body.schema,
    serverName: body.serverName,
  });
  if (!response) {
    // No emitter registered — the run already ended (or never existed).
    // Surface a clear error so the MCP server can return ToolError
    // instead of hanging.
    return c.json({ error: "No active stream for that streamId" }, 410);
  }
  return c.json(response);
});
