/* CommentPins.tsx — overlay numbered pins on the iframe.
 *
 * Pins are anchored to their actual elements via the stored CSS selector.
 * At render we query the iframe doc for the element and position the pin
 * at its top-right corner so it tracks layout shifts (responsive moves,
 * content edits, etc.) — just like Figma comments. If the element can't
 * be found we fall back to the stored x/y so old comments still show up.
 */

import { useEffect, useRef, useState } from "react";
import s from "./pins.module.css";
import { useComments, type LocalComment } from "../../lib/comments";

type Props = {
  projectId: string;
  file: string;
  zoom: number;
  /** display=frame applies zoom; display=fill renders 1:1. */
  scaleByZoom: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Reference to the live iframe — used to compute its offset. */
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
};

export function CommentPins({ projectId, file, zoom, scaleByZoom, selectedId, onSelect, iframeRef }: Props) {
  const all = useComments(projectId);
  const items = all.filter((c) => c.file === file);
  const layerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const bump = () => force((n) => n + 1);
  // Iframe content scroll. Used as fallback when an element can't be
  // resolved by selector and we need to map stored x/y → screen px.
  const [scroll, setScroll] = useState({ x: 0, y: 0 });

  // Re-render when the layout shifts (window resize / sidebar toggle / zoom).
  useEffect(() => {
    const onResize = () => bump();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    if (layerRef.current) ro.observe(layerRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  }, []);
  useEffect(() => { bump(); }, [zoom, items.length]);

  // Track iframe scroll + observe iframe body so pins stay glued to their
  // anchor elements across scroll, content edits, and responsive layout
  // changes. The iframe identity changes when the user switches files,
  // so re-attach on `file`. We also re-attach on `load` because
  // contentWindow becomes a fresh window after navigation.
  //
  // We listen for scroll in CAPTURE phase on the document so we catch
  // scroll events from ANY nested scrollable ancestor — some pages
  // (e.g. canvas-style HTML with horizontally panning containers) don't
  // actually scroll the window, only an inner element. Same reason we
  // also run a low-rate rAF loop while pins are mounted: transform-based
  // panning emits no scroll events at all.
  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    let detach: (() => void) | null = null;
    const attach = () => {
      const win = ifr.contentWindow;
      const doc = ifr.contentDocument;
      if (!win || !doc) return;
      const onScroll = () => {
        setScroll({ x: win.scrollX, y: win.scrollY });
        bump();
      };
      onScroll();
      win.addEventListener("scroll", onScroll, { passive: true });
      doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
      const ro = doc.body ? new ResizeObserver(() => bump()) : null;
      if (ro && doc.body) ro.observe(doc.body);
      const mo = doc.body
        ? new MutationObserver(() => bump())
        : null;
      if (mo && doc.body) {
        mo.observe(doc.body, {
          attributes: true,
          attributeFilter: ["style", "class", "transform"],
          subtree: true,
        });
      }
      detach = () => {
        win.removeEventListener("scroll", onScroll);
        doc.removeEventListener("scroll", onScroll, { capture: true } as any);
        ro?.disconnect();
        mo?.disconnect();
      };
    };
    attach();
    const onLoad = () => { detach?.(); detach = null; attach(); };
    ifr.addEventListener("load", onLoad);
    return () => {
      detach?.();
      ifr.removeEventListener("load", onLoad);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // rAF safety-net: some pages animate position via CSS transforms that
  // emit neither scroll nor mutation events. We snapshot pin positions
  // each frame and only force a render when they actually change, so
  // the loop is cheap when nothing's moving.
  useEffect(() => {
    if (items.length === 0) return;
    let raf = 0;
    let prev = "";
    const tick = () => {
      const ifr = iframeRef.current;
      const doc = ifr?.contentDocument ?? null;
      let snap = "";
      if (doc) {
        for (const c of items) {
          if (!c.selector) continue;
          try {
            const el = doc.querySelector(c.selector) as HTMLElement | null;
            if (el) {
              const r = el.getBoundingClientRect();
              snap += `${c.id}:${r.left.toFixed(1)},${r.top.toFixed(1)};`;
            }
          } catch { /* skip */ }
        }
      }
      if (snap !== prev) {
        prev = snap;
        bump();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, file]);

  if (items.length === 0) return null;
  const k = scaleByZoom ? zoom : 1;
  const ifr = iframeRef.current;
  const ifrRect = ifr?.getBoundingClientRect();
  const layerRect = layerRef.current?.getBoundingClientRect();
  const offsetX = ifrRect && layerRect ? ifrRect.left - layerRect.left : 0;
  const offsetY = ifrRect && layerRect ? ifrRect.top - layerRect.top : 0;
  const doc = ifr?.contentDocument ?? null;

  const posFor = (c: LocalComment): { x: number; y: number } | null => {
    // Element-anchored: query the iframe doc for the saved selector.
    // getBoundingClientRect already accounts for iframe scroll, so we
    // just scale by zoom and add the canvas offset.
    if (doc && c.selector) {
      try {
        const el = doc.querySelector(c.selector) as HTMLElement | null;
        if (el) {
          const r = el.getBoundingClientRect();
          // Top-right corner of the element; the pin centers on this
          // point via translate(-50%, -50%) in CSS, so it sits right
          // on the corner like Figma.
          return {
            x: offsetX + r.right * k,
            y: offsetY + r.top * k,
          };
        }
      } catch { /* invalid selector — fall through */ }
    }
    // Fallback: stored xy in iframe-content coords.
    if (c.x == null || c.y == null) return null;
    return {
      x: offsetX + (c.x - scroll.x) * k,
      y: offsetY + (c.y - scroll.y) * k,
    };
  };

  return (
    <div ref={layerRef} className={s.pinsLayer}>
      {items.map((c, i) => {
        const p = posFor(c);
        if (!p) return null;
        return (
          <Pin
            key={c.id}
            n={i + 1}
            c={c}
            x={p.x}
            y={p.y}
            selected={c.id === selectedId}
            onSelect={() => onSelect(c.id === selectedId ? null : c.id)}
          />
        );
      })}
    </div>
  );
}

function Pin({
  n, c, x, y, selected, onSelect,
}: {
  n: number;
  c: LocalComment;
  x: number;
  y: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`${s.pin} ${selected ? s.pinSelected : ""} ${
        c.resolved ? s.pinResolved : c.promoted ? s.pinPromoted : ""
      }`}
      style={{ left: x, top: y }}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      title={c.body.slice(0, 80)}
    >
      {n}
    </button>
  );
}
