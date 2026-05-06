/* drawings.ts — per-project, per-route freehand strokes on the iframe.
 *
 * Coordinates are stored in iframe-content px (zoom-invariant), like
 * comment pins, so strokes survive zoom changes and viewport switches.
 *
 * Storage layers (same pattern as editorOverrides):
 *
 *   memory cache  — per-process Map keyed by projectId. Render hot
 *                   path (the SVG overlay) reads from here, sync.
 *   localStorage  — `drawings.v1:<projectId>`. Survives a tab reload.
 *   /api/projects/:id/meta/drawings — cross-browser source of truth.
 *                   Pushed with a 250ms debounce; pulled on first
 *                   read of each project.
 *
 * Legacy migration: previous shape was a single workspace-wide
 * `drawings.v1` key. On first read we attribute its contents to the
 * active project, write to the per-project key, and drop the legacy
 * key. Cross-project route-name collisions get absorbed into the
 * active project — known one-time loss; the legacy key already had
 * this bug.
 */

import { useEffect, useState } from "react";
import { getActiveProject } from "./projects";
import { pullMeta, pushMetaSoon } from "./projectMetaSync";

export type Point = { x: number; y: number };

export type Stroke = {
  id: string;
  color: string;
  width: number;
  points: Point[];
  ts: number;
};

const LS_PREFIX = "drawings.v1:";
const LEGACY_KEY = "drawings.v1";
const META_KEY = "drawings";

const cache = new Map<string, Record<string, Stroke[]>>();
const hydrated = new Set<string>();

function uuid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function lsKey(projectId: string): string {
  return LS_PREFIX + projectId;
}

function readLocalStorageFor(projectId: string): Record<string, Stroke[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(lsKey(projectId));
    if (raw) return JSON.parse(raw) as Record<string, Stroke[]>;
  } catch { /* ignore */ }
  // Legacy migration
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const data = JSON.parse(legacy) as Record<string, Stroke[]>;
      try {
        localStorage.setItem(lsKey(projectId), legacy);
        localStorage.removeItem(LEGACY_KEY);
      } catch { /* ignore */ }
      return data;
    }
  } catch { /* ignore */ }
  return {};
}

function writeLocalStorageFor(projectId: string, all: Record<string, Stroke[]>): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(lsKey(projectId), JSON.stringify(all)); }
  catch { /* ignore */ }
}

function getProjectId(): string {
  return getActiveProject()?.id ?? "";
}

function hydrateFromDisk(projectId: string): void {
  if (!projectId) return;
  if (hydrated.has(projectId)) return;
  hydrated.add(projectId);
  if (typeof window === "undefined") return;
  void pullMeta<Record<string, Stroke[]>>(projectId, META_KEY).then((data) => {
    if (!data || typeof data !== "object") return;
    cache.set(projectId, data);
    writeLocalStorageFor(projectId, data);
    try { window.dispatchEvent(new CustomEvent("drawings:change")); }
    catch { /* ignore */ }
  });
}

function readAll(): Record<string, Stroke[]> {
  const projectId = getProjectId();
  if (!projectId) return {};
  let data = cache.get(projectId);
  if (!data) {
    data = readLocalStorageFor(projectId);
    cache.set(projectId, data);
    hydrateFromDisk(projectId);
  }
  return data;
}

function writeAll(all: Record<string, Stroke[]>) {
  const projectId = getProjectId();
  if (!projectId) return;
  cache.set(projectId, all);
  writeLocalStorageFor(projectId, all);
  pushMetaSoon(projectId, META_KEY, all);
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
