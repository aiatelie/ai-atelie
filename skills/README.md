# skills/ — **product skills only**

Composable skill library — named playbooks an agent calls mid-conversation. Loaded into adapter-spawned sessions for end users via `ENV.SKILLS_DIR` (see `api/src/services/claude.ts`).

> **Looking for contributor workflows?** Those live at `.claude/skills/` and are not the same thing — see [`.claude/skills/README.md`](../.claude/skills/README.md). The split is documented in `CONTRIBUTING.md#where-does-my-contribution-belong-decision-matrix`.

## What this is

Each skill lives at `skills/<name>/SKILL.md` with a frontmatter header and a markdown body. The body is loaded into the model's context when the skill is invoked, so it acts like a focused mid-conversation system prompt for a specific task.

## Layout

```
skills/
  index.json                     # menu — name + description + body_status
  invoke_skill.mjs               # cross-model loader
  <skill-name>/
    SKILL.md                     # frontmatter + body
```

## body_status values

| Status | Meaning |
|---|---|
| `verbatim` | Body is a direct transcription. |
| `reconstructed` | Body is rebuilt from public sources. |
| `stub` | Body is a working theory + TODO marker. |
| `original` | Body was written from scratch for this project. |

## How each consumer uses these

### Claude Code (product runtime)

Adapters spawn `claude` with `additionalDirectories: [ENV.SKILLS_DIR, …]` so the product skills in this folder are loaded into the end-user session — independent of any `.claude/skills/` near the adapter cwd. See `api/src/services/claude.ts`.

### Kimi K2 / OpenAI / any other model

These don't have a native skills concept, so the harness needs to:

1. Expose `invoke_skill` as a tool. Use the schema in `invoke_skill.mjs`:
   ```js
   import { invokeSkillToolSchema, invokeSkill, buildSkillMenuText } from "./skills/invoke_skill.mjs";
   ```
2. Inject the skill menu into the system prompt:
   ```js
   const systemPrompt = baseSystemPrompt + "\n\n" + (await buildSkillMenuText());
   ```
3. When the model calls `invoke_skill({ name })`, return:
   ```js
   await invokeSkill(name);
   ```

## CLI

```sh
node skills/invoke_skill.mjs list           # JSON list of skills
node skills/invoke_skill.mjs menu           # printable menu (for system prompt)
node skills/invoke_skill.mjs get make-tweakable   # print one skill's body
```

## Adding a product skill

Drop a new `skills/<name>/SKILL.md` with frontmatter:

```yaml
---
name: my-skill
display: My skill
description: One-line trigger for the model.
body_status: original
sources: []
---
```

Note: this repo's product-skill frontmatter carries three non-standard fields beyond the canonical `name`/`description` (`display`, `body_status`, `sources`) that drive the menu UI. Standard Anthropic SKILL.md frontmatter is also accepted; the extras are additive. Dev-time skills under `.claude/skills/` use *only* the standard fields so they remain portable.

Then add the entry to `skills/index.json` so the menu picks it up. Open a PR.

## Where this should NOT go

- **Contributor workflows** ("when I'm working on the repo, do X") → `.claude/skills/`, not here. Auto-loads into your dev session, not into end-user sessions.
- **Tool calls** (file ops, web fetches, structured input) → `mcp/`, not here. Skills are pure markdown; tool calls require an MCP server.
- **One-off scripts** (releases, evidence upload, port probes) → `scripts/`, not here.
