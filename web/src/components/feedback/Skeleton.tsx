import s from "./feedback.module.css";
import type { CSSProperties } from "react";

export type SkeletonVariant = "text" | "rect" | "circle";

export type SkeletonProps = {
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
};

const VARIANT_CLASS: Record<SkeletonVariant, string> = {
  text: s.skeletonText,
  rect: s.skeletonRect,
  circle: s.skeletonCircle,
};

export function Skeleton({
  variant = "text",
  width,
  height,
  className,
  style,
  ariaLabel,
}: SkeletonProps) {
  const merged: CSSProperties = {
    ...style,
    ...(width !== undefined ? { width } : null),
    ...(height !== undefined ? { height } : null),
  };
  return (
    <span
      className={`${s.skeleton} ${VARIANT_CLASS[variant]}${className ? ` ${className}` : ""}`}
      style={merged}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? "status" : undefined}
    />
  );
}
