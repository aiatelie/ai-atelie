/* vite.config.ts — SPA dev server only.
 *
 * The API has been extracted into a standalone Bun + Hono process at
 * ../api (see ../api/src/index.ts). Vite serves the React SPA on its
 * own port and proxies every request whose path begins with `/api`,
 * `/p/`, or `/api/__shared-events` to the API process.
 *
 * Why proxy and not just hit the API on its own port from the browser:
 * keeping everything same-origin during dev means no CORS gymnastics,
 * cookies (when we add them), and the iframe at /p/<id>/* sees the
 * SPA's origin so postMessage stays simple.
 *
 * Override `VITE_API_URL` in .env to point the proxy elsewhere (different
 * host, custom port). Defaults to http://localhost:5174.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_URL = process.env.VITE_API_URL || "http://localhost:5174";

export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      ignored: ["**/projects/**", "**/.data/**"],
    },
    proxy: {
      // Order matters only when paths overlap. These three don't.
      "/api": {
        target: API_URL,
        changeOrigin: true,
        // SSE streams need streaming preserved; vite uses http-proxy under
        // the hood which already handles that, but disable proxy timeout
        // so multi-minute AI turns aren't cut off at the proxy layer.
        timeout: 0,
        proxyTimeout: 0,
      },
      // Regex: only proxy /p/<id>/... iframe content. A bare "/p" prefix
      // would catch SPA routes like "/projects" and proxy them to the api.
      "^/p/": {
        target: API_URL,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
