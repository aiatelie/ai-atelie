/* capabilitiesRoute.ts — GET /api/capabilities. */

import { Hono } from "hono";
import { serializeCapabilities } from "../services/capabilities.ts";

export const capabilitiesRoute = new Hono();

// Provider-agnostic discovery of host capabilities. Returns the registry
// from services/capabilities.ts so any AI adapter (today: mcp/capabilities-
// server.mjs; future: an OpenAI/OpenRouter agent loop) can read the
// canonical list without duplicating it.
capabilitiesRoute.get("/api/capabilities", (c) => {
  return c.json(serializeCapabilities());
});
