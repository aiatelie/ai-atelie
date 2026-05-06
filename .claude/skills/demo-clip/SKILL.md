---
name: demo-clip
description: Turn a raw Playwright recording (or any screen capture MP4/WebM) into a polished Screen-Studio-style demo video — gradient backdrop, dead-time trim, smooth motion-zooms on click events. Use when the user asks for "a demo video", "screen-studio style clip", "polish this recording", "marketing-quality cut of the verify-with-playwright video", or before publishing PR evidence to social. Free open-source path; no Steel.dev / no SaaS signup. Local Remotion render.
---

# demo-clip

A contributor workflow for AI Atelie. Composes the existing `verify-with-playwright` capture with [Remotion](https://www.remotion.dev) to produce a polished MP4 — the kind people post on Twitter / LinkedIn — without paying for Screen Studio or Steel.dev.

This skill is **dev-time only**. It does not load into adapter sessions spawned by the editor.

## When to invoke

- User asks "make me a demo video / screen-studio clip / marketing cut".
- After a `verify-with-playwright` run, when the raw `.evidence/<run>/video.webm` is good content but raw — needs framing, dead-time trimming, motion zooms.
- Before posting PR evidence to a public surface (Twitter, LinkedIn, blog).

Skip when:

- The user just needs "PR evidence" — `verify-with-playwright`'s raw webm is already enough for reviewer eyes; don't gold-plate.
- There's no source footage yet. STOP and tell the user to run `verify-with-playwright` first.

## Hard preconditions

1. **Source footage exists.** Default expectation: `.evidence/<latest>/video.webm` from a recent `verify-with-playwright` run, OR an MP4 path the user supplies. STOP if neither is present.
2. **Remotion installed.** `bunx remotion --version` should succeed. If not, run `bun install` from repo root — `remotion`, `@remotion/cli`, `@remotion/bundler`, `@remotion/renderer` are tracked devDependencies.
3. **`ffmpeg` available.** `which ffmpeg` must succeed. macOS: `brew install ffmpeg`. STOP and tell the user if missing — Remotion shells out to ffmpeg for the final encode.
4. **Node 18+.** `node --version` must be `>= v18`. The repo's `.nvmrc` (if any) wins.
5. **The `remotion-best-practices` skill is loaded** alongside this one. It ships the domain rules (composition layout, `useCurrentFrame`, `interpolate`, `Easing` patterns) Claude needs to actually author the composition. If you see references to `<Img>`, `staticFile()`, or `useVideoConfig()` and don't recognise them, STOP and tell the user to load `.claude/skills/remotion-best-practices/SKILL.md` first.

## Workflow (paste this checklist into your reply and tick as you go)

- [ ] **Preflight passed** (footage exists; Remotion + ffmpeg available; remotion-best-practices loaded).
- [ ] **Source footage normalised.** Convert to MP4 if it's webm: `ffmpeg -i .evidence/<run>/video.webm -c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -movflags +faststart -y tools/demo-clip/public/source.mp4`.
- [ ] **(Optional) `moments.json` ingested.** If `verify-with-playwright` produced a `moments.json` (timestamps of clicks / scrolls / scene changes), copy it into `tools/demo-clip/public/moments.json` and reference it from the composition for motion zooms. If absent, skip — fall back to a fixed gentle Ken-Burns push-in.
- [ ] **Composition authored** at `tools/demo-clip/src/Demo.tsx`. Required visual layers, in z-order:
    1. Gradient backdrop (`#1e1b4b → #4338ca` or repo brand colours from `web/src/styles`).
    2. Rounded-corner browser-window frame (border-radius 16px, subtle box-shadow) with a `<Video>` from `@remotion/media` showing the source footage scaled to fit.
    3. Motion zooms triggered at click moments — `interpolate(frame, [click-2, click+8, click+30], [1, 1.4, 1.0], { easing: Easing.bezier(0.16,1,0.3,1) })`.
    4. Trim dead time: render a `<Sequence>` per active span; skip frames where nothing visibly changes (use `moments.json` or eyeball the source).
- [ ] **Composition registered** in `tools/demo-clip/src/Root.tsx` next to `HelloWorld`. Pick fps=30, durationInFrames sized to the trimmed timeline, width 1920, height 1080.
- [ ] **Render.** From the repo root: `cd tools/demo-clip && bunx remotion render src/index.ts Demo /tmp/demo-<slug>.mp4`. Expect 30s–3min depending on length.
- [ ] **Verify the output.** `ffprobe /tmp/demo-<slug>.mp4` — duration, codec, dimensions match expectations. Open in Quicktime / `open` and watch end-to-end.
- [ ] **Hand off the path.** Output the absolute MP4 path so the user (or `ship-task`) can attach it to a PR / tweet / blog.

## Authoring the composition

Use `remotion-best-practices` as the source of truth for syntax. The shape this skill expects:

```tsx
// tools/demo-clip/src/Demo.tsx
import {
  AbsoluteFill,
  Easing,
  Sequence,
  Video,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Moment = { t: number; kind: "click" | "scroll" | "scene" };

export const Demo: React.FC<{ moments: Moment[] }> = ({ moments }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Most recent click → drive a zoom curve.
  const lastClickFrame = moments
    .filter((m) => m.kind === "click")
    .map((m) => Math.round(m.t * fps))
    .filter((f) => f <= frame)
    .at(-1);

  const zoom =
    lastClickFrame == null
      ? 1
      : interpolate(
          frame,
          [lastClickFrame - 2, lastClickFrame + 8, lastClickFrame + 30],
          [1, 1.4, 1.0],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }
        );

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)",
      }}
    >
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${zoom})`,
        }}
      >
        <div
          style={{
            width: width * 0.85,
            height: height * 0.85,
            borderRadius: 16,
            overflow: "hidden",
            boxShadow: "0 30px 80px rgba(0,0,0,0.4)",
          }}
        >
          <Video src={staticFile("source.mp4")} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
```

`Demo` is parameterised on `moments` so you can wire `calculateMetadata` to read `public/moments.json` once at compile time — see `remotion-best-practices/rules/calculate-metadata.md` for the pattern.

## Known failure modes

- **Source webm has VP9 → Remotion can't seek cleanly.** Always transcode to H.264 MP4 first (the preflight step does this).
- **`<Video>` showing only the first frame.** You forgot to register `staticFile()` — assets must live under `tools/demo-clip/public/`, NOT inside `src/`.
- **Render hangs at "Bundling"** — usually missing `react`/`react-dom` peer deps. They're in root `devDependencies`; `bun install` from root should resolve.
- **Output is choppy.** Increase `--concurrency` (default 1 in `remotion.config.ts` for predictability; bump to 4 for faster renders if your machine has cores to spare).
- **Headless Chrome download fails behind a proxy.** Set `PUPPETEER_SKIP_DOWNLOAD=true` then point Remotion at a local Chrome via `--browser-executable=/path/to/Chrome`.

## Anti-patterns the skill must refuse

- **Uploading the demo to a paid SaaS** ("just push it to Steel.dev / Screen Studio Pro"). The whole point of this skill is the free local pipeline. If the user asks for SaaS upload, redirect to the local render path and explain why.
- **Baking sensitive data into the demo.** If the source footage shows API keys, `.env` contents, real user data, or auth tokens — STOP, tell the user, ask them to redact at the source (re-record) before composing.
- **Skipping the `verify-with-playwright` step** to "just record manually with QuickTime". The point is the entire flow is reproducible from the same harness reviewers already trust. A hand-recorded MP4 with no spec behind it is marketing fiction, not evidence.
- **Adding music / voiceover unprompted.** Demo clips for PRs should be silent; add audio only if the user explicitly asks. Audio adds licensing surface (royalty-free? attribution required?) we don't want by default.
- **Editing `verify-with-playwright`'s spec to fit a "better camera angle".** That spec is the truth; the demo clip is the marketing edit. If you find yourself wanting to alter the underlying test, you've crossed a line — STOP.

## Reporting back

```
DEMO-CLIP-RESULT: pass | fail
SOURCE: .evidence/<run>/video.webm
OUTPUT: /tmp/demo-<slug>.mp4 (<duration>s, <size>MB, 1920x1080)
NOTES:
  - <any moment.json clicks honoured>
  - <any manual fallbacks the skill made>
```

## See also

- `.claude/skills/verify-with-playwright/SKILL.md` — produces the source footage this skill consumes.
- `.claude/skills/remotion-best-practices/SKILL.md` — domain rules for Remotion composition syntax. Source-of-truth for `useCurrentFrame`, `interpolate`, `Easing`, `Sequence`, asset loading.
- `tools/demo-clip/` — the workspace this skill renders from. Contains a `HelloWorld` composition kept around as a smoke-test target for the toolchain.
- [Remotion docs](https://www.remotion.dev/docs/) — license is free for solo and orgs ≤3 employees; AI Atelie qualifies.
