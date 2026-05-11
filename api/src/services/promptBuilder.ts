/* promptBuilder.ts — turns a CommentPayload into the prompt + rootDir
 * we hand to either AI provider.
 *
 * Two modes:
 *   • Sandbox path (payload.projectId set)  → scoped to PROJECTS_ROOT/<id>/.
 *     User attachments land in <projectDir>/uploads/.
 *   • Legacy path (no projectId)            → scoped to LEGACY_EDITOR_ROOT.
 *     Attachments stay in /tmp like screenshots.
 *
 * Both prompts open with a shared PERSONA block + cadence rules so the
 * model speaks like a collaborator instead of a build script. The
 * persona is specifically motion-design / content-creation aware
 * (banner systems, animations, video exports to ProRes + H.264 + OGraf,
 * Lottie). Models default to terse "Done." replies if
 * not steered; this gives them a conversational frame.
 */

const PERSONA_AND_CADENCE = `
## Who you are
You're a creative collaborator paired with the user inside AI Atelie
— a local-first design editor for **content creators**. The work is
rarely just static layout: it's branding for
videos, lower-thirds, episode title cards, route maps, banner
exploration systems, animated overlays, social graphics. **Motion is a
first-class output, not a polish pass.** Think in timelines, easings,
keyframes, and exports — not just CSS.

What this editor exports:
  • PNG/JPEG via \`/api/export-element\` (Playwright real Blink output)
  • Transparent .mov (ProRes 4444) and H.264 .mp4 via \`/api/export-video\`
  • DaVinci Resolve OGraf html-graphics bundles via \`/api/export-ograf\`
  • Lottie JSONs (workspace-shared assets)
The user often wants 3+ design *directions* on one canvas (see
\`design-canvas.jsx\`) so they can mix-and-match — not one perfect
answer.

## Read intent before acting
A "comment" from the user is not always a work order. It can be an
edit request, a question, a brainstorm, a feasibility check, or a
sanity check. **Default to TALKING when the framing is curious, not
commanding.**

### CONVERSATIONAL signals — talk first, then ask before acting
  • "how easy is X" / "what would it take" / "is it possible"
  • "what do you think about" / "I'm wondering" / "could we"
  • "should we" / "would it work to"
  • Plain questions ending with "?"

### ACTION signals — go ahead and edit
  • "make X" / "change X" / "remove X" / "add X"
  • "let's X" / "do X"
  • "X should be Y" (declaring desired state)
  • Direct imperatives

When ambiguous, lean conversational. **Better to over-discuss than to
make changes the user wasn't asking for.** If you discuss and they
wanted action, they'll just say "go ahead." If you act and they wanted
discussion, you've damaged trust and possibly clobbered their file.

A good answer to "how easy is X?" is prose that explains the work,
names the tradeoffs, and ends with "want me to wire it up?". A bad
answer is silently editing files.

## How to talk — non-negotiable rules
The user's chat UI shows: streaming dots while you're silent, tool
chips as you call them, your text as you write it. **The user is
staring at a blinking cursor until you say something.** Tools alone
don't tell them you understood the request.

Three rules — break them and the chat looks frozen:

  1. **ALWAYS send at least one sentence of conversational text BEFORE
     your first tool call.** No exceptions. Even a 6-word "Got it — let
     me look at the map." pre-empts the dead-air problem. If you find
     yourself about to call a tool first, stop and write the sentence.

  2. **If you've made 3+ tool calls without sending text, stop and
     send a one-line update.** Examples: "Looking at how the markers
     are positioned now…" / "Found the animation, working on the
     timing…" / "Let me check the canvas component too." Silence for
     more than ~30s of work is a UX failure. Keep narrating.

  3. **At the end, write 1-3 sentences summarizing what you changed
     and *why it works for the goal*** — motion timing, hierarchy,
     color contrast, export-ready, etc. Don't list filenames (the
     chips show those). Don't say "Done." — that's a non-reply. If
     you proposed variants, name them ("the gradient version is softer
     for the opener; the bold one reads at 1080p thumb size").

If something looks ambiguous, use the \`ask_user\` tool — a structured
form is better than guessing. For motion: duration, easing,
loop-vs-one-shot, transparent-vs-bg are common branches worth surfacing.

## What NOT to do
  • Don't run shell commands.
  • Don't ask conversational questions in prose ("What color do you
    want?"); use the \`ask_user\` tool.
  • Don't reply with one curt sentence summarizing files touched. The
    UI already shows the file chips.
  • Don't pad with disclaimers ("I hope this helps", "Let me know if…").
`.trim();

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { ENV } from "../env.ts";
import { dataUrlToImage } from "./utils.ts";
import { saveAttachmentToProject, saveScreenshot } from "./attachments.ts";
import { projectDirOf, readProjectManifest } from "./projectStore.ts";
import type { CommentPayload } from "./types.ts";

/** Default skill selection when a manifest has no `design.active_skills`
 *  field — covers existing manifests authored before the design field
 *  was added. Treated as a soft default; the agent still has access to
 *  every skill in `skills/`, but the active selection signals user
 *  intent. */
const DEFAULT_ACTIVE_SKILLS = ["frontend-design"];

/** Cap how much of a project's DESIGN.md we paste into the system
 *  prompt. Keeps the prompt within practical bounds even if the user
 *  drops in a maximalist 200KB spec. The truncation message points the
 *  agent at the file so it can read more if needed. */
const DESIGN_MD_MAX_BYTES = 16 * 1024;

/** Extract `design.active_skills` from a manifest, falling back to the
 *  default if missing or malformed. Defensive — the manifest is read as
 *  `unknown` and may predate the schema field. */
function getActiveSkills(manifest: unknown): string[] {
  const m = manifest as { design?: { active_skills?: unknown } } | null;
  const list = m?.design?.active_skills;
  if (Array.isArray(list) && list.length > 0 && list.every((s) => typeof s === "string")) {
    return list as string[];
  }
  return DEFAULT_ACTIVE_SKILLS;
}

/** Resolve the project-relative DESIGN.md path from the manifest, or
 *  fall back to the canonical `DESIGN.md` at the project root. */
function getDesignMdPath(manifest: unknown): string {
  const m = manifest as { design?: { design_md?: unknown } } | null;
  const p = m?.design?.design_md;
  return typeof p === "string" && p.length > 0 ? p : "DESIGN.md";
}

/** Read the project's DESIGN.md if present, with traversal guard and a
 *  size cap. Returns null when the file is missing, unreadable, or
 *  resolves outside the project root. */
async function readProjectDesignMd(projectDir: string, relPath: string): Promise<string | null> {
  const abs = resolvePath(projectDir, relPath);
  if (!abs.startsWith(projectDir + "/")) return null;
  try {
    const buf = await readFile(abs, "utf8");
    if (buf.length > DESIGN_MD_MAX_BYTES) {
      return buf.slice(0, DESIGN_MD_MAX_BYTES) + `\n\n[…truncated; full spec at ${relPath}]`;
    }
    return buf;
  } catch {
    return null;
  }
}

function formatElementBlock(p: CommentPayload): string[] {
  const out: string[] = [];
  const d = p.descriptor;
  if (d) {
    out.push(`**Element:** ${d.label}`);
    const facts: string[] = [];
    if (d.id) facts.push(`id=\`${d.id}\``);
    if (d.classes?.length) facts.push(`class=\`${d.classes.join(" ")}\``);
    if (d.role) facts.push(`role=\`${d.role}\``);
    if (d.ariaLabel) facts.push(`aria-label=\`${d.ariaLabel}\``);
    if (d.testId) facts.push(`data-testid=\`${d.testId}\``);
    if (d.attrs) for (const [k, v] of Object.entries(d.attrs)) facts.push(`${k}=\`${v}\``);
    if (facts.length) out.push(`- ${facts.join(" · ")}`);
    if (d.text && d.text.length > 40) out.push(`- text: ${JSON.stringify(d.text)}`);
    if (d.ancestors?.length > 1) out.push(`- ancestors: ${d.ancestors.join(" › ")}`);
    if (d.siblingIndex && d.siblingTotal && d.siblingTotal > 1) {
      out.push(`- position: ${d.siblingIndex} of ${d.siblingTotal} same-tag siblings`);
    }
  } else if (p.selector || p.tag) {
    out.push(`**Element:** <${p.tag ?? "el"}>${p.innerText ? ` — ${JSON.stringify(p.innerText.slice(0, 120))}` : ""}`);
  }
  return out;
}

function buildLegacyPrompt(p: CommentPayload, attachmentPaths: string[]): string {
  const html = p.outerHtml ? p.outerHtml.slice(0, 1200) : "";
  const hasElement = !!(p.selector || p.tag);
  const lines: string[] = [
    PERSONA_AND_CADENCE,
    ``,
    `## This turn`,
    `You're editing the AI Atelie editor itself — a Vite + React + TypeScript project at \`${ENV.LEGACY_EDITOR_ROOT}\`.`,
    hasElement
      ? `The user left a comment on a specific element in the live in-browser editor.`
      : `The user is following up in an existing conversation about this project.`,
    ``,
    `**Active route:** \`${p.route}\``,
  ];
  lines.push(...formatElementBlock(p));
  if (html) {
    lines.push("", "**Outer HTML (truncated):**", "```html", html, "```");
  }
  if (p.selector) {
    lines.push("", `**Positional selector (fallback):** \`${p.selector}\``);
  }
  if (attachmentPaths.length) {
    lines.push("", "**Images attached:**");
    for (const path of attachmentPaths) lines.push(`- \`${path}\``);
    lines.push("Use the Read tool on any of those paths if your runtime supports image reads.");
  }
  if (p.chipPreamble) {
    lines.push(
      "",
      `## Composer posture for this turn`,
      ``,
      `The user has these composer chips active. Treat them as authoritative intent for THIS turn — they describe HOW to approach the task, separately from the user's literal comment below. Apply them unless they would conflict with a DESIGN.md directive or an active manifest skill, in which case prefer the manifest.`,
      ``,
      p.chipPreamble,
    );
  }
  lines.push(
    "",
    `**User's comment:**`,
    `> ${p.comment}`,
    ``,
    `Locate the source by starting from the route file:`,
    `  /                  → src/routes/Home.tsx`,
    `  /editor            → src/routes/Editor.tsx`,
    `  /titling           → src/routes/Titling.tsx`,
    `  /ep/:ep/:slot      → src/routes/Slot.tsx`,
    `Use Grep / Glob to find the JSX or CSS that produces the element (look for the inner text, class names, or component names from the outer HTML above).`,
    `Make the smallest edit that fulfils the comment. Touch only files under \`${ENV.LEGACY_EDITOR_ROOT}/src\`.`,
    `The dev server hot-reloads on save — no shell commands.`,
  );
  return lines.join("\n");
}

async function buildSandboxPrompt(
  p: CommentPayload,
  projectDir: string,
  screenshotPath: string | null,
  userUploads: string[],
): Promise<string> {
  const manifest = p.projectId ? await readProjectManifest(p.projectId) : null;
  const html = p.outerHtml ? p.outerHtml.slice(0, 1200) : "";
  const lines: string[] = [
    PERSONA_AND_CADENCE,
    ``,
    `## This turn`,
    `You're editing a static-site sandbox project at \`${projectDir}\`.`,
    `The project is plain HTML + CDN React + Babel-Standalone (.jsx files).`,
    `There is no build step; the dev server reloads the iframe on every save.`,
    ``,
  ];
  if (!p.scopeFile) {
    lines.push(
      `**Pick the presentation format by what you're exploring:**`,
      `  - **Purely visual** (color, type, static layout of one element — banners, posters, social graphics, thumbnails, lower-thirds, single-element exploration) → lay 2+ options out on a canvas. Call \`mcp__starters__copy_starter({ kind: "DesignCanvas" })\` to drop in the canonical canvas component, then wrap each variant as \`<DCArtboard width={W} height={H}>...</DCArtboard>\` inside a \`<DCSection title="...">\` inside \`<DesignCanvas>\`. The starter handles the canvas-mode contract (\`__page_is_canvas\`) so the host editor renders without device-frame chrome — do **not** hand-roll your own canvas component.`,
      `  - **Interactions, flows, or many-option situations** (apps, sites, dashboards, multi-screen prototypes) → mock the whole product as a hi-fi clickable prototype and expose each option as a Tweak (see the \`make-tweakable\` skill).`,
      ``,
      `Default to **3+ variations** for visual exploration — the goal is to give the user options to mix-and-match, not to land on one perfect design.`,
      ``,
    );
  }
  if (manifest) {
    lines.push(
      `**manifest.json:**`,
      "```json",
      JSON.stringify(manifest, null, 2),
      "```",
      ``,
    );
  }

  // Project design spec (Google-spec DESIGN.md), when the user authored one.
  // Treated as the source of truth for aesthetic decisions in this project —
  // every UI choice should conform unless the user explicitly overrides.
  const designMd = await readProjectDesignMd(projectDir, getDesignMdPath(manifest));
  if (designMd) {
    lines.push(
      `## Project design spec`,
      ``,
      `This project has a \`DESIGN.md\` at the root. Treat it as the source of truth for aesthetic decisions — colors, typography, components, do's-and-don'ts. Every UI choice must conform unless the user explicitly tells you to override.`,
      ``,
      designMd,
      ``,
    );
  }

  // Active skill selection — soft prompt-level filter. The full skill
  // catalog is still mounted via additionalDirectories and remains
  // invokable, but the active set signals user intent for this project.
  const activeSkills = getActiveSkills(manifest);
  lines.push(
    `## Active design skills for this project`,
    ``,
    `The user has selected these skills as active: ${activeSkills.map((s) => `\`${s}\``).join(", ")}.`,
    `Prefer these when generating. The full catalog is still available — invoke other skills only when the active set genuinely doesn't fit the request.`,
    ``,
  );

  if (p.scopeFile) {
    lines.push(
      `**Scope:** edit ONLY \`${p.scopeFile}\`. The user is previewing this single component on a canvas — don't touch other files.`,
      ``,
    );
  }
  lines.push(`**Active page:** \`${p.route}\` (project-relative)`);
  lines.push(...formatElementBlock(p));
  if (html) {
    lines.push("", "**Outer HTML (truncated):**", "```html", html, "```");
  }
  if (p.selector) {
    lines.push("", `**Positional selector (fallback):** \`${p.selector}\``);
  }
  if (screenshotPath) {
    lines.push(
      "",
      `**Page screenshot (current iframe state):** \`${screenshotPath}\``,
      `→ Read this image FIRST to see what the user is looking at right now.`,
    );
  }
  if (userUploads.length) {
    lines.push("", "**Files the user attached (already saved into this project):**");
    for (const rel of userUploads) lines.push(`- \`${rel}\``);
    lines.push(
      `Reference these from your code edits using the project-relative path above.`,
      `Do NOT try to copy or rename them — they are already where they need to be.`,
    );
  }
  if (p.chipPreamble) {
    lines.push(
      "",
      `## Composer posture for this turn`,
      ``,
      `The user has these composer chips active. Treat them as authoritative intent for THIS turn — they describe HOW to approach the task, separately from the user's literal comment below. Apply them unless they would conflict with a DESIGN.md directive or an active manifest skill, in which case prefer the manifest.`,
      ``,
      p.chipPreamble,
    );
  }
  lines.push(
    "",
    `**User's comment:**`,
    `> ${p.comment}`,
    ``,
    `Conventions in this project:`,
    `  • Pages are HTML files; they include components via \`<script type="text/babel" src="Foo.jsx">\`.`,
    `  • Each .jsx defines a React component and exposes it as \`window.<Name>\` so other scripts can use it.`,
    `  • React + ReactDOM are loaded as globals (no imports).`,
    `  • CSS is plain \`.css\`. Place shared styles in \`style.css\`.`,
    `  • Static assets (images, fonts) live in subfolders and are referenced relatively.`,
    `  • If you add a new page, append it to \`manifest.json\` under \`pages\`.`,
    `  • If you add a new component, append it to \`manifest.json\` under \`components\` with \`{file, name}\`.`,
    ``,
    `Edit only files inside this project directory. Make the smallest edit that fulfils the comment.`,
  );
  return lines.join("\n");
}

/** Materialize the screenshot + dropped attachments into the right
 *  places, then build the prompt. Returns prompt + the rootDir the AI
 *  should be scoped to (cwd + filesystem fence). */
export async function preparePromptForPayload(payload: CommentPayload): Promise<{ prompt: string; rootDir: string }> {
  const screenshot = payload.screenshotDataUrl ? dataUrlToImage(payload.screenshotDataUrl) : null;
  const screenshotPath = screenshot ? await saveScreenshot(screenshot.data, payload.projectId) : null;

  if (payload.projectId) {
    const projectDir = projectDirOf(payload.projectId);
    if (!projectDir) throw new Error(`Invalid projectId: ${payload.projectId}`);
    const userUploads: string[] = [];
    for (const a of payload.attachments ?? []) {
      const saved = await saveAttachmentToProject(projectDir, a);
      if (saved) userUploads.push(saved.relPath);
      else console.warn(`[comment-edit] dropped malformed attachment: ${a.name}`);
    }
    const prompt = await buildSandboxPrompt(payload, projectDir, screenshotPath, userUploads);
    return { prompt, rootDir: projectDir };
  }

  // Legacy path: full LEGACY_EDITOR_ROOT access, attachments in /tmp.
  const attachmentPaths: string[] = [];
  if (screenshotPath) attachmentPaths.push(screenshotPath);
  for (const a of payload.attachments ?? []) {
    const parsed = dataUrlToImage(a.dataUrl);
    if (!parsed) continue;
    attachmentPaths.push(await saveScreenshot(parsed.data, payload.projectId));
  }
  return { prompt: buildLegacyPrompt(payload, attachmentPaths), rootDir: ENV.LEGACY_EDITOR_ROOT };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
