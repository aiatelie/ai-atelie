/* test-multi-turn.mjs — drive the editor's API end-to-end and report.
 *
 * 1. Create a project
 * 2. Send three sequential comment-edit turns in the same session
 * 3. For each turn: print live SSE events, capture errors, time it
 *
 * If the bug reproduces, we'll see "exit code 1" on turn 2 — and the
 * server's /tmp/cc-vite.log will show the [runClaude] trace lines.
 */

import { randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:4321";
const SESSION_ID = randomUUID(); // shared across all turns — exercises --resume

console.log(`session: ${SESSION_ID.slice(0, 8)}…`);
console.log(`base:    ${BASE}`);

/* ─── 1. Create project ─────────────────────────────────────── */

console.log("\n=== STEP 1 — create project ===");
const createRes = await fetch(`${BASE}/api/projects/create`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: `multi-turn-test-${Date.now()}` }),
});
if (!createRes.ok) {
  console.error(`create failed: HTTP ${createRes.status}`);
  console.error(await createRes.text());
  process.exit(1);
}
const created = await createRes.json();
console.log(`✓ created project ${created.id} with ${created.manifest.pages.length} page(s)`);

const PROJECT_ID = created.id;
const ROUTE = created.manifest.pages[0].file; // probably "index.html"

/* ─── 2. Helper: send one comment-edit turn, stream events ──── */

async function sendTurn(label, text) {
  console.log(`\n=== ${label} — "${text}" ===`);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/comment-edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      route: ROUTE,
      selector: "",
      comment: text,
      attachments: [],
      sessionId: SESSION_ID,
      modelId: "claude-opus-4-7",
      projectId: PROJECT_ID,
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    console.error(`✗ HTTP ${res.status} — ${t.slice(0, 200)}`);
    return { ok: false, error: `HTTP ${res.status}`, ms: Date.now() - t0 };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const result = { ok: true, error: null, tools: 0, textChars: 0, retries: 0, ms: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let ev = "message";
      const dataLines = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let parsed;
      try { parsed = JSON.parse(dataLines.join("\n")); } catch { continue; }

      if (ev === "error") {
        result.ok = false;
        result.error = parsed.message ?? "unknown error";
        process.stdout.write(`\n  ✗ ERROR: ${result.error}\n`);
      } else if (ev === "status") {
        if (parsed.phase === "retry") {
          result.retries += 1;
          process.stdout.write(`\n  ↻ retry: ${parsed.reason}\n`);
        }
      } else if (ev === "sdk") {
        // tally tool uses + text deltas
        if (parsed.type === "stream_event" &&
            parsed.event?.type === "content_block_delta" &&
            parsed.event.delta?.type === "text_delta" &&
            parsed.event.delta.text) {
          process.stdout.write(parsed.event.delta.text);
          result.textChars += parsed.event.delta.text.length;
        } else if (parsed.type === "assistant" && parsed.message?.content) {
          for (const c of parsed.message.content) {
            if (c.type === "tool_use") {
              const inputStr = c.input ? JSON.stringify(c.input).slice(0, 60) : "";
              process.stdout.write(`\n  🔧 ${c.name} ${inputStr}\n`);
              result.tools += 1;
            }
          }
        }
      }
    }
  }
  result.ms = Date.now() - t0;
  process.stdout.write(`\n  · ${result.ms}ms · tools=${result.tools} chars=${result.textChars} retries=${result.retries} ${result.ok ? "✓" : "✗"}\n`);
  return result;
}

/* ─── 3. Run the three turns ────────────────────────────────── */

const r1 = await sendTurn("STEP 2 — Turn 1", "Replace the page content with a single h1 that says \"hello world\". Just edit index.html. No prose reply needed, just do it.");
const r2 = await sendTurn("STEP 3 — Turn 2", "Now make the h1 text blue.");
const r3 = await sendTurn("STEP 4 — Turn 3", "Now make it red instead.");

/* ─── 4. Summary ────────────────────────────────────────────── */

console.log("\n\n=== SUMMARY ===");
console.log(`Turn 1 (hello world): ${r1.ok ? "✓" : "✗ " + r1.error} (${r1.ms}ms, retries=${r1.retries})`);
console.log(`Turn 2 (blue):        ${r2.ok ? "✓" : "✗ " + r2.error} (${r2.ms}ms, retries=${r2.retries})`);
console.log(`Turn 3 (red):         ${r3.ok ? "✓" : "✗ " + r3.error} (${r3.ms}ms, retries=${r3.retries})`);

const allOk = r1.ok && r2.ok && r3.ok;
console.log(allOk ? "\n✓ MULTI-TURN STABLE" : "\n✗ MULTI-TURN UNSTABLE — see /tmp/cc-vite.log");
process.exit(allOk ? 0 : 1);
