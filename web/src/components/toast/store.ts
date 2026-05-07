/* Toast store — a tiny pub-sub keyed by id, used by ToastRegion + the
 * `toast` shorthand. Lives outside React so any module (route, lib,
 * fetch helper) can fire one without prop-drilling a context.
 *
 * Tones map to brand tokens; `assertive` aria-live is reserved for
 * errors. Callers can pass `durationMs: 0` for sticky toasts that only
 * dismiss on user action. */

export type ToastTone = "info" | "success" | "warn" | "error";

export type ToastInit = {
  message: string;
  tone?: ToastTone;
  /** Auto-dismiss after this many ms. 0 means stick until dismissed. */
  durationMs?: number;
  /** Optional inline action (e.g. "Try again", "Undo"). */
  actionLabel?: string;
  onAction?: () => void;
};

export type Toast = ToastInit & {
  id: string;
  tone: ToastTone;
  durationMs: number;
};

type Listener = (toasts: Toast[]) => void;

const DEFAULT_DURATION_MS = 4000;

let nextId = 0;
const listeners = new Set<Listener>();
let toasts: Toast[] = [];

function emit() {
  for (const l of listeners) l(toasts);
}

export function pushToast(init: ToastInit): string {
  const id = `t-${++nextId}`;
  const t: Toast = {
    id,
    message: init.message,
    tone: init.tone ?? "info",
    durationMs: init.durationMs ?? DEFAULT_DURATION_MS,
    actionLabel: init.actionLabel,
    onAction: init.onAction,
  };
  toasts = [...toasts, t];
  emit();
  return id;
}

export function dismissToast(id: string): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function clearToasts(): void {
  if (toasts.length === 0) return;
  toasts = [];
  emit();
}

export function getToasts(): Toast[] {
  return toasts;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shorthand: `toast.error("Export failed", { actionLabel: "Try again", onAction })` */
export const toast = {
  info: (message: string, opts?: Omit<ToastInit, "message" | "tone">) =>
    pushToast({ ...opts, message, tone: "info" }),
  success: (message: string, opts?: Omit<ToastInit, "message" | "tone">) =>
    pushToast({ ...opts, message, tone: "success" }),
  warn: (message: string, opts?: Omit<ToastInit, "message" | "tone">) =>
    pushToast({ ...opts, message, tone: "warn" }),
  error: (message: string, opts?: Omit<ToastInit, "message" | "tone">) =>
    pushToast({ ...opts, message, tone: "error" }),
};

/* Test-only helper. */
export function __resetForTests(): void {
  toasts = [];
  nextId = 0;
  listeners.clear();
}
