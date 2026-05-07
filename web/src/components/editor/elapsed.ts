/* elapsed.ts — small helpers for formatting in-flight stream time.
 * Pulled out so the rendering hook stays clean and the format logic
 * can be unit-tested without mounting React. */

/** Format a duration in seconds as a chat-friendly string.
 *
 * Under a minute  → `12.3s` (one decimal, sub-second precision matters
 *                  while staring at a fresh stream).
 * One minute+     → `1m 04s` (whole seconds, zero-padded for stable
 *                  width so the timer doesn't dance around).
 *
 * Negative inputs clamp to zero so a clock skew never renders a
 * meaningless `-0.5s`. */
export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, seconds);
  if (safe < 60) return `${safe.toFixed(1)}s`;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${m}m ${s}s`;
}

/** Threshold past which we surface a "still working" hint. Tuned long
 *  enough that fast turns never trigger it, short enough that a stuck
 *  stream becomes visible before the user wonders. */
export const SLOW_RUN_THRESHOLD_MS = 12_000;

/** Tick interval for the live timer. 200ms keeps the readout feeling
 *  alive without flooring the framerate. */
export const ELAPSED_TICK_MS = 200;
