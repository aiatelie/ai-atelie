import s from "./feedback.module.css";
import type { ReactNode } from "react";

export type EmptyStateSize = "sm" | "md" | "lg";

export type EmptyStateTone = "default" | "error";

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
  /** Visual + a11y tone. `error` flips the container to role="alert". */
  tone?: EmptyStateTone;
  /** When true, wraps the state in a card frame (surface + border + shadow). */
  framed?: boolean;
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
  tone = "default",
  framed = false,
  className,
}: EmptyStateProps) {
  const classes = [s.emptyState, SIZE_CLASS[size]];
  if (tone === "error") classes.push(s.emptyStateError);
  if (framed) classes.push(s.emptyStateFramed);
  if (className) classes.push(className);
  return (
    <div
      className={classes.join(" ")}
      role={tone === "error" ? "alert" : "status"}
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
