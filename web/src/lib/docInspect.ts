/* docInspect.ts — collect document-wide colors and fonts from an iframe.
 *
 * Mirrors what Omelette's DM.getDocumentColors / getDocumentFonts do:
 * walk every element, read the computed style for color, background-
 * color, fill, and font-family, dedupe, and return ordered lists.
 */

export type ColorUsage = { color: string; count: number };
export type FontUsage = { family: string; count: number };

function rgbToHex(rgb: string): string | null {
  if (!rgb) return null;
  if (rgb === "transparent" || rgb === "rgba(0, 0, 0, 0)") return null;
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  const [, r, g, b, a] = m;
  if (a !== undefined && Number(a) === 0) return null;
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function firstFont(family: string): string {
  if (!family) return "";
  return family.split(",")[0].replace(/^["']|["']$/g, "").trim();
}

export function getDocumentColors(doc: Document, max = 24): ColorUsage[] {
  const counts = new Map<string, number>();
  const all = doc.querySelectorAll("*");
  for (let i = 0; i < all.length && i < 5000; i++) {
    const el = all[i];
    const cs = doc.defaultView?.getComputedStyle(el);
    if (!cs) continue;
    for (const prop of ["color", "backgroundColor"]) {
      const hex = rgbToHex((cs as unknown as Record<string, string>)[prop]);
      if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([color, count]) => ({ color, count }));
}

export function getDocumentFonts(doc: Document, max = 12): FontUsage[] {
  const counts = new Map<string, number>();
  const all = doc.querySelectorAll("*");
  for (let i = 0; i < all.length && i < 5000; i++) {
    const el = all[i];
    const cs = doc.defaultView?.getComputedStyle(el);
    if (!cs) continue;
    const family = firstFont(cs.fontFamily);
    if (!family) continue;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([family, count]) => ({ family, count }));
}
