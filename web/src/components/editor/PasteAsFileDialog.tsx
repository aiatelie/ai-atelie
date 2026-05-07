/* PasteAsFileDialog.tsx — modal for dropping pasted text/markdown
 * into the project as a fresh file. Keeps the user from having to
 * round-trip through the chat agent for one-off snippets.
 *
 * The dialog auto-detects an extension as the user types so the
 * filename stays sensible without manual picking, but the field stays
 * editable in case the heuristic gets it wrong. */

import { useEffect, useRef, useState } from "react";
import s from "./pasteAsFileDialog.module.css";
import { detectFileExtension, suggestPasteFilename } from "./detectFileExtension";

export type PasteAsFileDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (filename: string, content: string) => void | Promise<void>;
};

export function PasteAsFileDialog({ open, onClose, onSubmit }: PasteAsFileDialogProps) {
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-suggest the filename whenever the content changes — but only
  // until the user has manually edited the name. Once they touch it,
  // we never overwrite their intent.
  useEffect(() => {
    if (touchedName) return;
    setFilename(content.trim() ? suggestPasteFilename(content) : "");
  }, [content, touchedName]);

  // Reset everything when the dialog re-opens.
  useEffect(() => {
    if (!open) return;
    setContent("");
    setFilename("");
    setTouchedName(false);
    setSubmitting(false);
    // Focus the textarea on next paint.
    queueMicrotask(() => textareaRef.current?.focus());
  }, [open]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmedContent = content.trim();
  const trimmedName = filename.trim();
  const canSave = trimmedContent.length > 0 && trimmedName.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSave) return;
    setSubmitting(true);
    try {
      await onSubmit(ensureExtension(trimmedName, content), content);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={s.backdrop} onMouseDown={onClose} role="presentation">
      <div
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-as-file-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={s.header}>
          <div className={s.title} id="paste-as-file-title">Paste as file</div>
          <button
            type="button"
            className={s.close}
            onClick={onClose}
            aria-label="Close paste-as-file dialog"
          >
            ×
          </button>
        </div>
        <div className={s.body}>
          <label className={s.field}>
            <span className={s.label}>Filename</span>
            <input
              type="text"
              className={s.input}
              value={filename}
              onChange={(e) => { setFilename(e.target.value); setTouchedName(true); }}
              placeholder="paste-2605070348.txt"
              spellCheck={false}
            />
          </label>
          <label className={`${s.field} ${s.fieldGrow}`}>
            <span className={s.label}>Content</span>
            <textarea
              ref={textareaRef}
              className={s.textarea}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="Paste text, markdown, JSON, HTML…"
              spellCheck={false}
            />
          </label>
        </div>
        <div className={s.footer}>
          <span className={s.hint}>
            <kbd className={s.kbd}>⌘/Ctrl</kbd>+<kbd className={s.kbd}>Enter</kbd> to save
          </span>
          <div className={s.actions}>
            <button type="button" className={s.btnGhost} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={s.btnPrimary}
              disabled={!canSave}
              onClick={handleSubmit}
            >
              {submitting ? "Saving…" : "Save file"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** If the user-provided filename has no extension, append one
 *  detected from the content. Preserves an explicit user-typed
 *  extension verbatim. */
function ensureExtension(name: string, content: string): string {
  if (/\.[A-Za-z0-9]+$/.test(name)) return name;
  return `${name}.${detectFileExtension(content)}`;
}
