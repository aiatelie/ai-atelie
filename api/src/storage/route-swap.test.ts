/* route-swap.test.ts — proves the seam at the route level.
 *
 * The same Hono route handlers run against an in-memory driver swapped
 * via rebindRepos(). If a route depends on filesystem behavior beyond
 * what the StorageDriver interface exposes, this test fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMemoryDriver } from "./memory-driver.ts";
import { rebindRepos } from "./repos/index.ts";

let projectsRoutes: { fetch: (req: Request) => Promise<Response> };

beforeAll(async () => {
  // Swap the driver BEFORE the route module is imported. The repos
  // singleton picks it up at first use.
  rebindRepos(createMemoryDriver());
  const mod = await import("../routes/projects.ts");
  projectsRoutes = mod.projectsRoutes;
});

afterAll(() => {
  // Restore default fs driver for any subsequent tests in the same
  // process. (bun test isolates per-file by default; this is belt + braces.)
  rebindRepos(createMemoryDriver());
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await projectsRoutes.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: res.status, etag: res.headers.get("etag"), text: await res.text() };
}

describe("routes against memory-driver", () => {
  it("create + list + manifest + delete", async () => {
    expect((await call("GET", "/api/projects")).text).toBe("[]");

    const create = await call("POST", "/api/projects/create", { id: "p_demo", name: "Demo" });
    expect(create.status).toBe(200);

    const list = await call("GET", "/api/projects");
    expect(list.text).toContain("p_demo");

    const manifest = await call("GET", "/api/projects/p_demo/manifest");
    expect(manifest.status).toBe(200);
    expect(manifest.text).toContain("\"name\":\"Demo\"");

    const del = await call("DELETE", "/api/projects/p_demo");
    expect(del.status).toBe(200);

    expect((await call("GET", "/api/projects")).text).toBe("[]");
  });

  it("meta GET 404 / PATCH / GET 304 / If-Match conflict / If-Match success", async () => {
    await call("POST", "/api/projects/create", { id: "p_meta", name: "Meta" });

    expect((await call("GET", "/api/projects/p_meta/meta/threads")).status).toBe(404);

    const put = await call("PATCH", "/api/projects/p_meta/meta/threads", { messages: [] });
    expect(put.status).toBe(200);
    const etag = put.etag!;

    const got = await call("GET", "/api/projects/p_meta/meta/threads");
    expect(got.status).toBe(200);
    expect(got.etag).toBe(etag);

    const not_modified = await call("GET", "/api/projects/p_meta/meta/threads", undefined, { "if-none-match": etag });
    expect(not_modified.status).toBe(304);

    const conflict = await call("PATCH", "/api/projects/p_meta/meta/threads", { messages: [1] }, { "if-match": "wrong" });
    expect(conflict.status).toBe(412);
    expect(conflict.text).toContain("current_etag");

    const ok = await call("PATCH", "/api/projects/p_meta/meta/threads", { messages: [1] }, { "if-match": etag });
    expect(ok.status).toBe(200);

    await call("DELETE", "/api/projects/p_meta");
  });

  it("static serve injects reload script for HTML and refuses .meta paths", async () => {
    await call("POST", "/api/projects/create", { id: "p_serve", name: "Serve" });

    const html = await call("GET", "/p/p_serve/index.html");
    expect(html.status).toBe(200);
    expect(html.text).toContain("EventSource(\"/p/p_serve/__reload\")");

    const dotMeta = await call("GET", "/p/p_serve/.meta/threads.json");
    expect(dotMeta.status).toBe(403);

    await call("DELETE", "/api/projects/p_serve");
  });

  it("tweak rewrites EDITMODE block via memory BlobStore", async () => {
    await call("POST", "/api/projects/create", { id: "p_tweak", name: "Tweak" });
    const dataUrl = "data:text/javascript;base64," + Buffer.from(
      `const x = 1;
/*EDITMODE-BEGIN*/{"a":1,"b":"x"}/*EDITMODE-END*/`,
    ).toString("base64");
    await call("POST", "/api/projects/p_tweak/file/upload", { path: "x.jsx", dataUrl });

    const tweak = await call("POST", "/api/projects/p_tweak/tweak", { file: "x.jsx", edits: { b: "y", c: 2 } });
    expect(tweak.status).toBe(200);
    expect(tweak.text).toContain("\"b\":\"y\"");
    expect(tweak.text).toContain("\"c\":2");

    await call("DELETE", "/api/projects/p_tweak");
  });
});
