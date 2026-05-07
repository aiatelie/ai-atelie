import s from "./feedback.module.css";
import type { ReactNode } from "react";

export type EmptyStateSize = "sm" | "md" | "lg";

export type EmptyStateProps = {
  /** Optional decorative glyph rendered above the title. */
  icon?: ReactNode;
  title: string;
  /** Optional body copy. Plain string or rich content; keep it short. */
  body?: ReactNode;
  /** Optional inline action (button, link, anchor). */
  action?: ReactNode;
  /** Spacing scale. `sm` for tight panels, `lg` for full-page states. */
  size?: EmptyStateSize;
  className?: string;
};

const SIZE_CLASS: Record<EmptyStateSize, string> = {
  sm: s.emptyStateSm,
  md: s.emptyStateMd,
  lg: s.emptyStateLg,
};

export function EmptyState({
  icon,
  title,
  body,
  action,
  size = "md",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={`${s.emptyState} ${SIZE_CLASS[size]}${className ? ` ${className}` : ""}`}
      role="status"
    >
      {icon && (
        <span className={s.emptyStateIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <div className={s.emptyStateTitle}>{title}</div>
      {body && <div className={s.emptyStateBody}>{body}</div>}
      {action && <div className={s.emptyStateAction}>{action}</div>}
    </div>
  );
}
