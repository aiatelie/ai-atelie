/* AssetsDialog.tsx — modal for managing the shared asset library.
 *
 * Three kinds of assets:
 *   • Colors      — referenced as CSS vars in any iframe.
 *   • Lotties     — animation URLs, previewed via lottie-player web
 *                   component loaded from CDN on first use.
 *   • Components  — raw HTML snippets, copyable into routes / pages.
 */

import { useEffect, useState } from "react";
import s from "./assets.module.css";
import {
  addColor,
  removeColor,
  updateColor,
  addLottie,
  removeLottie,
  updateLottie,
  addComponent,
  removeComponent,
  updateComponent,
  useSharedAssets,
  type SharedColor,
  type SharedLottie,
  type SharedComponent,
} from "../../lib/sharedAssets";

type Props = { open: boolean; onClose: () => void };
type Tab = "colors" | "lotties" | "components";

export function AssetsDialog({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("colors");
  const assets = useSharedAssets();
  if (!open) return null;
  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={s.head}>
          <b>Shared assets</b>
          <span className={s.subhead}>Edit once, reflect across every project.</span>
          <button className={s.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={s.tabs}>
          <TabBtn id="colors" cur={tab} onClick={setTab} count={assets.colors.length}>Colors</TabBtn>
          <TabBtn id="lotties" cur={tab} onClick={setTab} count={assets.lotties.length}>Lotties</TabBtn>
          <TabBtn id="components" cur={tab} onClick={setTab} count={assets.components.length}>Components</TabBtn>
        </div>
        <div className={s.body}>
          {tab === "colors" && <ColorsPanel colors={assets.colors} />}
          {tab === "lotties" && <LottiesPanel lotties={assets.lotties} />}
          {tab === "components" && <ComponentsPanel components={assets.components} />}
        </div>
        <div className={s.foot}>
          <span className={s.usage}>
            {tab === "colors" && (
              <>
                Reference in CSS: <code>var(--shared-color-&lt;name&gt;)</code> or
                <code> var(--shared-color-&lt;id&gt;)</code>
              </>
            )}
            {tab === "lotties" && (
              <>Drop URLs from LottieFiles or any public <code>.json</code> / <code>.lottie</code>.</>
            )}
            {tab === "components" && (
              <>HTML snippets. Use the Copy button to paste into a route.</>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  id, cur, onClick, count, disabled, children,
}: {
  id: Tab; cur: Tab; onClick: (id: Tab) => void;
  count?: number; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      className={`${s.tabBtn} ${cur === id ? s.tabBtnActive : ""}`}
      onClick={() => !disabled && onClick(id)}
      disabled={disabled}
    >
      {children}
      {count != null && <span className={s.tabCount}>{count}</span>}
    </button>
  );
}

/* ─── Colors ──────────────────────────────────────────────── */

function ColorsPanel({ colors }: { colors: SharedColor[] }) {
  return (
    <div className={s.colors}>
      {colors.length === 0 && (
        <div className={s.empty}>
          No shared colors yet. Add one — it'll be available as a CSS variable
          on every project's iframe.
        </div>
      )}
      {colors.map((c) => (
        <ColorRow key={c.id} color={c} />
      ))}
      <button
        className={s.addRow}
        onClick={() => addColor("New color", "#FF4A1C")}
      >
        + Add color
      </button>
    </div>
  );
}

function ColorRow({ color }: { color: SharedColor }) {
  const [name, setName] = useState(color.name);
  const [hex, setHex] = useState(color.hex);
  const commitName = () => {
    const v = name.trim() || color.name;
    if (v !== color.name) updateColor(color.id, { name: v });
  };
  const commitHex = (next: string) => {
    setHex(next);
    if (/^#[0-9a-fA-F]{6}$/.test(next)) updateColor(color.id, { hex: next });
  };
  return (
    <div className={s.colorRow}>
      <input
        type="color"
        className={s.swatch}
        value={hex}
        onChange={(e) => commitHex(e.target.value)}
      />
      <input
        type="text"
        className={s.colorName}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
      />
      <input
        type="text"
        className={s.hexInput}
        value={hex}
        onChange={(e) => commitHex(e.target.value)}
        spellCheck={false}
      />
      <button
        className={s.deleteBtn}
        onClick={() => removeColor(color.id)}
        aria-label="Delete color"
      >
        ×
      </button>
    </div>
  );
}

/* ─── Lotties ─────────────────────────────────────────────── */

const LOTTIE_PLAYER_SRC = "https://unpkg.com/@lottiefiles/lottie-player@2.0.8/dist/lottie-player.js";
let lottiePlayerLoading: Promise<void> | null = null;

function ensureLottiePlayer(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (customElements.get("lottie-player")) return Promise.resolve();
  if (lottiePlayerLoading) return lottiePlayerLoading;
  lottiePlayerLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LOTTIE_PLAYER_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load lottie-player"));
    document.head.appendChild(s);
  });
  return lottiePlayerLoading;
}

function LottiesPanel({ lotties }: { lotties: SharedLottie[] }) {
  return (
    <div className={s.lotties}>
      {lotties.length === 0 && (
        <div className={s.empty}>
          No lotties yet. Add a public <code>.json</code> or <code>.lottie</code> URL
          (e.g. from LottieFiles) — preview renders inline.
        </div>
      )}
      {lotties.map((l) => (
        <LottieRow key={l.id} lottie={l} />
      ))}
      <button
        className={s.addRow}
        onClick={() => {
          const url = prompt("Lottie URL (.json or .lottie):");
          if (!url) return;
          addLottie("New lottie", url.trim());
        }}
      >
        + Add lottie
      </button>
    </div>
  );
}

function LottieRow({ lottie }: { lottie: SharedLottie }) {
  const [name, setName] = useState(lottie.name);
  const [url, setUrl] = useState(lottie.url);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    ensureLottiePlayer().then(() => setReady(true)).catch(() => setReady(false));
  }, []);
  const commitName = () => {
    const v = name.trim() || lottie.name;
    if (v !== lottie.name) updateLottie(lottie.id, { name: v });
  };
  const commitUrl = () => {
    const v = url.trim();
    if (v && v !== lottie.url) updateLottie(lottie.id, { url: v });
  };
  const copyEmbed = async () => {
    const snippet = `<lottie-player src="${lottie.url}" autoplay loop style="width:100%;height:100%"></lottie-player>`;
    try { await navigator.clipboard.writeText(snippet); } catch { /* ignore */ }
  };
  return (
    <div className={s.lottieRow}>
      <div className={s.lottiePreview}>
        {ready && url ? (
          // lottie-player is a custom element; React types don't know it,
          // dangerouslySetInnerHTML keeps the markup verbatim.
          <div
            style={{ width: "100%", height: "100%" }}
            dangerouslySetInnerHTML={{
              __html: `<lottie-player src="${url.replace(/"/g, "&quot;")}" autoplay loop background="transparent"></lottie-player>`,
            }}
          />
        ) : null}
      </div>
      <div className={s.lottieMeta}>
        <input
          type="text"
          className={s.lottieName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
        />
        <input
          type="text"
          className={s.lottieUrl}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={commitUrl}
          spellCheck={false}
          placeholder="https://…/animation.json"
        />
        <button className={s.copyBtn} onClick={copyEmbed}>Copy embed</button>
      </div>
      <button
        className={s.deleteBtn}
        onClick={() => removeLottie(lottie.id)}
        aria-label="Delete lottie"
      >
        ×
      </button>
    </div>
  );
}

/* ─── Components ──────────────────────────────────────────── */

function ComponentsPanel({ components }: { components: SharedComponent[] }) {
  return (
    <div className={s.components}>
      {components.length === 0 && (
        <div className={s.empty}>
          No components yet. Add an HTML snippet — copy it into a route or
          dialog when you need it.
        </div>
      )}
      {components.map((c) => (
        <ComponentRow key={c.id} component={c} />
      ))}
      <button
        className={s.addRow}
        onClick={() => addComponent("Untitled snippet", "<div class=\"shared-component\">Hello</div>")}
      >
        + Add component
      </button>
    </div>
  );
}

function ComponentRow({ component }: { component: SharedComponent }) {
  const [name, setName] = useState(component.name);
  const [html, setHtml] = useState(component.html);
  const commitName = () => {
    const v = name.trim() || component.name;
    if (v !== component.name) updateComponent(component.id, { name: v });
  };
  const commitHtml = () => {
    if (html !== component.html) updateComponent(component.id, { html });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(component.html); } catch { /* ignore */ }
  };
  return (
    <div className={s.componentRow}>
      <div className={s.componentMeta}>
        <input
          type="text"
          className={s.componentName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
        />
        <textarea
          className={s.componentHtml}
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          onBlur={commitHtml}
          spellCheck={false}
          rows={4}
        />
        <button className={s.copyBtn} onClick={copy}>Copy snippet</button>
      </div>
      <button
        className={s.deleteBtn}
        onClick={() => removeComponent(component.id)}
        aria-label="Delete component"
      >
        ×
      </button>
    </div>
  );
}
