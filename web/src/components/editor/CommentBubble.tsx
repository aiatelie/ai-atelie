/* CommentBubble.tsx — anchored comment input.
 *
 * The bubble pins to a clicked element in the iframe. The user types a
 * note, optionally pastes/drops images, and saves. The bubble is now
 * SAVE-ONLY — promotion to chat happens from the comments panel via the
 * multi-select selection bar. The model picker is kept here as a
 * passive default for the saved comment's metadata; AI sending uses
 * the picker on the panel selection bar.
 */

import { useEffect, useRef, useState } from "react";
import s from "./comment.module.css";
import { ModelPicker, loadModelId, saveModelId, useModelPickerFlag } from "./ModelPicker";

export type CommentTarget = {
  /** Bubble anchor — canvas-local px (already iframe-rect-adjusted). */
  x: number;
  y: number;
  /** Pin anchor — iframe-local CSS px (zoom-invariant). Stored on save. */
  localX: number;
  localY: number;
  selector: string;
  tag: string;
  innerText?: string;
  outerHtml?: string;
  /** Rich, AI-friendly element profile — supersedes the bare selector
   *  in chat/comment prompts. */
  descriptor?: import("../../lib/cssPath").ElementDescriptor;
};

export type Attachment = {
  /** data:image/png;base64,... */
  dataUrl: string;
  name: string;
};

/** Submit mode — kept as a discriminated union for backwards-compat with
 *  the parent's onSubmit signature. The bubble itself only ever emits
 *  "save" now; the other variants stay in the type so the Editor's
 *  payload-building branch can still narrow on them if anything else
 *  ever sends them. */
/** Submit modes:
 *  - "save"          → just persist the comment as a pin (default)
 *  - "save-and-send" → persist AND queue it as a chat turn (the
 *                      comment becomes the user's next message; its
 *                      element thumbnail rides along as an attachment)
 *  - "reply" / "new-thread" — kept on the type for backwards compat
 *                      with older multi-select flows; not emitted from
 *                      this bubble anymore. */
export type CommentSubmitMode = "save" | "save-and-send" | "reply" | "new-thread";

type Props = {
  target: CommentTarget;
  /** Kept for prop compatibility — unused now that the bubble has no
   *  Ask-AI button. The panel decides where to send. */
  hasActiveThread?: boolean;
  onCancel: () => void;
  onSubmit: (text: string, options: { mode: CommentSubmitMode; attachments: Attachment[]; modelId: string }) => void;
};

export function CommentBubble({ target, onCancel, onSubmit }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const showModelPicker = useModelPickerFlag();
  const [modelId, setModelId] = useState<string>(loadModelId);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => { saveModelId(modelId); }, [modelId]);

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const next = await Promise.all(
      list.map(
        (f) =>
          new Promise<Attachment>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve({ dataUrl: r.result as string, name: f.name || "pasted.png" });
            r.onerror = () => reject(r.error);
            r.readAsDataURL(f);
          })
      )
    );
    setAttachments((prev) => [...prev, ...next]);
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items).filter((it) => it.type.startsWith("image/"));
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map((it) => it.getAsFile()).filter((f): f is File => f != null);
    if (files.length) await addFiles(files);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) await addFiles(e.dataTransfer.files);
  };

  const submit = (mode: CommentSubmitMode = "save") => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t, { mode, attachments, modelId });
  };

  return (
    <div
      className={`${s.bubble} ${dragOver ? s.bubbleDrag : ""}`}
      style={{ left: target.x, top: target.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className={s.bubbleHead}>
        <span className={s.dot} />
        <span className={s.tag}>&lt;{target.tag}&gt;</span>
        <button className={s.x} onClick={onCancel} aria-label="Cancel">×</button>
      </div>

      <textarea
        ref={inputRef}
        className={s.field}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            // Cmd+Shift+Enter = save + send to chat. Plain Cmd+Enter
            // stays save-only (matches the placeholder hint).
            submit(e.shiftKey ? "save-and-send" : "save");
          }
        }}
        placeholder="Leave a note here…  ⌘V to attach an image, ⌘↵ save, ⌘⇧↵ send"
      />

      {attachments.length > 0 && (
        <div className={s.attaches}>
          {attachments.map((a, i) => (
            <div key={i} className={s.attachItem}>
              <img src={a.dataUrl} alt={a.name} />
              <button
                className={s.attachRemove}
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove"
              >×</button>
            </div>
          ))}
        </div>
      )}

      <div className={s.bubbleFoot}>
        {showModelPicker ? (
          <div className={s.modelPickerWrap}>
            <ModelPicker value={modelId} onChange={setModelId} />
          </div>
        ) : (
          <span className={s.hint}>⌘↵ save · ⌘⇧↵ send</span>
        )}
        <div className={s.actions}>
          <button
            className={s.saveSecondary}
            onClick={() => submit("save")}
            disabled={!text.trim()}
            title="Save as a comment on this element (⌘↵). Use the comments panel later to send to AI."
          >
            Save
          </button>
          <button
            className={s.send}
            onClick={() => submit("save-and-send")}
            disabled={!text.trim()}
            title="Save the comment AND queue it as a chat message right now (⌘⇧↵)."
          >
            Send to chat
          </button>
        </div>
      </div>
    </div>
  );
}
