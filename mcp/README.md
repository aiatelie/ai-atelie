# mcp/ — **product-runtime MCP servers**

Local MCP servers spawned by the editor's dev server (`api/src/services/claude.ts`, `kimi.ts`) and handed to the agent CLI as the `mcpServers` block. They expose tool calls (e.g. structured user input, file copies) to the model during end-user editor sessions.

> **Looking for contributor workflows?** Those live at `.claude/skills/` (markdown playbooks, not tool servers). The split is documented in `CONTRIBUTING.md#where-does-my-contribution-belong-decision-matrix`.

## Servers

- **`ask-user-server.mjs`** — exposes `ask_user`. The model calls it with a BATCHED set of questions (`{ title, questions: [...] }`); the user fills one form and the agent proceeds with full context. Each enum question auto-gets `Decide for me` / `Explore a few` / `Other` (with inline free-text) appended server-side. Sends MCP `elicitation/create` up to the host; the host's `onElicitation` callback in `commentEdit.ts` bridges to the editor's chat sidebar over SSE. The HTTP twin (`ask-user-http-server.mjs`) shares the same shape via `buildBatchedSchema`.
- **`starters-server.mjs`** — exposes `copy_starter` and `list_starters`. Drops ready-made overlay scaffolds (`Stage16x9.jsx`, `Stage9x16.jsx`, `LowerThird.jsx`) into the active project directory using a `copy_starter_component`-style mechanism. Templates live in `./starters/`. The server reads `STARTERS_TARGET_DIR` from its env to know which project dir to write into; `commentEdit.ts` sets it per-spawn from the active `projectId`.

## Test the server standalone

From the repo root:

```sh
node mcp/ask-user-server.mjs <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

You should see an InitializeResult with the server's name + capabilities.

## Wiring

The web dev server (`api/src/routes/commentEdit.ts`) loads this via the SDK:

```ts
mcpServers: {
  "ask-user": {
    type: "stdio",
    command: "node",
    args: ["<repo>/mcp/ask-user-server.mjs"],
  },
}
```

Tool name as seen by the model: `mcp__ask-user__ask_user`.

## Adding a new MCP server

The repo treats MCP servers as flat `.mjs` files in this folder, NOT subfolders. Each server is one Node script speaking JSON-RPC over stdio per the MCP spec.

1. **Author the server** — `mcp/<your-server>.mjs`. Implement at minimum the `initialize`, `tools/list`, and `tools/call` methods. The two existing servers are good references; `ask-user-server.mjs` shows the elicitation bridge pattern, `starters-server.mjs` shows the file-write pattern using `STARTERS_TARGET_DIR` from env.
2. **Smoke-test the server standalone** — pipe an `initialize` request via the `node mcp/<your-server>.mjs <<< '...'` recipe above. You should see an `InitializeResult` with the server's tool schema.
3. **Wire it into the adapter spawn** — in `api/src/services/claude.ts` (and `api/src/services/kimi.ts` if it should be available there too), add an entry to the `mcpServers` block:
   ```ts
   mcpServers: {
     "ask-user": { type: "stdio", ...ASK_USER_STDIO() },
     "starters": { type: "stdio", ...STARTERS(rootDir) },
     "<your-server>": {
       type: "stdio",
       command: "node",
       args: [path.join(MCP_DIR, "<your-server>.mjs")],
       env: { /* per-spawn env, e.g. project dir */ },
     },
   }
   ```
   The adapter passes any per-spawn env (project id, repo paths) to the server's process here.
4. **Update the disallowedTools list** if your server exposes any tool name that shadows a built-in Claude Code tool you want to keep — the model will see your tool as `mcp__<server>__<tool_name>`.
5. **Add a row to the table at the top of this README** with the server name, tool names, and a one-line "what it does."
6. **PR with a one-line description** of why the new tool is worth a roundtrip — the bar for adding tools is "the model genuinely couldn't accomplish this without it."

## Where this should NOT go

- **End-user-facing playbook (markdown only, no tool calls)** → `skills/`, not here. Skills are loaded as text, not spawned as servers.
- **Contributor workflow** ("when I'm working on the repo, do X") → `.claude/skills/`, not here.
- **One-off CLI helper** (release scripts, evidence upload) → `scripts/`, not here.

## Why two READMEs (this one + skills/)

`skills/` and `mcp/` look similar but serve different audiences:

- `skills/` ships **playbooks** — pure markdown text that conditions the model on a task ("when asked to design a banner, follow this approach…").
- `mcp/` ships **tools** — RPC servers the model can *call* during a turn to read/write external state ("show the user a form," "copy a starter file into this project").

A skill that needs to do something the model can't already do alone usually wants both: a SKILL.md describing the workflow, and an MCP tool that the skill instructs the model to call.
