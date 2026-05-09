/* verifier.ts — fire-and-forget background QA after each artifact-producing turn.
 *
 * After the main agent loop returns, commentEdit forks runVerifier() with
 * the snapshot we recorded before the turn started. We diff the snapshot
 * against current disk to get the list of files the agent just wrote,
 * read their contents, and call a cheap haiku model with a focused QA
 * system prompt.
 *
 * Silent on pass: if the model returns "OK" (or no real findings), we
 * discard the result. Only on failure do we inject a `[Verifier] ⚠ …`
 * AgentEvent text chunk into the chat thread so the user (and the next
 * agent turn) can see and fix the issues.
 *
 * Constraints:
 *   • non-blocking — runVerifier() is called without await; an error in
 *     the verifier never crashes the main turn.
 *   • cheap — claude-haiku-4-5-20251001, max_tokens 1024.
 *   • bounded — we cap the number of files (8) and per-file bytes (12 KB)
 *     fed to the model, so a giant refactor doesn't balloon the QA call.
 *   • auth — requires ANTHROPIC_API_KEY (the main `claude` CLI uses
 *     subscription OAuth and strips this env var; the verifier is a
 *     separate direct-API call). When the key is missing we no-op.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { ENV } from "../env.ts";
import { diffSnapshot, type SnapshotEntry } from "./snapshots.ts";
import { getRepos } from "../storage/repos/index.ts";
import type { Emitter } from "./types.ts";

/** Cheap, fast model — QA findings only. */
const VERIFIER_MODEL = "claude-haiku-4-5-20251001";
const VERIFIER_MAX_TOKENS = 1024;
/** Cap files-fed-to-verifier so a giant refactor doesn't blow up the QA call. */
const MAX_FILES = 8;
/** Per-file content cap (chars). Beyond this we truncate with a marker. */
const MAX_FILE_BYTES = 12_000;

const VERIFIER_SYSTEM_PROMPT = `You are a silent QA verifier for generated web artifacts. You receive a list of files just written by an AI agent.

Your job: check for obvious errors ONLY. Do not comment on style, preferences, or improvements.

Check for:
- JavaScript/JSX syntax errors (unclosed brackets, missing semicolons that break parsing)
- Broken import paths (imports of files that don't exist in the provided list)
- Completely empty or stub files (< 5 lines, no real content)
- HTML with obviously unclosed non-void tags

If EVERYTHING looks fine, respond with exactly: OK
If you find real issues, list them briefly (one line each), prefixed with "⚠ ".
Do NOT say "looks good" or give style feedback. Only flag actual errors.`;

export type VerifierArgs = {
  /** Pre-turn snapshot. We diff against current disk to find what the agent wrote. */
  snapshot: SnapshotEntry;
  /** Same projectId the turn ran against. null = legacy LEGACY_EDITOR_ROOT/src. */
  projectId: string | null;
  /** SSE emitter — same one the main loop used. We push our `[Verifier]` text on the `agent` channel. */
  send: Emitter;
  /** Optional abort signal — if the parent run was aborted, skip the QA call. */
  abortSignal?: AbortSignal;
};

/** Read the current contents of one modified file. Returns null on
 *  read error so the verifier still runs against the rest. */
async function readModified(projectId: string | null, path: string): Promise<string | null> {
  try {
    if (projectId) {
      const r = await getRepos().projectFiles.readText(projectId, path);
      return r.ok ? r.text : null;
    }
    const abs = resolvePath(ENV.LEGACY_EDITOR_ROOT, "src", path);
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

/** True if the verifier's text indicates real findings (not "OK" / "looks good"). */
function hasFindings(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // Exact OK is the silent-pass sentinel.
  if (t === "OK") return false;
  // Defensive: accept "OK." / "OK\n…" but treat "OK, but…" as findings.
  if (/^OK[.\s]*$/i.test(t)) return false;
  // Common false-positives we explicitly reject.
  const lc = t.toLowerCase();
  if (lc === "looks good" || lc === "no issues found" || lc === "all good") return false;
  // Real flag char from the system prompt.
  if (t.includes("⚠")) return true;
  // Otherwise: if it's non-empty and not OK, treat as findings.
  return true;
}

/** Build the user-message payload for the verifier call. Truncates per
 *  file to MAX_FILE_BYTES and caps total file count to MAX_FILES. */
function buildVerifierUserMessage(files: Array<{ path: string; contents: string }>): string {
  const parts: string[] = [];
  parts.push(`The agent just wrote ${files.length} file(s). Review them for obvious errors.`);
  parts.push("");
  parts.push(`Files (paths only, for cross-checking imports):`);
  for (const f of files) parts.push(`- ${f.path}`);
  parts.push("");
  for (const f of files) {
    const truncated = f.contents.length > MAX_FILE_BYTES
      ? f.contents.slice(0, MAX_FILE_BYTES) + `\n…(truncated, full length ${f.contents.length})`
      : f.contents;
    parts.push(`=== ${f.path} ===`);
    parts.push(truncated);
    parts.push("");
  }
  return parts.join("\n");
}

/** Fire-and-forget. Catches all errors internally. Returns immediately;
 *  the QA call runs in the background. */
export function runVerifier(args: VerifierArgs): void {
  // Don't even start the QA call if the parent was aborted — the user
  // either pressed Stop or we timed out, and edits are mid-flight.
  if (args.abortSignal?.aborted) return;
  // Auth: we make a direct Anthropic API call (NOT the claude-agent-sdk
  // OAuth path), so we need an API key. When missing, silently skip —
  // the verifier is best-effort QA, not a hard requirement.
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) return;
  // Detach: never block the caller, never propagate errors.
  void verifyAsync(args, apiKey).catch((err) => {
    console.warn(
      `[verifier] background QA crashed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function verifyAsync(args: VerifierArgs, apiKey: string): Promise<void> {
  const { snapshot, projectId, send, abortSignal } = args;

  // 1) Diff snapshot → list of files the agent modified during this turn.
  let modified: string[];
  try {
    const result = await diffSnapshot(snapshot);
    modified = result.modified;
  } catch (err) {
    console.warn(
      `[verifier] diff failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (modified.length === 0) return; // No artifacts → nothing to verify.

  if (abortSignal?.aborted) return;

  // 2) Read current contents of the modified files (cap at MAX_FILES).
  const capped = modified.slice(0, MAX_FILES);
  const files: Array<{ path: string; contents: string }> = [];
  for (const path of capped) {
    const contents = await readModified(projectId, path);
    if (contents !== null) files.push({ path, contents });
  }
  if (files.length === 0) return;

  if (abortSignal?.aborted) return;

  // 3) Call haiku with the QA prompt. Bounded by max_tokens; no streaming.
  const client = new Anthropic({ apiKey });
  let text = "";
  try {
    const resp = await client.messages.create({
      model: VERIFIER_MODEL,
      max_tokens: VERIFIER_MAX_TOKENS,
      system: VERIFIER_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildVerifierUserMessage(files) },
      ],
    });
    // Per the system prompt the model only emits one end_turn text block.
    if (resp.stop_reason !== "end_turn") return;
    for (const block of resp.content) {
      if (block.type === "text") text += block.text;
    }
  } catch (err) {
    console.warn(
      `[verifier] api call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (abortSignal?.aborted) return;

  // 4) Silent on pass — only inject when there are real findings.
  if (!hasFindings(text)) return;

  // Inject as a normalized agent text event so it threads into the chat
  // alongside the assistant's other output. The `[Verifier]` prefix lets
  // the frontend / next-turn agent recognize the source.
  const trimmed = text.trim();
  const message = trimmed.startsWith("[Verifier]")
    ? trimmed
    : `[Verifier] ${trimmed}`;
  try {
    send("agent", { type: "text", chunk: `\n\n${message}\n` });
  } catch (err) {
    console.warn(
      `[verifier] emit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Exported for test / introspection. Not used at runtime.
export const __TEST__ = { hasFindings, buildVerifierUserMessage, VERIFIER_SYSTEM_PROMPT };
