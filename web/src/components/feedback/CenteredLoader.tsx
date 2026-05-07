import s from "./feedback.module.css";
import { Spinner } from "./Spinner";

export type CenteredLoaderProps = {
  label?: string;
  className?: string;
};

export function CenteredLoader({ label = "Loading…", className }: CenteredLoaderProps) {
  return (
    <div className={`${s.centered}${className ? ` ${className}` : ""}`} role="status" aria-live="polite">
      <Spinner size={20} label={label} />
      <span>{label}</span>
    </div>
  );
}
