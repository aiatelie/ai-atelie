/* ImageLightbox.tsx — portal'd full-screen image preview.
 *
 * Used by chat bubbles so a small thumbnail can be tapped to see the
 * full image (especially the Draw composite, where strokes are tiny
 * at thumbnail size). Dismiss on Esc, backdrop click, or close button.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import s from "./imageLightbox.module.css";

type Props = {
  src: string;
  alt?: string;
  onClose: () => void;
};

export function ImageLightbox({ src, alt, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Prevent body scroll while open. Restore on unmount.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div className={s.backdrop} role="dialog" aria-modal="true" onClick={onClose}>
      <button
        type="button"
        className={s.closeBtn}
        onClick={onClose}
        aria-label="Close"
        title="Close (Esc)"
      >
        ×
      </button>
      <img
        className={s.img}
        src={src}
        alt={alt ?? ""}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
