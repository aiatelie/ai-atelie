import s from "./feedback.module.css";
import type { CSSProperties } from "react";

export type SpinnerProps = {
  size?: number;
  label?: string;
  className?: string;
  style?: CSSProperties;
};

export function Spinner({ size = 16, label, className, style }: SpinnerProps) {
  const merged: CSSProperties = {
    ...style,
    width: size,
    height: size,
    borderWidth: Math.max(2, Math.round(size / 8)),
  };
  return (
    <span
      className={`${s.spinner}${className ? ` ${className}` : ""}`}
      style={merged}
      role="status"
      aria-live="polite"
      aria-label={label ?? "Loading"}
    />
  );
}
