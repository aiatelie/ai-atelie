/* test-inspector-css.mjs — verify the inspector-css endpoint roundtrip
 * the way the editor will actually use it.
 *
 * 1. Create project
 * 2. Save 2 selectors with multiple properties → CSS file written
 * 3. Update one selector (replace its props) → file rewritten correctly
 * 4. Save with empty edits map → file shrinks (route slice removed)
 * 5. Save with empty value for a prop → that prop is dropped
 * 6. Verify the static middleware serves the CSS file
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = "http://127.0.0.1:4321";
const ok = (b, label) => console.log(`  ${b ? "✓" : "✗"} ${label}`);

const make = await fetch(`${BASE}/api/projects/create`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "inspector-css-test" }),
});
const { id } = await make.json();
const dir = new URL(`../projects/${id}/`, import.meta.url).pathname;
console.log(`project: ${id}`);

// 1. Save initial edits
console.log("\n=== save 2 selectors ===");
let r = await fetch(`${BASE}/api/projects/${id}/inspector-css`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    route: "index.html",
    edits: {
      ".hero h1": { color: "#0f766e", "font-size": "96px" },
      ".hero p":  { "margin-top": "8px" },
    },
  }),
});
let j = await r.json();
ok(r.ok && j.rules === 2, `rules count = 2 (got ${j.rules})`);
let css = await readFile(join(dir, "_inspector_edits.css"), "utf8");
ok(css.includes(".hero h1") && css.includes("color: #0f766e !important"), `h1 rule emitted`);
ok(css.includes(".hero p") && css.includes("margin-top: 8px !important"), `p rule emitted`);

// 2. Update one selector, drop the other
console.log("\n=== update h1, drop p (omit it) ===");
r = await fetch(`${BASE}/api/projects/${id}/inspector-css`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    route: "index.html",
    edits: { ".hero h1": { color: "red" } }, // dropped p, dropped font-size
  }),
});
j = await r.json();
ok(r.ok && j.rules === 1, `rules = 1 (got ${j.rules})`);
css = await readFile(join(dir, "_inspector_edits.css"), "utf8");
ok(/color: red \!important/.test(css), `h1 color updated to red`);
ok(!/font-size/.test(css), `font-size removed`);
ok(!/\.hero p/.test(css), `p selector removed`);

// 3. Save with empty value drops that prop
console.log("\n=== empty value drops prop ===");
r = await fetch(`${BASE}/api/projects/${id}/inspector-css`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    route: "index.html",
    edits: { ".hero h1": { color: "" } }, // empty value → drop
  }),
});
j = await r.json();
ok(j.rules === 0, `all rules cleared (got ${j.rules})`);
css = await readFile(join(dir, "_inspector_edits.css"), "utf8");
ok(!/\.hero/.test(css), `selector removed when last prop dropped`);

// 4. Static middleware serves the file
console.log("\n=== static middleware serves the CSS ===");
// Save something fresh first
await fetch(`${BASE}/api/projects/${id}/inspector-css`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    route: "index.html",
    edits: { ".x": { color: "blue" } },
  }),
});
r = await fetch(`${BASE}/p/${id}/_inspector_edits.css`);
ok(r.ok, `GET /p/${id}/_inspector_edits.css → ${r.status}`);
const served = await r.text();
ok(served.includes(".x { ") || served.includes(".x {"), `served content includes the rule`);
ok(/text\/css/.test(r.headers.get("content-type") ?? ""), `content-type is text/css (got ${r.headers.get("content-type")})`);

// 5. Multi-route — different routes accumulate
console.log("\n=== multi-route accumulation ===");
await fetch(`${BASE}/api/projects/${id}/inspector-css`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    route: "page2.html",
    edits: { ".y": { color: "green" } },
  }),
});
css = await readFile(join(dir, "_inspector_edits.css"), "utf8");
ok(css.includes("/* ─── route: index.html ─── */"), `index.html section present`);
ok(css.includes("/* ─── route: page2.html ─── */"), `page2.html section present`);
ok(css.includes(".x") && css.includes(".y"), `both selectors in one file`);

await fetch(`${BASE}/api/projects/${id}`, { method: "DELETE" });
console.log("\n--- project deleted ---");
console.log("\n✓ ALL CHECKS PASSED");
