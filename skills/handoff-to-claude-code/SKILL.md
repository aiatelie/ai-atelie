---
name: handoff-to-claude-code
display: Handoff to Claude Code
description: Developer handoff package
body_status: stub
sources: []
---

# Handoff to Claude Code

> ⚠️ **STUB** — this is a working theory of the skill body. Replace as the implementation is refined.

## What it does

Packages the current design + all its supporting files into a bundle a developer can drop into Claude Code (or any IDE/agent) to implement against.

## Working theory of the body (to be replaced)

1. Inventory: which HTML files, components, tokens, and assets are part of the deliverable.
2. Generate a `HANDOFF.md` at the project root summarizing:
   - Scope of the design
   - Tokens / variables in use
   - Component file map
   - Known TODOs and open questions
   - Suggested implementation order
3. Optionally produce a CLAUDE.md tuned for the consuming agent (Claude Code) with project-specific conventions.
4. Call `present_fs_item_for_download` to give the user the bundle as a zip.

## TODO

- Replace with the real skill body once captured.
