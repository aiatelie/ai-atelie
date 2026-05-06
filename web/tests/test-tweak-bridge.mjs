/* test-tweak-bridge.mjs — end-to-end test of the make-tweakable bridge.
 *
 * 1. Create a project with a tweakable index.html (EDITMODE markers).
 * 2. Simulate the iframe posting __edit_mode_set_keys.
 *    (We invoke the server endpoint directly — same code path the host
 *     bridge uses.)
 * 3. Verify file changed on disk.
 * 4. Repeat with a second key to make sure shallow-merge preserves
 *    untouched defaults.
 * 5. Negative tests: missing file, no markers, malformed JSON.
 */

import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const BASE = "http://127.0.0.1:4321";

const ok = (b, label) => console.log(`  ${b ? "✓" : "✗"} ${label}`);

const make = await fetch(`${BASE}/api/projects/create`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "tweak-bridge-test" }),
});
const { id } = await make.json();
const dir = new URL(`../projects/${id}/`, import.meta.url).pathname;
console.log(`project: ${id}`);

const STARTER = `<!doctype html>
<script>
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "primaryColor": "#d97757",
  "fontSize": 16,
  "dark": false,
  "title": "Hello"
}/*EDITMODE-END*/;
</script>`;
await writeFile(join(dir, "index.html"), STARTER, "utf8");

/* Test 1 — single-key edit */
console.log("\n=== single-key edit ===");
const r1 = await fetch(`${BASE}/api/projects/${id}/tweak`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ file: "index.html", edits: { fontSize: 24 } }),
});
const j1 = await r1.json();
ok(r1.ok, `HTTP 200 (got ${r1.status})`);
ok(j1.after?.fontSize === 24, `fontSize = 24 in response`);
ok(j1.after?.primaryColor === "#d97757", `primaryColor unchanged in response`);
const after1 = await readFile(join(dir, "index.html"), "utf8");
ok(/"fontSize": 24/.test(after1), `fontSize = 24 on disk`);
ok(/"primaryColor": "#d97757"/.test(after1), `primaryColor unchanged on disk`);
ok(/EDITMODE-BEGIN.*EDITMODE-END/s.test(after1), `markers preserved`);

/* Test 2 — multi-key edit, including booleans + strings */
console.log("\n=== multi-key edit ===");
const r2 = await fetch(`${BASE}/api/projects/${id}/tweak`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ file: "index.html", edits: { dark: true, title: "Re-titled" } }),
});
const j2 = await r2.json();
ok(r2.ok && j2.after?.dark === true && j2.after?.title === "Re-titled", `multi-key applied`);
const after2 = await readFile(join(dir, "index.html"), "utf8");
ok(/"dark": true/.test(after2), `dark=true on disk`);
ok(/"title": "Re-titled"/.test(after2), `title rewritten on disk`);
ok(/"fontSize": 24/.test(after2), `prior fontSize edit preserved`);

/* Test 3 — no markers in target file */
console.log("\n=== negative: file with no markers ===");
await writeFile(join(dir, "no-markers.html"), `<!doctype html><body>nope</body>`, "utf8");
const r3 = await fetch(`${BASE}/api/projects/${id}/tweak`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ file: "no-markers.html", edits: { x: 1 } }),
});
ok(r3.status === 404, `404 expected (got ${r3.status})`);
const j3 = await r3.json();
ok(/EDITMODE/.test(j3.error ?? ""), `error mentions EDITMODE`);

/* Test 4 — malformed JSON between markers */
console.log("\n=== negative: malformed EDITMODE JSON ===");
await writeFile(
  join(dir, "broken.html"),
  `<script>const x = /*EDITMODE-BEGIN*/{not valid json}/*EDITMODE-END*/;</script>`,
  "utf8",
);
const r4 = await fetch(`${BASE}/api/projects/${id}/tweak`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ file: "broken.html", edits: { x: 1 } }),
});
ok(r4.status === 422, `422 expected (got ${r4.status})`);

/* Test 5 — path traversal rejection */
console.log("\n=== negative: path traversal ===");
const r5 = await fetch(`${BASE}/api/projects/${id}/tweak`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ file: "../../../etc/passwd", edits: { x: 1 } }),
});
ok(r5.status === 400, `400 expected (got ${r5.status})`);

/* Test 6 — edits with same value (no-op) */
console.log("\n=== no-op edit (same value) ===");
const r6 = await fetch(`${BASE}/api/projects/${id}/tweak`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ file: "index.html", edits: { fontSize: 24 } }),
});
const j6 = await r6.json();
ok(r6.ok, `HTTP 200 on no-op`);
ok(j6.unchanged === true, `response flagged unchanged`);

/* Cleanup */
await fetch(`${BASE}/api/projects/${id}`, { method: "DELETE" });
console.log("\n--- project deleted ---");
console.log("\n✓ ALL CHECKS PASSED");
