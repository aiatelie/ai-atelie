---
name: send-to-canva
display: Send to Canva
description: Export as an editable Canva design
body_status: stub
sources: []
---

# Send to Canva

> ⚠️ **STUB** — this is a working theory of the skill body. The supporting tool `get_public_file_url` returns a short-lived (~1h) public URL for project files, useful when an external service (e.g. Canva import) needs to fetch a project file by URL.

## What it does

Hands the current design off to Canva as an editable design.

## Working theory of the body (to be replaced)

1. Identify the target HTML file (deck or design).
2. Get a public URL: `get_public_file_url({ project_relative_file_path })`.
3. Construct/open a Canva import URL pointing at it (the actual import endpoint is Canva-side; needs verification).
4. Show the user a download/open card.

## TODO

- Replace with the real skill body once captured.
- Confirm exactly which Canva endpoint Anthropic targets and whether it's a direct redirect or an OAuth flow.
