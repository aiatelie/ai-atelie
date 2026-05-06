/* Inspector.tsx — right-side properties panel.
 *
 * Reads computed styles from the currently-selected iframe element and
 * surfaces editable Typography / Size / Box fields. Each change calls
 * onChange(prop, value) which the parent forwards to the iframe DOM
 * (live mutation) AND to localStorage (persistence).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import s from "./editor.module.css";
import { getDocumentColors, getDocumentFonts, type ColorUsage, type FontUsage } from "../../lib/docInspect";
import { ModelPicker, loadModelId, saveModelId, useModelPickerFlag } from "./ModelPicker";
import type { ElementDescriptor } from "../../lib/cssPath";

export type SelectedInfo = {
  selector: string;
  tag: string;
  computed: CSSStyleDeclaration;
  /** Rich, AI-friendly element profile. Optional for back-compat with
   *  callers that only have a selector (e.g. drag/drop persistence). */
  descriptor?: ElementDescriptor;
};

type Props = {
  selected: SelectedInfo | null;
  /** Total selectors currently selected (≥1 when there's a primary). */
  selectionCount?: number;
  /** The active iframe doc — used to collect document-wide colors + fonts. */
  doc?: Document | null;
  onChange: (prop: string, value: string) => void;
  /** Click a swatch / font item → set this prop on the current selection. */
  onApplyColor?: (color: string) => void;
  onApplyFont?: (family: string) => void;
  /** Expand selection to all elements with the same tag+class as primary. */
  onSelectSimilar?: () => void;
  /** Smart `position` flip — preserves visual location when going to
   *  absolute/fixed by computing correct top/left. Falls back to a plain
   *  `onChange("position", mode)` if absent. Editor wires it through the
   *  inject-script's setPositionMode command. */
  onSetPositionMode?: (mode: "static" | "relative" | "absolute" | "fixed") => void;
  /** Send a free-text question to AI about the current selection. */
  onAskKimi?: (text: string, modelId: string) => void;
  /** Close the inspector (parent typically exits Edit mode). */
  onClose?: () => void;
};

const FONTS = ["inherit", "Syne", "Antonio", "Archivo", "JetBrains Mono", "Instrument Serif", "Noto Sans JP", "system-ui"];
const ALIGN = ["left", "center", "right", "justify"];
const WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"];
const DISPLAYS = ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none"];
const FLEX_DIRECTIONS = ["row", "row-reverse", "column", "column-reverse"];
const FLEX_WRAP = ["nowrap", "wrap", "wrap-reverse"];
const JUSTIFY = ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"];
const ALIGN_ITEMS = ["stretch", "flex-start", "flex-end", "center", "baseline"];
const POSITIONS = ["static", "relative", "absolute", "fixed", "sticky"];

function stripUrlWrapper(bg: string): string {
  // computed background-image is "url(\"...\")" or "none"
  if (!bg || bg === "none") return "";
  const m = bg.match(/^url\(["']?(.+?)["']?\)$/);
  return m ? m[1] : bg;
}

function pxFromComputed(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function rgbToHex(rgb: string): string {
  // "rgb(255, 74, 28)" or "rgba(...)" → "#ff4a1c"
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return "#000000";
  const [, r, g, b] = m;
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function Inspector({ selected, selectionCount, doc, onChange, onApplyColor, onApplyFont, onSelectSimilar, onSetPositionMode, onAskKimi, onClose }: Props) {
  if (!selected) {
    return (
      <aside className={s.inspector}>
        <div className={s.inspectorTitle}>
          <span>Page</span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close inspector"
              title="Close inspector"
              style={{
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
              }}
            >
              ×
            </button>
          )}
        </div>
        <div className={s.inspectorEmpty}>
          Click an element to edit its styles. ⇧-click to add to selection.
        </div>
        <DocSummary doc={doc} onPickColor={undefined} onPickFont={undefined} />
      </aside>
    );
  }
  return (
    <InspectorBody
      key={selected.selector}
      selected={selected}
      selectionCount={selectionCount}
      onChange={onChange}
      doc={doc}
      onApplyColor={onApplyColor}
      onApplyFont={onApplyFont}
      onSelectSimilar={onSelectSimilar}
      onSetPositionMode={onSetPositionMode}
      onAskKimi={onAskKimi}
      onClose={onClose}
    />
  );
}

function InspectorCloseHeader({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -8 }}>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close inspector"
        title="Close inspector"
        style={{
          appearance: "none",
          border: 0,
          background: "transparent",
          color: "var(--ink-50)",
          width: 26,
          height: 26,
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        ×
      </button>
    </div>
  );
}

function AskKimiComposer({ onSubmit }: { onSubmit: (text: string, modelId: string) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const showModelPicker = useModelPickerFlag();
  const [modelId, setModelId] = useState<string>(loadModelId);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [text]);
  useEffect(() => { saveModelId(modelId); }, [modelId]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t, modelId);
    setText("");
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 10px",
        background: "var(--brand-soft)",
        border: "1px solid var(--brand-border)",
        borderRadius: 9,
      }}
    >
      <div style={{ fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-55)", fontWeight: 600 }}>
        Ask AI · about this selection
      </div>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
        }}
        rows={1}
        placeholder="Question, refactor request, design idea…  ⌘↵ to send"
        style={{
          appearance: "none",
          border: "1px solid var(--ink-10)",
          background: "var(--surface)",
          color: "var(--ink-92)",
          font: "12px var(--font-system)",
          lineHeight: 1.4,
          padding: "6px 8px",
          borderRadius: 6,
          outline: "none",
          resize: "none",
          minHeight: 28,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        {showModelPicker && (
          <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            <ModelPicker value={modelId} onChange={setModelId} />
          </div>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          style={{
            appearance: "none",
            border: 0,
            background: text.trim() ? "var(--brand)" : "var(--ink-10)",
            color: text.trim() ? "var(--on-brand)" : "var(--ink-40)",
            font: "600 11px var(--font-system)",
            padding: "5px 10px",
            borderRadius: 6,
            cursor: text.trim() ? "pointer" : "not-allowed",
            flexShrink: 0,
          }}
        >
          ↗ Ask AI
        </button>
      </div>
    </div>
  );
}

function DocSummary({
  doc,
  onPickColor,
  onPickFont,
}: {
  doc?: Document | null;
  onPickColor?: (color: string) => void;
  onPickFont?: (family: string) => void;
}) {
  const [colors, setColors] = useState<ColorUsage[]>([]);
  const [fonts, setFonts] = useState<FontUsage[]>([]);

  useEffect(() => {
    if (!doc) { setColors([]); setFonts([]); return; }
    // Defer one frame so the iframe has finished its initial paint.
    const id = requestAnimationFrame(() => {
      try {
        setColors(getDocumentColors(doc));
        setFonts(getDocumentFonts(doc));
      } catch { /* iframe may have unloaded */ }
    });
    return () => cancelAnimationFrame(id);
  }, [doc]);

  if (colors.length === 0 && fonts.length === 0) return null;
  return (
    <>
      {colors.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionLabel}>Document colors</div>
          <div className={s.swatchGrid}>
            {colors.map((c) => (
              <button
                key={c.color}
                className={s.docSwatch}
                style={{ background: c.color }}
                title={`${c.color} · used ${c.count}×${onPickColor ? " · click to apply" : ""}`}
                onClick={() => onPickColor?.(c.color)}
                disabled={!onPickColor}
              />
            ))}
          </div>
        </div>
      )}
      {fonts.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionLabel}>Document fonts</div>
          <div className={s.fontList}>
            {fonts.map((f) => (
              <button
                key={f.family}
                className={s.docFont}
                style={{ fontFamily: f.family }}
                title={`${f.family} · used ${f.count}×${onPickFont ? " · click to apply" : ""}`}
                onClick={() => onPickFont?.(f.family)}
                disabled={!onPickFont}
              >
                {f.family}
                <span className={s.docCount}>{f.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function InspectorBody({
  selected,
  selectionCount,
  onChange,
  doc,
  onApplyColor,
  onApplyFont,
  onSelectSimilar,
  onSetPositionMode,
  onAskKimi,
  onClose,
}: {
  selected: SelectedInfo;
  selectionCount?: number;
  onChange: Props["onChange"];
  doc?: Document | null;
  onApplyColor?: (color: string) => void;
  onApplyFont?: (family: string) => void;
  onSelectSimilar?: () => void;
  onSetPositionMode?: (mode: "static" | "relative" | "absolute" | "fixed") => void;
  onAskKimi?: (text: string, modelId: string) => void;
  onClose?: () => void;
}) {
  const c = selected.computed;

  // Snapshot the computed values once per selection, then track local edits
  // optimistically. Each apply is forwarded to the iframe + storage.
  const initial = useMemo(
    () => ({
      "font-family": (c.fontFamily.split(",")[0] || "").replace(/^["']|["']$/g, "").trim() || "inherit",
      "font-size": pxFromComputed(c.fontSize),
      "font-weight": String(c.fontWeight || "400"),
      "color": rgbToHex(c.color),
      "text-align": (c.textAlign || "left") as string,
      "line-height": c.lineHeight === "normal" ? "" : c.lineHeight,
      "letter-spacing": c.letterSpacing === "normal" ? "0" : c.letterSpacing,
      "width": pxFromComputed(c.width),
      "height": pxFromComputed(c.height),
      "opacity": Number(c.opacity || 1),
      "padding": c.padding,
      "margin": c.margin,
      "border-width": c.borderTopWidth,
      "border-radius": pxFromComputed(c.borderTopLeftRadius),
      // Layout
      "display": c.display || "block",
      "flex-direction": c.flexDirection || "row",
      "flex-wrap": c.flexWrap || "nowrap",
      "justify-content": c.justifyContent || "flex-start",
      "align-items": c.alignItems || "stretch",
      "gap": pxFromComputed(c.gap),
      "grid-template-columns": c.gridTemplateColumns === "none" ? "" : c.gridTemplateColumns,
      "grid-template-rows": c.gridTemplateRows === "none" ? "" : c.gridTemplateRows,
      // Position
      "position": c.position || "static",
      "top": c.top === "auto" ? "" : c.top,
      "right": c.right === "auto" ? "" : c.right,
      "bottom": c.bottom === "auto" ? "" : c.bottom,
      "left": c.left === "auto" ? "" : c.left,
      "z-index": c.zIndex === "auto" ? "" : c.zIndex,
      // Background
      "background-image": stripUrlWrapper(c.backgroundImage),
      "background-color": rgbToHex(c.backgroundColor),
    }),
    [c]
  );

  const [vals, setVals] = useState(initial);
  useEffect(() => { setVals(initial); }, [initial]);

  function update<K extends keyof typeof initial>(key: K, raw: string | number, suffix = "") {
    setVals((prev) => ({ ...prev, [key]: raw } as typeof prev));
    onChange(String(key), String(raw) + suffix);
  }

  return (
    <aside className={s.inspector}>
      <div className={s.inspectorTitle}>
        <span>Selection{selectionCount && selectionCount > 1 ? ` · ${selectionCount}` : ""}</span>
        <span className={s.selBadge}>{selected.tag}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close inspector"
            style={{
              appearance: "none",
              border: 0,
              background: "transparent",
              color: "var(--ink-50)",
              width: 26,
              height: 26,
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              marginLeft: 4,
            }}
          >
            ×
          </button>
        )}
      </div>
      {onAskKimi && <AskKimiComposer onSubmit={onAskKimi} />}
      {onSelectSimilar && (
        <button
          type="button"
          onClick={onSelectSimilar}
          style={{
            appearance: "none",
            border: "1px solid var(--ink-10)",
            background: "transparent",
            color: "var(--ink-60)",
            borderRadius: 7,
            padding: "5px 10px",
            font: "500 11px var(--font-system)",
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
          title="Add all elements with the same tag + class to the selection"
        >
          ✨ Select similar
        </button>
      )}

      <div className={s.section}>
        <div className={s.sectionLabel}>Typography</div>
        <div className={s.rowFull}>
          <div className={s.field}>
            <label>Font</label>
            <select
              value={vals["font-family"]}
              onChange={(e) => update("font-family", e.target.value)}
            >
              {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
        <div className={s.row}>
          <div className={s.field}>
            <label>Size</label>
            <input
              type="number"
              value={vals["font-size"]}
              onChange={(e) => update("font-size", Number(e.target.value), "px")}
            />
            <span className={s.unit}>px</span>
          </div>
          <div className={s.field}>
            <label>Weight</label>
            <select
              value={vals["font-weight"]}
              onChange={(e) => update("font-weight", e.target.value)}
            >
              {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
        </div>
        <div className={s.row}>
          <div className={s.field}>
            <label>Color</label>
            <input
              type="color"
              className={s.swatch}
              value={vals.color}
              onChange={(e) => update("color", e.target.value)}
            />
            <input
              type="text"
              value={vals.color}
              onChange={(e) => update("color", e.target.value)}
              style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
            />
          </div>
          <div className={s.field}>
            <label>Align</label>
            <select
              value={vals["text-align"]}
              onChange={(e) => update("text-align", e.target.value)}
            >
              {ALIGN.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>
        <div className={s.row}>
          <div className={s.field}>
            <label>Line</label>
            <input
              type="number"
              step="0.01"
              value={typeof vals["line-height"] === "string" ? parseFloat(vals["line-height"]) || "" : vals["line-height"]}
              onChange={(e) => update("line-height", e.target.value)}
            />
          </div>
          <div className={s.field}>
            <label>Tracking</label>
            <input
              type="number"
              step="0.05"
              value={parseFloat(String(vals["letter-spacing"])) || 0}
              onChange={(e) => update("letter-spacing", Number(e.target.value), "px")}
            />
            <span className={s.unit}>px</span>
          </div>
        </div>
      </div>

      <div className={s.section}>
        <div className={s.sectionLabel}>Size</div>
        <div className={s.row}>
          <div className={s.field}>
            <label>Width</label>
            <input
              type="number"
              value={vals.width}
              onChange={(e) => update("width", Number(e.target.value), "px")}
            />
            <span className={s.unit}>px</span>
          </div>
          <div className={s.field}>
            <label>Height</label>
            <input
              type="number"
              value={vals.height}
              onChange={(e) => update("height", Number(e.target.value), "px")}
            />
            <span className={s.unit}>px</span>
          </div>
        </div>
      </div>

      <div className={s.section}>
        <div className={s.sectionLabel}>Box</div>
        <div className={s.rowFull}>
          <div className={s.field}>
            <label>Opacity</label>
            <input
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={vals.opacity}
              onChange={(e) => update("opacity", Number(e.target.value))}
            />
          </div>
          <div className={s.field}>
            <label>Padding</label>
            <input
              type="text"
              value={vals.padding}
              onChange={(e) => update("padding", e.target.value)}
            />
          </div>
          <div className={s.field}>
            <label>Margin</label>
            <input
              type="text"
              value={vals.margin}
              onChange={(e) => update("margin", e.target.value)}
            />
          </div>
          <div className={s.field}>
            <label>Border</label>
            <input
              type="text"
              value={vals["border-width"]}
              onChange={(e) => update("border-width", e.target.value)}
            />
          </div>
          <div className={s.field}>
            <label>Radius</label>
            <input
              type="number"
              value={vals["border-radius"]}
              onChange={(e) => update("border-radius", Number(e.target.value), "px")}
            />
            <span className={s.unit}>px</span>
          </div>
        </div>
      </div>

      <div className={s.section}>
        <div className={s.sectionLabel}>Layout</div>
        <div className={s.rowFull}>
          <div className={s.field}>
            <label>Display</label>
            <select value={vals.display} onChange={(e) => update("display", e.target.value)}>
              {DISPLAYS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>
        {(vals.display === "flex" || vals.display === "inline-flex") && (
          <>
            <div className={s.row}>
              <div className={s.field}>
                <label>Direction</label>
                <select value={vals["flex-direction"]} onChange={(e) => update("flex-direction", e.target.value)}>
                  {FLEX_DIRECTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className={s.field}>
                <label>Wrap</label>
                <select value={vals["flex-wrap"]} onChange={(e) => update("flex-wrap", e.target.value)}>
                  {FLEX_WRAP.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            </div>
            <div className={s.row}>
              <div className={s.field}>
                <label>Justify</label>
                <select value={vals["justify-content"]} onChange={(e) => update("justify-content", e.target.value)}>
                  {JUSTIFY.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className={s.field}>
                <label>Align</label>
                <select value={vals["align-items"]} onChange={(e) => update("align-items", e.target.value)}>
                  {ALIGN_ITEMS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            </div>
          </>
        )}
        {(vals.display === "grid" || vals.display === "inline-grid") && (
          <div className={s.rowFull}>
            <div className={s.field}>
              <label>Cols</label>
              <input type="text" value={String(vals["grid-template-columns"])} onChange={(e) => update("grid-template-columns", e.target.value)} placeholder="e.g. repeat(3, 1fr)" />
            </div>
            <div className={s.field}>
              <label>Rows</label>
              <input type="text" value={String(vals["grid-template-rows"])} onChange={(e) => update("grid-template-rows", e.target.value)} placeholder="auto" />
            </div>
          </div>
        )}
        <div className={s.row}>
          <div className={s.field}>
            <label>Gap</label>
            <input
              type="number"
              value={vals.gap}
              onChange={(e) => update("gap", Number(e.target.value), "px")}
            />
            <span className={s.unit}>px</span>
          </div>
          <div /> {/* empty cell to keep grid balanced */}
        </div>
      </div>

      <div className={s.section}>
        <div className={s.sectionLabel}>Position</div>
        <div className={s.rowFull}>
          <div className={s.field}>
            <label>Mode</label>
            <select
              value={vals.position}
              onChange={(e) => {
                const mode = e.target.value as "static" | "relative" | "absolute" | "fixed";
                // Optimistically update local UI so the dependent inputs
                // show/hide immediately. The actual position flip — and
                // the auto-computed top/left that keeps the element from
                // jumping to (0,0) — happens via the DM bus's smart
                // setPositionMode command. Falls back to a plain prop
                // write when the parent didn't supply the smart handler.
                setVals((prev) => ({ ...prev, position: mode } as typeof prev));
                if (onSetPositionMode) onSetPositionMode(mode);
                else onChange("position", mode);
              }}
            >
              {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        {vals.position !== "static" && (
          <>
            <div className={s.row}>
              <div className={s.field}>
                <label>Top</label>
                <input type="text" value={String(vals.top)} placeholder="auto" onChange={(e) => update("top", e.target.value)} />
              </div>
              <div className={s.field}>
                <label>Right</label>
                <input type="text" value={String(vals.right)} placeholder="auto" onChange={(e) => update("right", e.target.value)} />
              </div>
            </div>
            <div className={s.row}>
              <div className={s.field}>
                <label>Bottom</label>
                <input type="text" value={String(vals.bottom)} placeholder="auto" onChange={(e) => update("bottom", e.target.value)} />
              </div>
              <div className={s.field}>
                <label>Left</label>
                <input type="text" value={String(vals.left)} placeholder="auto" onChange={(e) => update("left", e.target.value)} />
              </div>
            </div>
            <div className={s.row}>
              <div className={s.field}>
                <label>Z-index</label>
                <input type="text" value={String(vals["z-index"])} placeholder="auto" onChange={(e) => update("z-index", e.target.value)} />
              </div>
              <div />
            </div>
          </>
        )}
      </div>

      <div className={s.section}>
        <div className={s.sectionLabel}>Background</div>
        <div className={s.row}>
          <div className={s.field}>
            <label>Color</label>
            <input
              type="color"
              className={s.swatch}
              value={vals["background-color"]}
              onChange={(e) => update("background-color", e.target.value)}
            />
            <input
              type="text"
              value={vals["background-color"]}
              onChange={(e) => update("background-color", e.target.value)}
              style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
            />
          </div>
          <div className={s.field}>
            <label>Img</label>
            {vals["background-image"] ? (
              <img
                src={vals["background-image"]}
                alt="bg"
                style={{ width: 22, height: 22, objectFit: "cover", borderRadius: 4, border: "1px solid rgba(0,0,0,0.1)" }}
              />
            ) : null}
          </div>
        </div>
        <div className={s.rowFull}>
          <div className={s.field}>
            <label>URL</label>
            <input
              type="text"
              value={vals["background-image"]}
              placeholder="https://… or /bg/…"
              onChange={(e) => {
                const url = e.target.value;
                update("background-image", url ? `url("${url}")` : "none");
                // Keep displayed value as plain URL
                setVals((prev) => ({ ...prev, "background-image": url } as typeof prev));
              }}
            />
          </div>
        </div>
      </div>

      <DocSummary doc={doc} onPickColor={onApplyColor} onPickFont={onApplyFont} />
    </aside>
  );
}
