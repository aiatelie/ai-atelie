import { useEffect, useRef, useState } from "react";
import s from "./toast.module.css";
import { dismissToast, getToasts, subscribe, type Toast } from "./store";

const TONE_CLASS: Record<Toast["tone"], string> = {
  info: s.toastInfo,
  success: s.toastSuccess,
  warn: s.toastWarn,
  error: s.toastError,
};

export function ToastRegion() {
  const [items, setItems] = useState<Toast[]>(() => getToasts());
  useEffect(() => subscribe(setItems), []);

  return (
    <div
      className={s.region}
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {items.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (toast.durationMs <= 0) return;
    timer.current = setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast.id, toast.durationMs]);

  const handleAction = () => {
    toast.onAction?.();
    dismissToast(toast.id);
  };

  return (
    <div
      className={`${s.toast} ${TONE_CLASS[toast.tone]}`}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
    >
      <span className={s.accent} aria-hidden="true" />
      <div className={s.body}>
        <span className={s.message}>{toast.message}</span>
        {toast.actionLabel && toast.onAction && (
          <div className={s.actionRow}>
            <button type="button" className={s.action} onClick={handleAction}>
              {toast.actionLabel}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className={s.close}
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss notification"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
