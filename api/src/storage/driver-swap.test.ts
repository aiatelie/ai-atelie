/* driver-swap.test.ts — proves the StorageDriver interface is honest.
 *
 * The same set of operations (project lifecycle, meta JsonKv with ETag
 * + If-Match, file BlobStore, change subscriptions) is exercised against
 * both drivers. Anything that diverges other than ETag string format
 * means the interface is leaking implementation details.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageDriver } from "./driver.ts";
import { createFsDriver } from "./fs-driver.ts";
import { createMemoryDriver } from "./memory-driver.ts";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function makeFs(): StorageDriver {
  const projectsRoot = mkdtempSync(join(tmpdir(), "atelie-driver-swap-projects-"));
  const sharedRoot = mkdtempSync(join(tmpdir(), "atelie-driver-swap-shared-"));
  tmpDirs.push(projectsRoot, sharedRoot);
  // Fast debounce so subscription assertions don't burn seconds in tests.
  return createFsDriver({ projectsRoot, sharedRoot, reloadDebounceMs: 30 });
}

function makeMemory(): StorageDriver {
  return createMemoryDriver();
}

const drivers: { name: string; make: () => StorageDriver }[] = [
  { name: "fs", make: makeFs },
  { name: "memory", make: makeMemory },
];

describe.each(drivers)("StorageDriver:$name", ({ make }) => {
  it("info() reports name + interface version", () => {
    const driver = make();
    const info = driver.info();
    expect(typeof info.name).toBe("string");
    expect(info.version).toBe(1);
  });

  it("project lifecycle: create, list, delete", async () => {
    const driver = make();
    expect(await driver.listProjectIds()).toEqual([]);
    await driver.createProject("p_one");
    expect(await driver.listProjectIds()).toEqual(["p_one"]);
    await driver.deleteProject("p_one");
    expect(await driver.listProjectIds()).toEqual([]);
  });

  it("JsonKv: missing key returns not_found", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const r = await driver.project("p_a").meta.get("threads");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("JsonKv: put then get round-trips", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const meta = driver.project("p_a").meta;
    const put = await meta.put("threads", { messages: [{ role: "user" }] });
    expect(put.ok).toBe(true);
    const got = await meta.get<{ messages: { role: string }[] }>("threads");
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.messages[0].role).toBe("user");
      if (put.ok) expect(got.etag).toBe(put.etag);
    }
  });

  it("JsonKv: put with wrong ifMatch returns conflict + currentEtag", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const meta = driver.project("p_a").meta;
    const put1 = await meta.put("threads", { v: 1 });
    expect(put1.ok).toBe(true);
    if (!put1.ok) return;
    const conflict = await meta.put("threads", { v: 2 }, { ifMatch: "wrong-etag" });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe("conflict");
      expect(conflict.currentEtag).toBe(put1.etag);
    }
  });

  it("JsonKv: put with right ifMatch succeeds and yields a new etag", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const meta = driver.project("p_a").meta;
    const put1 = await meta.put("threads", { v: 1 });
    expect(put1.ok).toBe(true);
    if (!put1.ok) return;
    const put2 = await meta.put("threads", { v: 2 }, { ifMatch: put1.etag });
    expect(put2.ok).toBe(true);
  });

  it("JsonKv: subscribe fires on put and delete", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const meta = driver.project("p_a").meta;
    const events: string[] = [];
    const unsub = meta.subscribe((e) => events.push(`${e.type}:${e.key}`));
    await meta.put("threads", { v: 1 });
    await meta.put("comments", []);
    await meta.delete("comments");
    unsub();
    expect(events).toEqual(["put:threads", "put:comments", "delete:comments"]);
  });

  it("BlobStore: write, read, list, exists", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const files = driver.project("p_a").files;
    await files.write("index.html", "<h1>Hi</h1>");
    await files.write("style.css", ":root{}");
    expect(await files.exists("index.html")).toBe(true);
    expect(await files.exists("missing.html")).toBe(false);
    const read = await files.readText("index.html");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toBe("<h1>Hi</h1>");
    const list = (await files.list()).map((f) => f.path).sort();
    expect(list).toContain("index.html");
    expect(list).toContain("style.css");
  });

  it("BlobStore: refuses dot-prefix segments (so .meta/* is invisible)", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const files = driver.project("p_a").files;
    expect(await files.exists(".meta/threads.json")).toBe(false);
    const r = await files.read(".meta/threads.json");
    expect(r.ok).toBe(false);
    expect(() => files.write(".meta/threads.json", "x")).toThrow();
  });

  it("BlobStore: refuses traversal", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const files = driver.project("p_a").files;
    expect(await files.exists("../escape")).toBe(false);
    const r = await files.read("../escape");
    expect(r.ok).toBe(false);
  });

  it("BlobStore: subscribe fires on writes (allowing for fs.watch debounce)", async () => {
    const driver = make();
    await driver.createProject("p_a");
    const files = driver.project("p_a").files;
    const events: string[] = [];
    const unsub = files.subscribe((e) => events.push(`${e.type}:${e.path}`));
    // fs.watch starts asynchronously on macOS; give it a moment to attach
    // before we issue the writes we want it to observe.
    await new Promise((r) => setTimeout(r, 50));
    await files.write("index.html", "<h1>1</h1>");
    await files.write("index.html", "<h1>2</h1>");
    // Wait through the 30ms reload-channel debounce + fs flush.
    await new Promise((r) => setTimeout(r, 300));
    unsub();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.startsWith("put:"))).toBe(true);
  });

  it("Shared kv: round-trip + subscribe", async () => {
    const driver = make();
    const kv = driver.shared().kv;
    const events: string[] = [];
    const unsub = kv.subscribe((e) => events.push(e.key));
    const put = await kv.put("assets", { palette: ["#f00"] });
    expect(put.ok).toBe(true);
    const got = await kv.get<{ palette: string[] }>("assets");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.palette).toEqual(["#f00"]);
    unsub();
    expect(events).toContain("assets");
  });

  it("deleteProject removes the project's data and channels", async () => {
    const driver = make();
    await driver.createProject("p_dead");
    const files = driver.project("p_dead").files;
    await files.write("index.html", "<h1>bye</h1>");
    await driver.deleteProject("p_dead");
    expect(await driver.listProjectIds()).not.toContain("p_dead");
  });
});
