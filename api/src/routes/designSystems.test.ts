/* designSystems.test.ts — REST surface against the memory driver.
 *
 * Mirrors route-swap.test.ts: rebind repos to an in-memory driver, then
 * exercise the routes through fetch(). Catches dropped status codes,
 * validation gaps, and any divergence between the fs and memory drivers
 * for the new designSystems() scope.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMemoryDriver } from "../storage/memory-driver.ts";
import { rebindRepos } from "../storage/repos/index.ts";

let designSystemsRoutes: { fetch: (req: Request) => Promise<Response> | Response };
let projectsRoutes: { fetch: (req: Request) => Promise<Response> | Response };

beforeAll(async () => {
  rebindRepos(createMemoryDriver());
  const ds = await import("./designSystems.ts");
  designSystemsRoutes = ds.designSystemsRoutes;
  const proj = await import("./projects.ts");
  projectsRoutes = proj.projectsRoutes;
});

afterAll(() => {
  rebindRepos(createMemoryDriver());
});

async function call(
  routes: typeof designSystemsRoutes,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await routes.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

describe("design-systems routes", () => {
  it("list starts empty", async () => {
    const r = await call(designSystemsRoutes, "GET", "/api/design-systems");
    expect(r.status).toBe(200);
    expect(r.json).toEqual([]);
  });

  it("create + list + get + update + publish + delete round-trip", async () => {
    const created = await call(designSystemsRoutes, "POST", "/api/design-systems", {
      name: "Cabin Brand",
      description: "Warm cream and rust. Friendly serif headings.",
    });
    expect(created.status).toBe(200);
    const ds = created.json as { id: string; name: string; description: string; published: boolean };
    expect(ds.id.length).toBeGreaterThan(0);
    expect(ds.name).toBe("Cabin Brand");
    expect(ds.published).toBe(false);

    const list = await call(designSystemsRoutes, "GET", "/api/design-systems");
    expect(list.status).toBe(200);
    const summaries = list.json as Array<{ id: string; name: string; published: boolean }>;
    expect(summaries.find((s) => s.id === ds.id)?.name).toBe("Cabin Brand");

    const got = await call(designSystemsRoutes, "GET", `/api/design-systems/${ds.id}`);
    expect(got.status).toBe(200);
    const fetched = got.json as { description: string };
    expect(fetched.description).toContain("Warm cream");

    const updated = await call(designSystemsRoutes, "PUT", `/api/design-systems/${ds.id}`, {
      name: "Cabin Brand v2",
    });
    expect(updated.status).toBe(200);
    expect((updated.json as { name: string }).name).toBe("Cabin Brand v2");

    // Explicit published=true.
    const pub = await call(designSystemsRoutes, "POST", `/api/design-systems/${ds.id}/publish`, {
      published: true,
    });
    expect(pub.status).toBe(200);
    expect((pub.json as { published: boolean }).published).toBe(true);

    // Toggle (no body).
    const toggled = await call(designSystemsRoutes, "POST", `/api/design-systems/${ds.id}/publish`);
    expect(toggled.status).toBe(200);
    expect((toggled.json as { published: boolean }).published).toBe(false);

    const deleted = await call(designSystemsRoutes, "DELETE", `/api/design-systems/${ds.id}`);
    expect(deleted.status).toBe(200);

    const after = await call(designSystemsRoutes, "GET", `/api/design-systems/${ds.id}`);
    expect(after.status).toBe(404);
  });

  it("rejects malformed create", async () => {
    const noName = await call(designSystemsRoutes, "POST", "/api/design-systems", {
      description: "x",
    });
    expect(noName.status).toBe(400);

    const noDesc = await call(designSystemsRoutes, "POST", "/api/design-systems", {
      name: "x",
    });
    expect(noDesc.status).toBe(400);
  });

  it("project create accepts and validates design_system_id", async () => {
    // Spin up a real DS the project can bind to.
    const dsResp = await call(designSystemsRoutes, "POST", "/api/design-systems", {
      name: "Brand A",
      description: "Loose system.",
    });
    const ds = dsResp.json as { id: string };

    // Reject typo'd id at create time — the project would otherwise be
    // permanently asking the agent for a non-existent brand.
    const reject = await call(projectsRoutes, "POST", "/api/projects/create", {
      id: "p_ds_bad",
      name: "Bad",
      design_system_id: "ds_nonexistent",
    });
    expect(reject.status).toBe(400);

    // Happy path — manifest carries the id.
    const ok = await call(projectsRoutes, "POST", "/api/projects/create", {
      id: "p_ds_ok",
      name: "Good",
      design_system_id: ds.id,
    });
    expect(ok.status).toBe(200);
    const created = ok.json as { manifest: { designSystemId?: string } };
    expect(created.manifest.designSystemId).toBe(ds.id);
  });
});
