/* DrawOverlay.tsx — freehand drawing layer over the iframe.
 *
 * Active when the editor's mode is "draw". Captures pointer paths in
 * iframe-local coords (so they survive zoom changes) and renders saved
 * strokes as SVG paths.
 */

import { useEffect, useRef, useState } from "react";
import { addStroke, pointsToPath, useStrokes, type Point, type Stroke } from "../../lib/drawings";

/* Pencil-tip cursor. White halo + dark body so it stays visible on
 * any iframe background. Hotspot at the tip (2, 22) so the drawn line
 * starts where the user expects, not at the cursor's top-left. */
const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path d="M3 21 L6 15 L15 6 L18 9 L9 18 Z" fill="#1a1a1a" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
  <path d="M3 21 L6 15 L8 17 Z" fill="#fff"/>
  <path d="M14 7 L17 10" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;
const PENCIL_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(PENCIL_SVG)}") 2 22, crosshair`;

type Props = {
  route: string;
  /** When false the overlay is purely visual — no pointer capture. */
  active: boolean;
  /** Reference to the iframe so we can map screen → iframe-local coords. */
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  /** display=frame applies zoom; display=fill renders 1:1. */
  zoom: number;
  scaleByZoom: boolean;
  color: string;
  width: number;
};

export function DrawOverlay({
  route, active, iframeRef, zoom, scaleByZoom, color, width,
}: Props) {
  const strokes = useStrokes(route);
  const [draft, setDraft] = useState<Point[] | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // Keep a sane SVG viewBox: the iframe's content size in iframe-local px.
  const ifr = iframeRef.current;
  const ifrRect = ifr?.getBoundingClientRect();
  const layerRect = layerRef.current?.getBoundingClientRect();
  const offsetX = ifrRect && layerRect ? ifrRect.left - layerRect.left : 0;
  const offsetY = ifrRect && layerRect ? ifrRect.top - layerRect.top : 0;
  const k = scaleByZoom ? zoom : 1;

  // Convert a screen-space pointer event into iframe-local px.
  const toLocal = (e: React.PointerEvent): Point | null => {
    if (!ifrRect) return null;
    return {
      x: (e.clientX - ifrRect.left) / k,
      y: (e.clientY - ifrRect.top) / k,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active) return;
    const p = toLocal(e);
    if (!p) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDraft([p]);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!active || !draft) return;
    const p = toLocal(e);
    if (!p) return;
    setDraft((cur) => (cur ? [...cur, p] : null));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!active) return;
    if (draft && draft.length > 1) {
      addStroke(route, { color, width, points: draft });
    }
    setDraft(null);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // Re-render when window resizes or sidebar toggles affect layout.
  const [, force] = useState(0);
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    if (layerRef.current) ro.observe(layerRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
    };
  }, []);
  useEffect(() => { force((n) => n + 1); }, [zoom, strokes.length]);

  // Belt-and-braces cursor application. The inline style on the overlay
  // div is supposed to be enough, but in Chrome/Safari the cursor can
  // flicker back to system default for a frame after a stroke commits
  // (the SVG re-renders all paths and the cursor briefly "loses" its
  // computed style). Mirroring the cursor onto document.body while Draw
  // mode is active gives us a stable fallback that survives those
  // re-paints — and also covers the case where a fast drag carries the
  // pointer momentarily off the overlay's bounding box.
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = PENCIL_CURSOR;
    return () => { document.body.style.cursor = prev; };
  }, [active]);

  return (
    <div
      ref={layerRef}
      className="draw-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 35,
        pointerEvents: active ? "auto" : "none",
        cursor: active ? PENCIL_CURSOR : undefined,
      }}
    >
      <svg
        width={ifrRect?.width ?? 0}
        height={ifrRect?.height ?? 0}
        style={{
          position: "absolute",
          left: offsetX,
          top: offsetY,
          pointerEvents: "none",
          // Inherit so the cursor stays a pencil even when the browser
          // momentarily considers the SVG (or one of its <path> nodes)
          // the cursor's target during a re-paint after a stroke commits.
          cursor: "inherit",
        }}
      >
        <g transform={`scale(${k})`}>
          {strokes.map((st) => (
            <StrokePath key={st.id} stroke={st} />
          ))}
          {draft && draft.length > 1 && (
            <path
              d={pointsToPath(draft)}
              fill="none"
              stroke={color}
              strokeWidth={width}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.85}
            />
          )}
        </g>
      </svg>
    </div>
  );
}

function StrokePath({ stroke }: { stroke: Stroke }) {
  return (
    <path
      d={pointsToPath(stroke.points)}
      fill="none"
      stroke={stroke.color}
      strokeWidth={stroke.width}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}
