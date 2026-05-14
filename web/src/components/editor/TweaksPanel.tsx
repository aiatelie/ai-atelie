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
 * Control mapping (in order of precedence):
 *   1. `_meta.<key>.swatches: string[]`  →  curated swatch picker
 *   2. `_meta.<key>.options:  string[]`  →  <select> dropdown
 *   3. runtime type of the value:
 *        string starting with `#`  → <input type="color"> + hex text
 *        number                    → <input type="range"> + numeric readout
 *        boolean                   → checkbox toggle
 *        string with newlines OR
 *          length > 60             → <textarea>
 *        string (everything else)  → <input type="text">
 *
 * `_meta.<key>.{min,max,step,unit,label,help}` refine the runtime-type
 * mapping (proper-range slider, unit suffix, label override, caption).
 *
 * The panel stays dumb. The agent author owns the schema (via `_meta`)
 * AND the runtime values; we just reflect them.
 */

import { useEffect, useRef, useState } from "react";
import s from "./editor.module.css";
import type {
  TweakBridge,
  TweakFieldMeta,
  TweakValue,
} from "../../lib/tweakBridge";

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
 *  Pure cosmetic — JSON keys are the source of truth. Overridden by
 *  `_meta.<key>.label` when the author wants a custom display name. */
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
  const { defaults, meta, applyEdits } = bridge;

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
            meta={meta?.[key]}
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

const helpStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-44)",
  lineHeight: 1.35,
  marginTop: -2,
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
  meta,
  onChange,
}: {
  name: string;
  value: TweakValue;
  meta?: TweakFieldMeta;
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

  // The label + help caption are shared by every control variant.
  const label = meta?.label ?? humanizeKey(name);
  const help = meta?.help;

  // ─── meta.options first — works for any string value ─────────────
  // (When the author wants a fixed set, that beats every other
  // heuristic — even color hex strings.)
  if (meta?.options && (typeof value === "string" || typeof local === "string")) {
    const sv = typeof local === "string" ? local : String(value);
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{label}</span>
        <select
          value={sv}
          onChange={(e) => commit(e.target.value)}
          style={inputStyle}
          aria-label={label}
        >
          {/* Surface unknown values too so we don't silently drop them
              if the artifact's source carries something not in options. */}
          {!meta.options.includes(sv) && (
            <option value={sv}>{sv} (current)</option>
          )}
          {meta.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        {help && <div style={helpStyle}>{help}</div>}
      </div>
    );
  }

  if (typeof value === "boolean" || typeof local === "boolean") {
    const b = typeof local === "boolean" ? local : Boolean(value);
    return (
      <label style={{ ...rowStyle, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <input
          type="checkbox"
          checked={b}
          onChange={(e) => commit(e.target.checked)}
          aria-label={label}
        />
        <span style={{ ...labelStyle, textTransform: "none", letterSpacing: 0, fontSize: 13, fontWeight: 500, color: "var(--ink-92)" }}>
          {label}
        </span>
        {help && <span style={helpStyle}>{help}</span>}
      </label>
    );
  }

  if (typeof value === "number" || typeof local === "number") {
    const n = typeof local === "number" ? local : Number(value);
    // Meta-declared range wins. Heuristic fallback when absent picks a
    // sensible min/max around the seed so the slider feels useful
    // without forcing the artifact to declare a schema for every knob.
    const min = typeof meta?.min === "number"
      ? meta.min
      : Math.min(0, n - Math.max(1, Math.abs(n)) * 2);
    const max = typeof meta?.max === "number"
      ? meta.max
      : Math.max(n + Math.max(1, Math.abs(n)) * 2, n + 1);
    const step = typeof meta?.step === "number"
      ? meta.step
      : Math.abs(n) > 10 ? 1 : 0.1;
    const unit = meta?.unit ?? "";
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={n}
            onChange={(e) => commit(Number(e.target.value))}
            style={{ flex: 1 }}
            aria-label={label}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="number"
              value={n}
              step={step}
              min={typeof meta?.min === "number" ? meta.min : undefined}
              max={typeof meta?.max === "number" ? meta.max : undefined}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) commit(v);
              }}
              style={{ ...inputStyle, width: 64, fontFamily: "var(--font-mono)", fontSize: 12 }}
              aria-label={`${label} (numeric)`}
            />
            {unit && (
              <span style={{ fontSize: 11, color: "var(--ink-44)", fontFamily: "var(--font-mono)" }}>
                {unit}
              </span>
            )}
          </div>
        </div>
        {help && <div style={helpStyle}>{help}</div>}
      </div>
    );
  }

  // From here on the value is a string.
  const sv = typeof local === "string" ? local : String(value);

  // ─── Curated swatch picker ────────────────────────────────────────
  // When meta.swatches is present, render the curated row INSTEAD of
  // the free hex picker. Curated > free for design intent: the author
  // picked the palette, the user picks within it.
  if (isHexColor(value) && meta?.swatches && meta.swatches.length > 0) {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{label}</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {meta.swatches.map((swatch) => {
            const active = sv.toLowerCase() === swatch.toLowerCase();
            return (
              <button
                key={swatch}
                type="button"
                onClick={() => commit(swatch)}
                aria-label={`${label}: ${swatch}`}
                aria-pressed={active}
                title={swatch}
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  borderRadius: 999,
                  cursor: "pointer",
                  background: swatch,
                  border: active
                    ? "2px solid var(--ink-92)"
                    : "1px solid var(--ink-15)",
                  // Inset shadow so the swatch stays legible against a
                  // matching panel background — without this a #FFFFFF
                  // swatch on a paper-cream surface would be invisible.
                  boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)",
                  transition: "transform 0.12s ease",
                  transform: active ? "scale(1.08)" : "scale(1)",
                }}
              />
            );
          })}
          {/* Surface the current value as text so users see what's
              live even when it isn't one of the curated swatches. */}
          <span
            style={{
              alignSelf: "center",
              fontSize: 11,
              color: "var(--ink-44)",
              fontFamily: "var(--font-mono)",
              marginLeft: 4,
            }}
          >
            {sv}
          </span>
        </div>
        {help && <div style={helpStyle}>{help}</div>}
      </div>
    );
  }

  if (isHexColor(value) || isHexColor(local)) {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="color"
            value={sv}
            onChange={(e) => commit(e.target.value)}
            aria-label={label}
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
            aria-label={`${label} (hex)`}
          />
        </div>
        {help && <div style={helpStyle}>{help}</div>}
      </div>
    );
  }

  if (isLongString(sv)) {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{label}</span>
        <textarea
          value={sv}
          onChange={(e) => commit(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: "vertical", minHeight: 56, fontFamily: "var(--font-system)" }}
          aria-label={label}
        />
        {help && <div style={helpStyle}>{help}</div>}
      </div>
    );
  }

  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <input
        type="text"
        value={sv}
        onChange={(e) => commit(e.target.value)}
        style={inputStyle}
        aria-label={label}
      />
      {help && <div style={helpStyle}>{help}</div>}
    </div>
  );
}
