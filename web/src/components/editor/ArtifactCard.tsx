/* ArtifactCard.tsx — inline preview of an export artifact in the chat.
 *
 * The capability runners (api/src/services/capabilities.ts → /api/export-*)
 * persist every export to web/projects/<id>/exports/ and return a small
 * JSON envelope { ok, kind, filename, url, mime, bytes, metadata }. The
 * generic MCP adapter forwards that JSON verbatim to the AI as tool
 * result text. The chat detects artifact-shaped results and renders an
 * ArtifactCard instead of a plain code dump — which means:
 *
 *   - The user sees the artifact rendered (image preview, video player,
 *     icon for archives) without expanding anything.
 *   - The AI's text reply can be a single sentence ("Saved as
 *     papo-de-montanha-4k.mp4") because the visual artefact is the
 *     result, not the prose.
 *   - Download / Preview / Discuss buttons let the user act without
 *     leaving the conversation.
 */

import { useEffect, useState } from "react";
import s from "./artifactCard.module.css";

/** lottie-player is a Web Component loaded from a CDN. It's idempotent —
 *  loading the script twice is fine (custom-element registration short-
 *  circuits). AssetsDialog already loads it; we re-do it here so an
 *  ArtifactCard rendered before AssetsDialog has been opened still
 *  works. Mirrors AssetsDialog.tsx:166. */
const LOTTIE_PLAYER_SRC = "https://unpkg.com/@lottiefiles/lottie-player@2.0.8/dist/lottie-player.js";
let lottiePlayerLoading: Promise<void> | null = null;
function ensureLottiePlayer(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (customElements.get("lottie-player")) return Promise.resolve();
  if (lottiePlayerLoading) return lottiePlayerLoading;
  lottiePlayerLoading = new Promise<void>((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = LOTTIE_PLAYER_SRC;
    sc.async = true;
    sc.onload = () => resolve();
    sc.onerror = () => reject(new Error("Failed to load lottie-player"));
    document.head.appendChild(sc);
  });
  return lottiePlayerLoading;
}

export type Artifact = {
  ok: true;
  kind: "image" | "video" | "html-graphics" | "lottie" | "asset";
  filename: string;
  projectRelativePath?: string;
  url: string;
  mime: string;
  bytes: number;
  metadata?: Record<string, unknown>;
};

/** Best-effort parse of a tool-result string into an Artifact. Returns
 *  null if the JSON doesn't include the required envelope keys. Used by
 *  the chat bubble to decide whether to render an ArtifactCard or fall
 *  through to the existing ToolResultBlock. */
export function parseArtifact(text: string | undefined): Artifact | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      parsed.ok === true &&
      typeof parsed.kind === "string" &&
      typeof parsed.filename === "string" &&
      typeof parsed.url === "string" &&
      typeof parsed.mime === "string" &&
      typeof parsed.bytes === "number"
    ) {
      return parsed as Artifact;
    }
    return null;
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function metaLine(a: Artifact): string {
  const parts: string[] = [];
  // kind-derived label
  if (a.kind === "image") parts.push(a.mime === "image/jpeg" ? "JPEG" : "PNG");
  else if (a.kind === "video") parts.push("Video");
  else if (a.kind === "html-graphics") parts.push("OGraf");
  else if (a.kind === "lottie") parts.push("Lottie");
  else parts.push(a.mime.split("/").pop()?.toUpperCase() || "Asset");
  parts.push(formatBytes(a.bytes));
  const m = a.metadata ?? {};
  if (typeof m.width === "number" && typeof m.height === "number") {
    parts.push(`${m.width}×${m.height}`);
  }
  if (typeof m.scale === "number") parts.push(`${m.scale}×`);
  if (typeof m.duration === "number") parts.push(`${m.duration}s`);
  if (typeof m.fps === "number") parts.push(`${m.fps}fps`);
  return parts.join(" · ");
}

/** Trigger a browser download for `url`, naming the saved file `filename`.
 *  Same anchor-click pattern downloadDataUrl uses, but for a remote URL. */
function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type Props = {
  artifact: Artifact;
  /** Called when the user clicks "Discuss" — typically prefills the
   *  composer with a quote referencing this artifact. */
  onDiscuss?: (artifact: Artifact) => void;
};

export function ArtifactCard({ artifact, onDiscuss }: Props) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const isImage = artifact.kind === "image" || artifact.mime.startsWith("image/");
  // Browser-playable video MIME types (most NLEs / users will export H.264 MP4
  // for in-chat preview; ProRes 4444 .mov won't preview but downloads fine).
  const isPlayableVideo = artifact.kind === "video" && /^video\/(mp4|webm|ogg)$/.test(artifact.mime);
  const isLottie = artifact.kind === "lottie";
  // Lazily load the lottie-player CDN if this card needs it. Idempotent.
  useEffect(() => {
    if (isLottie) ensureLottiePlayer().catch(() => { /* fallback already shows file icon */ });
  }, [isLottie]);
  // Escape closes the lightbox.
  useEffect(() => {
    if (!previewOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPreviewOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [previewOpen]);

  return (
    <div className={s.card}>
      <div className={s.preview}>
        {isImage && (
          <img src={artifact.url} alt={artifact.filename} className={s.previewImg} />
        )}
        {isPlayableVideo && (
          <video
            src={artifact.url}
            controls
            preload="metadata"
            className={s.previewVideo}
          />
        )}
        {isLottie && (
          <div
            className={s.previewLottie}
            // lottie-player is a custom element; React types don't know it,
            // so inject via dangerouslySetInnerHTML (same trick AssetsDialog uses).
            dangerouslySetInnerHTML={{
              __html: `<lottie-player src="${artifact.url.replace(/"/g, "&quot;")}" autoplay loop background="transparent" style="width:100%;height:100%"></lottie-player>`,
            }}
          />
        )}
        {!isImage && !isPlayableVideo && !isLottie && (
          <div className={s.previewIcon}>
            <FileIcon kind={artifact.kind} />
          </div>
        )}
      </div>
      <div className={s.info}>
        <div className={s.filename} title={artifact.filename}>{artifact.filename}</div>
        <div className={s.meta}>{metaLine(artifact)}</div>
        <div className={s.actions}>
          <button
            type="button"
            className={s.btnPrimary}
            onClick={() => triggerDownload(artifact.url, artifact.filename)}
            title="Download to your computer"
          >
            <DownloadIcon /> Download
          </button>
          {(isImage || isPlayableVideo) && (
            <button
              type="button"
              className={s.btn}
              onClick={() => setPreviewOpen(true)}
              title="Open full preview"
            >
              <ExpandIcon /> Preview
            </button>
          )}
          {onDiscuss && (
            <button
              type="button"
              className={s.btn}
              onClick={() => onDiscuss(artifact)}
              title="Quote this in the composer to ask a follow-up"
            >
              <MessageIcon /> Discuss
            </button>
          )}
        </div>
      </div>
      {previewOpen && (
        <div
          className={s.lightbox}
          role="dialog"
          aria-modal="true"
          onClick={(e) => { if (e.target === e.currentTarget) setPreviewOpen(false); }}
        >
          <button
            type="button"
            className={s.lightboxClose}
            onClick={() => setPreviewOpen(false)}
            aria-label="Close preview"
          >×</button>
          {isImage && <img src={artifact.url} alt={artifact.filename} className={s.lightboxImg} />}
          {isPlayableVideo && (
            <video src={artifact.url} controls autoPlay className={s.lightboxVideo} />
          )}
        </div>
      )}
    </div>
  );
}

/* ─── tiny inline icons (no external dep) ────────────────────────── */

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2 V10" />
      <path d="M5 7 L8 10 L11 7" />
      <path d="M3 12 V13 H13 V12" />
    </svg>
  );
}
function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7 V3 H7" />
      <path d="M13 9 V13 H9" />
      <path d="M3 3 L7 7" />
      <path d="M13 13 L9 9" />
    </svg>
  );
}
function MessageIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4 H14 V11 H7 L4 14 V11 H2 Z" />
    </svg>
  );
}
function FileIcon({ kind }: { kind: Artifact["kind"] }) {
  // A single archive-ish icon used as a fallback for non-previewable kinds
  // (OGraf zip, ProRes .mov, asset blobs). Keeps the card visually balanced.
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4 H19 L25 10 V28 H7 Z" />
      <path d="M19 4 V10 H25" />
      <text x="16" y="22" fontSize="6" textAnchor="middle" fontFamily="ui-monospace, monospace" stroke="none" fill="currentColor">
        {kind === "html-graphics" ? "ZIP" : kind === "video" ? "MOV" : kind === "lottie" ? "JSON" : "FILE"}
      </text>
    </svg>
  );
}
