/* drawings.ts — per-route freehand strokes drawn on top of the iframe.
 *
 * Coordinates are stored in iframe-content px (zoom-invariant), like
 * comment pins, so strokes survive zoom changes and viewport switches.
 *
 * Storage key: "drawings.v1"
 *   Record<route, Stroke[]>
 */

import { useEffect, useState } from "react";

export type Point = { x: number; y: number };

export type Stroke = {
  id: string;
  color: string;
  width: number;
  points: Point[];
  ts: number;
};

const KEY = "drawings.v1";

function uuid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function readAll(): Record<string, Stroke[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, Stroke[]>) : {};
  } catch { return {}; }
}

function writeAll(all: Record<string, Stroke[]>) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("drawings:change"));
  }
}

export function listStrokes(route: string): Stroke[] {
  return readAll()[route] ?? [];
}

export function addStroke(route: string, stroke: Omit<Stroke, "id" | "ts">): Stroke {
  const all = readAll();
  const next: Stroke = { ...stroke, id: uuid(), ts: Date.now() };
  all[route] = [...(all[route] ?? []), next];
  writeAll(all);
  return next;
}

export function clearStrokes(route: string) {
  const all = readAll();
  delete all[route];
  writeAll(all);
}

export function popStroke(route: string): Stroke | null {
  const all = readAll();
  const list = all[route] ?? [];
  if (list.length === 0) return null;
  const last = list[list.length - 1];
  all[route] = list.slice(0, -1);
  writeAll(all);
  return last;
}

export function useStrokes(route: string): Stroke[] {
  const [items, setItems] = useState<Stroke[]>(() => listStrokes(route));
  useEffect(() => {
    const refresh = () => setItems(listStrokes(route));
    refresh();
    window.addEventListener("drawings:change", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("drawings:change", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [route]);
  return items;
}

/** Flatten strokes onto a base image (an iframe screenshot) and return a
 *  single PNG data URL. Strokes are stored in iframe-local pixels and
 *  the screenshot is captured at iframe-local resolution, so coordinates
 *  match directly — no scaling needed.
 *
 *  Used by Draw mode's "Send" action: hand the AI the composite as a
 *  single attachment so it sees what the user drew on top of the page. */
export async function compositeStrokesOnto(
  baseDataUrl: string,
  strokes: Stroke[],
): Promise<string> {
  const img = new Image();
  img.src = baseDataUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to decode base screenshot"));
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x, s.points[i].y);
    }
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

/** Convert a list of points to an SVG path "d" attribute using quadratic
 *  curves between midpoints — gives a much smoother stroke than polyline. */
export function pointsToPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x + 0.01} ${p.y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    d += ` Q ${a.x} ${a.y} ${mx} ${my}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}
