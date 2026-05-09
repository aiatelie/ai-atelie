/* TweaksPanel.tsx — host-side sidebar for the Tweaks protocol.
 *
 * When the iframe's auto-bridge announces __edit_mode_available with a
 * `defaults` payload, the editor renders this panel next to the canvas
 * (mirroring the Inspector slot). Each control's input drives a
 * tweakBridge.applyEdits({ key: value }) call, which:
 *   1. Mirrors the new value in host state so the input stays in sync.
 *   2. Posts __edit_mode_set_keys to the iframe so it can apply the
 *      change live (CSS vars / data-tweak hooks / __applyTweaks).
 *   3. POSTs /api/projects/:id/tweak so the edit lands in source
 *      between the EDITMODE markers and survives reload.
 *
 * Control mapping (derived from the value's runtime type):
 *   string starting with `#`  → <input type="color">
 *   number                    → <input type="range"> + numeric readout
 *   boolean                   → checkbox toggle
 *   string with newlines OR
 *     length > 60             → <textarea>
 *   string (everything else)  → <input type="text">
 *
 * The panel is intentionally dumb — no schema, no priorities. The keys
 * come from whatever the artifact author put in their EDITMODE block;
 * we just reflect them. If the agent wants nicer labels, it can name
 * keys camelCase ("primaryColor") and we humanize them on display.
 */

import { useEffect, useRef, useState } from "react";
import s from "./editor.module.css";
import type { TweakBridge, TweakValue } from "../../lib/tweakBridge";

type Props = {
  bridge: TweakBridge;
  /** Project-relative path of the file the EDITMODE block lives in.
   *  Shown as a subtitle so the user knows where their edits will be
   *  written back. */
  activeFile: string;
  /** Close the panel (parent flips bridge.editing off). */
  onClose: () => void;
};

/** "primaryColor" → "Primary color"; "fontSize" → "Font size".
 *  Pure cosmetic — JSON keys are the source of truth. */
function humanizeKey(k: string): string {
  const spaced = k
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return k;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());
}

function isLongString(v: string): boolean {
  return v.length > 60 || v.includes("\n");
}

export function TweaksPanel({ bridge, activeFile, onClose }: Props) {
  const { defaults, applyEdits } = bridge;

  if (!defaults || Object.keys(defaults).length === 0) {
    return (
      <aside className={s.inspector} aria-label="Tweaks panel">
        <div className={s.inspectorTitle}>
          <span>Tweaks</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tweaks panel"
            title="Close"
            style={closeBtnStyle}
          >
            ×
          </button>
        </div>
        <div className={s.inspectorEmpty}>
          This page has no EDITMODE block yet. Use the &ldquo;Tweaks&rdquo;
          button on the toolbar to ask the agent to add tweakable defaults.
        </div>
      </aside>
    );
  }

  return (
    <aside className={s.inspector} aria-label="Tweaks panel">
      <div className={s.inspectorTitle}>
        <span>Tweaks</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tweaks panel"
          title="Close"
          style={closeBtnStyle}
        >
          ×
        </button>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--ink-44)",
          marginTop: -8,
          fontFamily: "var(--font-mono)",
          wordBreak: "break-all",
        }}
      >
        {activeFile || "(active file)"}
      </div>

      <div className={s.section}>
        {Object.entries(defaults).map(([key, value]) => (
          <Field
            key={key}
            name={key}
            value={value}
            onChange={(next) => applyEdits({ [key]: next })}
          />
        ))}
      </div>
    </aside>
  );
}

const closeBtnStyle: React.CSSProperties = {
  appearance: "none",
  border: 0,
  background: "transparent",
  color: "var(--ink-50)",
  width: 22,
  height: 22,
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--ink-50)",
  fontWeight: 600,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingBottom: 12,
};

const inputStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--ink-10)",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--ink-92)",
  padding: "6px 8px",
  font: "13px var(--font-system)",
  outline: "none",
  width: "100%",
};

function Field({
  name,
  value,
  onChange,
}: {
  name: string;
  value: TweakValue;
  onChange: (next: TweakValue) => void;
}) {
  // Local state so the input stays responsive even when the parent
  // throttles its applyEdits → re-render cycle. We sync from `value`
  // when the parent's authoritative copy changes (e.g. after disk
  // round-trip via reload).
  const [local, setLocal] = useState<TweakValue>(value);
  const seedRef = useRef(value);
  useEffect(() => {
    if (seedRef.current !== value) {
      seedRef.current = value;
      setLocal(value);
    }
  }, [value]);

  const commit = (v: TweakValue) => {
    setLocal(v);
    onChange(v);
  };

  if (typeof value === "boolean" || typeof local === "boolean") {
    const b = typeof local === "boolean" ? local : Boolean(value);
    return (
      <label style={{ ...rowStyle, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <input
          type="checkbox"
          checked={b}
          onChange={(e) => commit(e.target.checked)}
          aria-label={humanizeKey(name)}
        />
        <span style={{ ...labelStyle, textTransform: "none", letterSpacing: 0, fontSize: 13, fontWeight: 500, color: "var(--ink-92)" }}>
          {humanizeKey(name)}
        </span>
      </label>
    );
  }

  if (typeof value === "number" || typeof local === "number") {
    const n = typeof local === "number" ? local : Number(value);
    // Heuristic range — pick a sensible min/max around the seed so the
    // slider feels useful without forcing the artifact to declare a
    // schema. Most tweaks are sizes (4–120 px) or 0–100 percentages.
    const min = Math.min(0, n - Math.max(1, Math.abs(n)) * 2);
    const max = Math.max(n + Math.max(1, Math.abs(n)) * 2, n + 1);
    const step = Math.abs(n) > 10 ? 1 : 0.1;
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{humanizeKey(name)}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={n}
            onChange={(e) => commit(Number(e.target.value))}
            style={{ flex: 1 }}
            aria-label={humanizeKey(name)}
          />
          <input
            type="number"
            value={n}
            step={step}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) commit(v);
            }}
            style={{ ...inputStyle, width: 64, fontFamily: "var(--font-mono)", fontSize: 12 }}
            aria-label={`${humanizeKey(name)} (numeric)`}
          />
        </div>
      </div>
    );
  }

  // From here on the value is a string.
  const sv = typeof local === "string" ? local : String(value);

  if (isHexColor(value) || isHexColor(local)) {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{humanizeKey(name)}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="color"
            value={sv}
            onChange={(e) => commit(e.target.value)}
            aria-label={humanizeKey(name)}
            style={{
              width: 36,
              height: 28,
              padding: 0,
              border: "1px solid var(--ink-10)",
              borderRadius: 6,
              background: "var(--surface)",
              cursor: "pointer",
            }}
          />
          <input
            type="text"
            value={sv}
            onChange={(e) => commit(e.target.value)}
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
            aria-label={`${humanizeKey(name)} (hex)`}
          />
        </div>
      </div>
    );
  }

  if (isLongString(sv)) {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{humanizeKey(name)}</span>
        <textarea
          value={sv}
          onChange={(e) => commit(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: "vertical", minHeight: 56, fontFamily: "var(--font-system)" }}
          aria-label={humanizeKey(name)}
        />
      </div>
    );
  }

  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{humanizeKey(name)}</span>
      <input
        type="text"
        value={sv}
        onChange={(e) => commit(e.target.value)}
        style={inputStyle}
        aria-label={humanizeKey(name)}
      />
    </div>
  );
}
