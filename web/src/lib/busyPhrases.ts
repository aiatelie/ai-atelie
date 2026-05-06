/* busyPhrases.ts — rotating "AI is working" status messages.
 *
 * Single-purpose: pick a phrase when a run starts, rotate to a fresh one
 * every ~5s while the run is still going. Keeps the canvas indicator
 * playful instead of a flat "AI working" — same signal, more personality.
 *
 * Picks are non-repeating within a session so the user doesn't see the
 * same line twice in a row.
 */

const PHRASES = [
  "AI is cooking",
  "Magic in progress",
  "Sprinkling pixels",
  "Stitching things together",
  "Brewing something",
  "Conjuring an artifact",
  "Painting with bytes",
  "Hatching a plan",
  "Polishing the edges",
  "Mixing the palette",
  "Wrangling the DOM",
  "Composing layers",
  "Sketching it out",
  "Threading the needle",
  "Tweaking the vibe",
  "Spinning up something",
  "Plotting coordinates",
  "Untangling the geometry",
  "Folding in details",
  "Tuning the timing",
  "Choreographing pixels",
  "Whisking up CSS",
  "Aligning the stars",
  "Loosening the grid",
];

let lastPicked = -1;

/** Returns a phrase different from the previous one. */
export function pickBusyPhrase(): string {
  if (PHRASES.length <= 1) return PHRASES[0] ?? "AI working";
  let i = Math.floor(Math.random() * PHRASES.length);
  if (i === lastPicked) i = (i + 1) % PHRASES.length;
  lastPicked = i;
  return PHRASES[i];
}
