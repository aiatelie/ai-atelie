# playwright-tools

Headless-Chromium scripts spawned by the API server for element-scoped
export work. Each script reads JSON args from stdin, writes its output
to a temp file (or temp dir for video frames), and prints **one JSON
line on stdout** that the API parses.

## Scripts

| Script | Spawned by | Purpose |
| --- | --- | --- |
| `export-element.mjs` | `api/src/services/exportRender.ts` | Screenshot a single element as PNG/JPEG. |
| `record-element.mjs` | `api/src/services/exportVideo.ts` | Capture N PNG frames of an element at a given fps for video encode. |
| `extract-element-html.mjs` | `api/src/services/exportOgraf.ts` | Grab outerHTML + every stylesheet + referenced asset URLs for an OGraf bundle. |

The wire format (input fields, output JSON shape) is defined verbatim
by those three consumer files. Don't change shapes here without
updating both ends.

## First-time setup

This directory has its own `package.json` so Playwright + its Chromium
binary live next to the scripts, not in the API or web `node_modules`.
Run once after `git clone`:

```sh
cd playwright-tools
bun install            # or npm install
npx playwright install chromium
```

For video export (`record-element.mjs`'s caller, `exportVideo.ts`)
ffmpeg must also be on PATH:

```sh
brew install ffmpeg     # macOS
# or your platform's package manager
```

The ffmpeg probe lives in `exportVideo.ts:79–87` — a missing binary
shows a clear "ffmpeg not found on PATH" error in the chat instead of
a cryptic spawn failure.

## Why a separate directory

- **No 150 MB Chromium in the API's node_modules.** Playwright's
  driver alone is multiple hundreds of MB; bundling it into `api/`
  would slow every `bun install` for unrelated work.
- **Process isolation.** Each invocation spawns a fresh Chromium so a
  Vite hot-reload of the API never orphans a browser process. The
  spawned Node child reads stdin, runs Playwright, writes the output,
  and exits.
- **Easy local debugging.** You can pipe a JSON arg to a script
  directly without booting the API server (see "Manual smoke tests"
  below).

## Manual smoke tests

```sh
# 1. Screenshot an element.
echo '{"url":"https://example.com","selector":"h1","format":"png"}' \
  | node export-element.mjs
# → {"ok":true,"path":"/tmp/cc-export/export-<uuid>.png","bytes":<n>}

# 2. Record an animated element. Use a local file so the auto-detect
#    path is exercised without hitting the network.
cat > /tmp/test-anim.html <<'HTML'
<!doctype html><style>
@keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
#x { width:100px; height:100px; background:#08f; animation: spin 2s linear 1; }
</style><div id="x"></div>
HTML
echo '{"url":"file:///tmp/test-anim.html","selector":"#x","duration":"auto","fps":30}' \
  | node record-element.mjs
# → {"ok":true,"dir":"/tmp/cc-record-<uuid>","framePattern":"frame_%04d.png","count":60,...}

# 3. Extract the outerHTML + CSS + assets of an element.
echo '{"url":"https://example.com","selector":"div"}' \
  | node extract-element-html.mjs | jq '{ok, htmlLen: (.html|length), assetCount: (.assets|length)}'
# → {"ok":true,"htmlLen":<n>,"assetCount":0}
```

## Troubleshooting

- **`Browser executable not installed`** → run `npx playwright install
  chromium` inside this directory.
- **`ffmpeg not found on PATH`** → only blocks video export; image and
  ograf paths still work.
- **Script hangs forever** → the consumer files set a default
  `timeoutMs` of 30–60 s. Pass a smaller value when probing.
- **`Unterminated string in JSON`** in the API log → you've edited a
  script and removed the `process.stdout.write(..., () => process.exit(0))`
  callback pattern. `process.exit` does NOT wait for stdout to drain;
  >8 KB payloads get truncated. Always pass the exit-on-flush callback.
