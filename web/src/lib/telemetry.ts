/* telemetry.ts — local-only event log, mirroring Omelette's TrackEvent shape.
 *
 *   trackEvent("project_open", { in_editor: "true" })
 *
 * Writes to a localStorage ring buffer (last 200 events) and
 * console.debug. Useful for self-debugging — open DevTools and call
 * `getRecentEvents()` to dump.
 *
 * Wrap in `if (getFlag("telemetry"))` if you want a kill switch.
 */

import { getFlag } from "./flags";

export type TrackedEvent = {
  event_name: string;
  properties: Record<string, string>;
  project_id_hash?: string;
  ts: number;
};

const KEY = "telemetry";
const MAX = 200;

function read(): TrackedEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TrackedEvent[]) : [];
  } catch { return []; }
}

function write(events: TrackedEvent[]) {
  try { localStorage.setItem(KEY, JSON.stringify(events.slice(-MAX))); } catch { /* ignore */ }
}

// 32-bit FNV-1a → 8 hex chars (matches Omelette's project_id_hash format).
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function trackEvent(
  event_name: string,
  properties: Record<string, string> = {},
  projectId?: string
) {
  if (!getFlag("telemetry")) return;
  const ev: TrackedEvent = {
    event_name,
    properties,
    project_id_hash: projectId ? shortHash(projectId) : undefined,
    ts: Date.now(),
  };
  const next = [...read(), ev];
  write(next);
  if (typeof console !== "undefined" && console.debug) {
    console.debug("[telemetry]", event_name, properties);
  }
}

export function getRecentEvents(): TrackedEvent[] {
  return read();
}

export function clearEvents() {
  write([]);
}

if (typeof window !== "undefined") {
  // Expose on global for DevTools convenience.
  (window as unknown as { trackEvent?: typeof trackEvent }).trackEvent = trackEvent;
  (window as unknown as { getRecentEvents?: typeof getRecentEvents }).getRecentEvents = getRecentEvents;
}
