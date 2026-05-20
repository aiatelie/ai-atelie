---
name: export
display: Export
description: Export a selected element from the canvas as PNG, JPEG, OGraf bundle, Lottie, or video. Saves to the project's exports/ folder; the chat renders the result inline as an artifact card.
kind: capability
body_status: original
---

# Export

The user wants to take an element from the active design canvas and save it for use in another tool — usually a video editor (DaVinci Resolve, FCP, Premiere, CapCut), sometimes a presentation tool. Pick the right format, call the matching capability, **then write a single short sentence**.

## Critical: do not narrate file creation

The host renders an **ArtifactCard** inline in the chat for every successful export — thumbnail + filename + size + Download / Preview / Discuss buttons. You don't need to tell the user what you saved or where it landed; the card already shows that. Your reply is a *one-sentence header* explaining the choice, not a status report.

**Bad** — narrates what the user can already see:
> I've saved the cat banner as a PNG file at exports/cat-banner.png. The file is 2.3MB and 3840×2160 pixels with a transparent background. You can download it using the link.

**Good** — confirms intent + invites iteration:
> Cat banner as a 2× transparent PNG — should work straight on a Resolve overlay track.

**Better** — confirms + offers next step via `mcp__ask-user__ask_user`:
> Saved as a 2× transparent PNG. Want me to also drop a 4K version for hero use?
> *(then call ask_user with kind:"enum", options:["Yes, 4K too", "No, this is enough"])*

## Capabilities

These are the tools the host registry exposes. Whatever runtime you're in (MCP today, OpenAI tools later), the names and arg shapes are identical. They all return an artifact envelope:

```json
{ "ok": true, "kind": "image|video|html-graphics|lottie", "filename": "...", "url": "...", "mime": "...", "bytes": N, "metadata": { ... } }
```

- **`export_element`** — PNG or JPEG via real headless Chromium. Captures everything the browser actually renders (canvas, video, backdrop-filter, mix-blend-mode all work).
- **`export_ograf`** — `.ograf.zip` bundle for DaVinci Resolve 21+'s native HTML graphics import.

(More may be registered — check the tool list. Video / Lottie may have landed by the time you read this.)

## Required args (every export)

- `projectId` — the active project id
- `route` — project-relative path to the page (e.g. `02 Opening Title.html`)
- `selector` — CSS selector for the target element

The host typically tells you these in the conversation context. If the user says "export this" without a clearer reference, the host's `selected.selector` is the canonical "this" — confirm with the user if you're unsure rather than guessing.

## Naming

**Pick a semantic name.** The user will see it in the chat card and on disk. Generate from element role + intent:
- `img-cat-photo` — better than `export-001`
- `papo-de-montanha-thumbnail` — better than `div-banner-2x`
- `kdu-titling-resolve-template` — better than `graphic`

The server sanitizes (filesystem-safe chars only) and collision-suffixes (`-2`, `-3`) automatically. Don't include the extension.

## Format picker — short rubric

| User said… | Use |
|---|---|
| "PNG", "transparent image", "thumbnail" | `export_element` with `format: "png"`, `backgroundColor: "transparent"` |
| "JPEG", "smaller file", "for the web" | `export_element` with `format: "jpeg"`, optional `quality: 90` |
| "for DaVinci", "Resolve", "video editor" with **static** content | `export_element` PNG with alpha (drag straight onto upper video track) |
| "OGraf", "HTML graphics", "Resolve template" | `export_ograf` |
| "video", "MP4", "animated", "for a timeline" | `export_video`. Default `duration: "auto"` (matches the animation's natural length); pick a number only when the user explicitly asks for a specific length. FPS doesn't change animation speed — only smoothness — so 30 fps is the safe default. For Resolve overlays, prefer `backgroundColor: "transparent"` (ProRes 4444 with real alpha). |
| "4K", "8K", "high quality video" | `export_video` with `resolution` set + `quality: "high"` or `"master"`. Vector content stays sharp at 4K/8K because the browser re-rasterizes at higher DPI. |
| Ambiguous | Use `mcp__ask-user__ask_user` with `kind: "enum"` and options like `["PNG (transparent)", "JPEG (smaller)", "OGraf (Resolve 21+)"]` |

## OGraf export — always elicit first

`export_ograf` is not a one-shot call. An OGraf bundle can be an overlay or a
whole page, animated or static, with or without inspector-editable fields —
and the right choice changes every time. **Before calling `export_ograf`, run
a short `ask_user` elicitation.** Then pass the answers as args.

Ask (one `ask_user` call per decision, or batch where natural):

1. **Scope** — `kind:"enum"`, options `["Just this element (overlay)", "The whole page"]`
   → `scope: "element"` or `"page"`. Element = transparent frame, CSS
   shadow-scoped, sized to the element. Page = keeps the page background,
   sized to the captured root. For `page`, pass the page's root wrapper as
   `selector`, not `body`.
2. **Animation** — only if the element actually animates. `kind:"enum"`,
   options `["Keep it animated", "Freeze it (static)"]` → `animated: true|false`.
   Animated graphics stay seekable as Resolve scrubs the timeline.
3. **Editable props** — inspect the design, *propose* a concrete list, let the
   user confirm/trim. e.g. "I can make these editable in Resolve's inspector:
   **Headline text**, **Headline size**, **Headline font**, **Background
   color**, **Entrance duration** — want all of them?" Each confirmed prop
   becomes a `props[]` entry with a `key`, `label`, `type` (text/number/color),
   `control` (text/background/color/fontSize/fontFamily/opacity/duration) and a
   `target` CSS selector. **Default to offering BOTH `fontSize` AND
   `fontFamily` for every prominent text element** — the user wants to resize
   *and* re-pick the font inside Resolve. Resolve's OGraf renderer is Chromium,
   so a `fontFamily` value resolves against the OS's installed fonts — typing
   "Helvetica Neue" or "JetBrains Mono" in the Inspector switches to that
   system font live. Empty `props` = a baked graphic (nothing editable) — fine
   if the user doesn't need it.

What the exporter now guarantees (these were hard-won — don't second-guess
them): HTML/CSS/images are inlined (no runtime fetch — Resolve's sandbox
blocks it); CSS `@keyframes` are made seekable so they follow Resolve's
timeline; the graphic is sized by true layout pixels. Declared `props` show
up as real inspector controls and update live via the OGraf data API.

One Resolve-side gotcha to tell the user: the imported clip's **Composite
Mode must be Normal** (not Multiply) for a clean alpha overlay.

## Defaults

When the user doesn't specify:
- `format` → `png`
- `scale` → `2` (high-DPI; `4` for hero shots if the file size cost is acceptable)
- `backgroundColor` → `transparent` for PNG, omit for JPEG (which forces white)
- video `resolution` → `4K`, `quality` → `high` — this user works in 4K, so
  high quality is the baseline, not an opt-in. Only go smaller when the user
  explicitly asks for a lighter file.

## Feedback loop

After a successful export, when iteration is plausible, call `mcp__ask-user__ask_user`:

```
{
  "message": "How does this look?",
  "kind": "enum",
  "options": ["Looks good", "Try a different format", "Higher quality / 4K", "Adjust background"]
}
```

When the user picks one, route accordingly:
- "Looks good" → done, no further calls
- "Try a different format" → ask which, then re-call the right capability
- "Higher quality / 4K" → re-call `export_element` with `scale: 4`, or `export_video` with `resolution: "4K"`, `quality: "master"`
- "Adjust background" → re-call with `backgroundColor` flipped

**Don't ask after every export** — only when the result might genuinely need iteration (complex element, ambiguous request, hero shot). For simple "give me a PNG" calls, just confirm and stop.

## When NOT to use this skill

- The user wants to *modify* the design itself → that's the editor's normal flow, not export.
- The user wants to send the design to another tool with full editability (e.g. Canva) → that's a different capability if/when it's registered (not yet).
- The user already used the toolbar's Export button — don't re-export, just confirm what they got.

## Tips

- Don't burn tool calls inspecting the same element multiple times in a turn.
- For batch ("export all five thumbnails"), call the same capability once per element. Each result becomes its own ArtifactCard.
- File collisions are handled by the server (`-2`, `-3` suffix); don't add timestamps unless the user asked for one.
