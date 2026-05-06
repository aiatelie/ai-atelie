/* starters-server.mjs — MCP server exposing one tool: `copy_starter`.
 *
 * Provides a `copy_starter_component`-style mechanism:
 * the model picks a kind, the server copies a ready-made scaffold into
 * the project directory, and echoes the file content + path back so the
 * model can immediately slot its design into it.
 *
 * Where the file lands:
 *   The active project directory is passed as the env var
 *   STARTERS_TARGET_DIR by api/src/routes/commentEdit.ts when spawning this
 *   MCP server. If the env var is missing (e.g. local manual testing),
 *   we fall back to the current working directory.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTERS_DIR = resolvePath(HERE, "starters");

/* ─── Catalog of starters ───────────────────────────────────── */

/**
 * @typedef {{ kind: string, file: string, summary: string }} Starter
 */

const STARTERS = /** @type {Record<string, Starter>} */ ({
  DesignCanvas: {
    kind: "DesignCanvas.jsx",
    file: "DesignCanvas.jsx",
    summary:
      "Figma-lite design canvas (window.DesignCanvas + DCSection + DCArtboard) for laying multiple variants of a design side-by-side. Includes pan/zoom, editable labels, focus overlay, and the __page_is_canvas postMessage contract that makes the host editor switch into canvas mode (no device frame). Use this whenever you're exploring 2+ static variations of the same artifact.",
  },
  Stage16x9: {
    kind: "Stage16x9.jsx",
    file: "Stage16x9.jsx",
    summary:
      "Auto-scaling 1920×1080 stage component (window.Stage16x9). Use as the root frame for YouTube-format designs (thumbnails, opening titles, end cards).",
  },
  Stage9x16: {
    kind: "Stage9x16.jsx",
    file: "Stage9x16.jsx",
    summary:
      "Auto-scaling 1080×1920 vertical stage (window.Stage9x16). For Shorts/Reels/TikTok-format designs. Includes optional safe-area overlay (top UI / bottom CTA).",
  },
  LowerThird: {
    kind: "LowerThird.jsx",
    file: "LowerThird.jsx",
    summary:
      "Broadcast-style lower-third title strip (window.LowerThird) with EDITMODE-marked tweakable defaults — color, dimensions, type scale, tilt. Drop into any Stage.",
  },
});

const KIND_NAMES = Object.keys(STARTERS);
const KIND_LIST = Object.entries(STARTERS)
  .map(([k, v]) => `  • ${k} — ${v.summary}`)
  .join("\n");

/* ─── Server ────────────────────────────────────────────────── */

const server = new Server(
  { name: "starters", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "copy_starter",
      description:
        `Copy a starter component into the current project. Use this instead ` +
        `of hand-writing common scaffolds. The tool writes the file and ` +
        `returns its full content + project-relative path so you can edit ` +
        `or import it immediately.\n\n` +
        `Available starters:\n${KIND_LIST}\n\n` +
        `Each starter exposes its component on \`window\` (no imports), ` +
        `consistent with the project's CDN React + Babel-Standalone setup.`,
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: KIND_NAMES,
            description:
              "Which starter to copy. Names match the component (and the file we write — extension included).",
          },
          dest: {
            type: "string",
            description:
              "Optional project-relative subdirectory (e.g. 'frames/'). Defaults to project root.",
          },
        },
        required: ["kind"],
      },
    },
    {
      name: "list_starters",
      description:
        "Returns the catalog of available starters with one-line summaries. Useful when you want to scan options before committing.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "list_starters") {
    return textResult(
      Object.entries(STARTERS)
        .map(([k, v]) => `${k} (${v.file}) — ${v.summary}`)
        .join("\n"),
    );
  }

  if (name !== "copy_starter") throw new Error(`unknown tool: ${name}`);

  const kindKey = String(args?.kind ?? "");
  const starter = STARTERS[kindKey];
  if (!starter) {
    return errResult(
      `unknown kind "${kindKey}". Known: ${KIND_NAMES.join(", ")}`,
    );
  }

  const targetDir = process.env.STARTERS_TARGET_DIR || process.cwd();
  const subdir = String(args?.dest ?? "").replace(/^\/+|\/+$/g, "");
  // Reject any traversal beyond the target dir.
  if (subdir.includes("..")) {
    return errResult(`dest may not contain "..": ${subdir}`);
  }
  const outDir = subdir ? join(targetDir, subdir) : targetDir;
  const outPath = join(outDir, starter.file);

  // Refuse to clobber existing files — model should rename or pick a new dest.
  if (await exists(outPath)) {
    return errResult(
      `file already exists: ${relTo(targetDir, outPath)}. ` +
      `Pass a different \`dest\` to write a copy, or read the existing file with the Read tool.`,
    );
  }

  let content;
  try {
    content = await readFile(join(STARTERS_DIR, starter.file), "utf8");
  } catch (err) {
    return errResult(`failed to read template ${starter.file}: ${err?.message ?? String(err)}`);
  }

  try {
    await writeFile(outPath, content, "utf8");
  } catch (err) {
    return errResult(`failed to write ${outPath}: ${err?.message ?? String(err)}`);
  }

  const relPath = relTo(targetDir, outPath);
  return textResult(
    [
      `✓ Wrote ${relPath} (${content.length} bytes).`,
      ``,
      `--- ${relPath} ---`,
      content,
      `--- end ${relPath} ---`,
      ``,
      `Next: include it in your page with`,
      `<script type="text/babel" src="${relPath}"></script>`,
      `then use <${kindKey} /> in your render.`,
    ].join("\n"),
  );
});

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function relTo(base, p) {
  if (p.startsWith(base + "/")) return p.slice(base.length + 1);
  return p;
}

const transport = new StdioServerTransport();
await server.connect(transport);
