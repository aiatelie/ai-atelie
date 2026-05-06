# mcp/

Local MCP servers spawned by the editor's dev server (api/src/routes/commentEdit.ts) and handed to the Claude Code Agent SDK + Kimi CLI.

## Servers

- **`ask-user-server.mjs`** — exposes `ask_user`. The model calls it to get structured input from the user mid-turn, using the `questions_v2`-style schema common in design-tool agents. Sends MCP `elicitation/create` up to the host; the host's `onElicitation` callback in `commentEdit.ts` bridges to the editor's chat sidebar over SSE.
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
