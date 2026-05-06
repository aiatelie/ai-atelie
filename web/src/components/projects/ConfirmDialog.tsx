/* ConfirmDialog.tsx — themed replacement for window.confirm. Reuses
 * the dialog primitives from projects.module.css so it visually matches
 * NewProjectDialog. Defaults to a destructive (red) confirm button —
 * pass `tone="primary"` for non-destructive prompts.
 */

import { useEffect, useRef } from "react";
import s from "./projects.module.css";

type Props = {
  title: string;
  /** Body copy. Strings get rendered as a paragraph; pass JSX for richer
   *  layouts (e.g. a list of impacted items). */
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" → red confirm; "primary" → brand-coloured. Default "danger"
   *  because most callers are destructive (delete, discard, etc.). */
  tone?: "danger" | "primary";
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  tone = "danger",
  onCancel,
  onConfirm,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Autofocus the SAFE button so a stray Enter doesn't fire a destructive
  // action. Focus on mount; users who want the destructive path tab once.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className={s.dialogBackdrop} onClick={onCancel}>
      <div className={s.dialog} role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className={s.dialogTitle}>{title}</div>
        <div className={s.dialogBody}>{body}</div>
        <div className={s.dialogActions}>
          <button ref={cancelRef} className={s.dialogBtn} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`${s.dialogBtn} ${tone === "danger" ? s.dialogDanger : s.dialogPrimary}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
