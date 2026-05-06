/* TweaksPreviewDialog.tsx — show the prompt the Tweaks button is about to
 * send, let the user edit it, and confirm before AI rewrites files.
 */

import { useEffect, useState } from "react";
import s from "./assets.module.css";

type Props = {
  open: boolean;
  initialPrompt: string;
  onClose: () => void;
  onConfirm: (prompt: string) => void;
};

export function TweaksPreviewDialog({ open, initialPrompt, onClose, onConfirm }: Props) {
  const [prompt, setPrompt] = useState(initialPrompt);
  useEffect(() => { if (open) setPrompt(initialPrompt); }, [open, initialPrompt]);
  if (!open) return null;
  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.dialog} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className={s.head}>
          <b>Preview · ask AI</b>
          <span className={s.subhead}>Edit the prompt before sending. AI rewrites files on save.</span>
          <button className={s.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={s.body}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            style={{
              width: "100%",
              minHeight: 280,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              padding: 12,
              border: "1px solid var(--ink-10)",
              borderRadius: 8,
              background: "var(--surface)",
              color: "var(--ink-92)",
              resize: "vertical",
              outline: "none",
            }}
          />
        </div>
        <div className={s.foot} style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className={s.copyBtn} onClick={onClose}>Cancel</button>
          <button
            className={s.copyBtn}
            style={{ background: "var(--brand)", color: "var(--on-brand)", borderColor: "var(--brand-fg)" }}
            onClick={() => { onConfirm(prompt); }}
            disabled={!prompt.trim()}
          >
            Send to AI
          </button>
        </div>
      </div>
    </div>
  );
}
