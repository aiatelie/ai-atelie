/* flags.ts — local feature-flag hook.
 *
 * Mirror of GrowthBook-style flagging at solo-dev scale: a flat
 * `localStorage["flags"]` JSON object of boolean toggles.
 *
 *   import { useFlag, setFlag, allFlags } from "./flags";
 *   const voice = useFlag("voice-input");
 *
 * Default values are baked into DEFAULTS below; localStorage overrides
 * them. To change a flag at runtime, open DevTools and run:
 *   localStorage.flags = JSON.stringify({ "voice-input": true })
 * or call setFlag("voice-input", true) from a debug console.
 */

import { useEffect, useState } from "react";

export type FlagName =
  | "model-picker"
  | "select-similar"
  | "drag-reposition"
  | "templates-gallery"
  | "telemetry";

const DEFAULTS: Record<FlagName, boolean> = {
  "model-picker": true,
  "select-similar": false,
  "drag-reposition": false,
  "templates-gallery": false,
  "telemetry": true,
};

const KEY = "flags";

function read(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch { return {}; }
}

function write(next: Record<string, boolean>) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

export function getFlag(name: FlagName): boolean {
  const overrides = read();
  return name in overrides ? !!overrides[name] : DEFAULTS[name];
}

export function setFlag(name: FlagName, value: boolean) {
  const next = { ...read(), [name]: value };
  write(next);
  // Notify any listening hooks.
  window.dispatchEvent(new CustomEvent("flags:change", { detail: { name, value } }));
}

export function allFlags(): Record<FlagName, boolean> {
  const overrides = read();
  const out: Record<string, boolean> = { ...DEFAULTS };
  for (const k of Object.keys(overrides)) out[k] = !!overrides[k];
  return out as Record<FlagName, boolean>;
}

export function useFlag(name: FlagName): boolean {
  const [v, setV] = useState<boolean>(() => getFlag(name));
  useEffect(() => {
    const onChange = (e: Event) => {
      const ev = e as CustomEvent<{ name: string; value: boolean }>;
      if (ev.detail?.name === name) setV(!!ev.detail.value);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setV(getFlag(name));
    };
    window.addEventListener("flags:change", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("flags:change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [name]);
  return v;
}
