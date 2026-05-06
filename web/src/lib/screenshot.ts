/* screenshot.ts — capture an iframe document body as PNG (data URL).
 *
 * Same-origin iframes only (we control both sides, so this works). Calls
 * modern-screenshot inside the iframe's window context so styles in the
 * iframe's documentElement resolve correctly.
 */

import { domToPng, domToCanvas } from "modern-screenshot";

export type ExportFormat = "png" | "jpg" | "ograf" | "lottie" | "video";

export async function captureIframeAsDataUrl(
  iframe: HTMLIFrameElement,
  opts: { scale?: number; backgroundColor?: string; selector?: string } = {}
): Promise<string> {
  const doc = iframe.contentDocument;
  if (!doc) throw new Error("Iframe has no contentDocument");
  const target = (opts.selector
    ? (doc.querySelector(opts.selector) as HTMLElement | null)
    : null) ?? doc.body;
  return domToPng(target, {
    scale: opts.scale ?? 1,
    backgroundColor: opts.backgroundColor,
    // modern-screenshot inlines fonts, images, etc. across same-origin docs.
  });
}

/** Wait for the document's fonts + any pending <img> decodes so the
 *  capture isn't mid-load. modern-screenshot already inlines fonts/images,
 *  but it doesn't gate on the document's own fonts.ready or on
 *  img.decode() — so missing this step is a common cause of blurry text
 *  or half-loaded photos in the output. */
async function awaitDocReady(doc: Document): Promise<void> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.ready) {
    try { await fonts.ready; } catch { /* ignore */ }
  }
  const imgs = Array.from(doc.querySelectorAll("img")) as HTMLImageElement[];
  await Promise.all(imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    if (typeof img.decode === "function") return img.decode().catch(() => undefined);
    return new Promise<void>((res) => {
      img.addEventListener("load", () => res(), { once: true });
      img.addEventListener("error", () => res(), { once: true });
    });
  }));
}

/** Two-frame RAF flush: schedules a pre-capture moment that's strictly
 *  *after* the next paint commit. requestIdleCallback can fire pre-paint
 *  on busy threads; raf×2 is the agreed pattern for "wait until visible". */
function rafFlush(): Promise<void> {
  return new Promise((res) => {
    requestAnimationFrame(() => requestAnimationFrame(() => res()));
  });
}

/** Pre-resolve every <img> in the document to a data URL by drawing the
 *  *already-loaded* bitmap onto a canvas. The resulting map is fed to
 *  modern-screenshot via `fetchFn` so it never has to make a network
 *  fetch — which is the most common reason photos go missing in
 *  domToCanvas output (CORS hiccup, MIME mismatch, path-resolution
 *  off-by-one against the iframe's baseURI). Same-origin only by
 *  necessity (the canvas read taints on cross-origin without CORS).
 *
 *  Returns a Map<src, dataUrl> the caller passes through fetchFn. */
async function precomputeImageDataUrls(doc: Document): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>("img"));
  for (const img of imgs) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith("data:")) continue;
    if (!img.complete || img.naturalWidth === 0) continue;
    try {
      const canvas = doc.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      map.set(src, dataUrl);
      // currentSrc and src can differ when <picture>/srcset picks an
      // alternate; modern-screenshot's clone may serialize either, so
      // map both.
      if (img.src && img.src !== src) map.set(img.src, dataUrl);
    } catch (err) {
      // Cross-origin without CORS taints the canvas — skip; modern-
      // screenshot will fall through to its own fetch and (probably) fail
      // gracefully with a placeholder. Logged for debugging.
      console.warn("[export] could not pre-inline image", src, err);
    }
  }
  return map;
}


export async function captureElementAsDataUrl(
  el: HTMLElement,
  opts: { scale?: number; backgroundColor?: string; format?: ExportFormat; quality?: number } = {}
): Promise<string> {
  // Quality boost: gate on fonts + image decodes from the iframe's own doc
  // before kicking modern-screenshot. Otherwise a still-loading webfont
  // captures with the fallback face.
  await awaitDocReady(el.ownerDocument);

  // Inject `print-color-adjust: exact` on the capture root so any rule that
  // gated background/decoration on print-color-adjust resolves to "yes,
  // paint it" inside the SVG foreignObject. Cheap, non-invasive, restored
  // after capture.
  const prevPCA = el.style.getPropertyValue("print-color-adjust");
  const prevWebkitPCA = el.style.getPropertyValue("-webkit-print-color-adjust");
  el.style.setProperty("print-color-adjust", "exact");
  el.style.setProperty("-webkit-print-color-adjust", "exact");

  // Force one synchronous layout/style read after the style mutation, then
  // wait two animation frames so any late-arriving paints commit before
  // modern-screenshot serializes.
  void el.getBoundingClientRect();
  await rafFlush();

  try {
    const scale = opts.scale ?? 2;
    // JPG can't carry alpha — default its background to white if caller didn't pass one.
    const isJpg = opts.format === "jpg";
    const bg = opts.backgroundColor ?? (isJpg ? "#ffffff" : undefined);

    // ── Capture-then-crop ───────────────────────────────────────
    // Why not domToPng(el, …) directly? modern-screenshot's subtree
    // capture path clones the element + descendants into a foreignObject
    // SVG. With cards/banners that use absolute children, grid rows whose
    // intrinsic size doesn't roll up to the parent, or `overflow: visible`
    // wrappers, the cloned subtree re-lays-out at the element's own rect
    // and visible content gets cropped (we hit this twice in a row on a
    // banner with positioned image + footer rows).
    //
    // Body-level capture is far more reliable because there's no subtree
    // boundary — modern-screenshot is just rendering the whole document
    // exactly as the browser drew it. We then slice the resulting canvas
    // to the element's bounding rect. Same pixels the user sees, no
    // re-layout, no foreignObject sizing surprises.
    const doc = el.ownerDocument;
    const root = doc.body;
    // Pre-inline images so domToCanvas doesn't have to fetch them — the
    // browser already has the decoded bitmaps, we just hand them over as
    // data URLs via fetchFn. This is the fix for "photo missing from the
    // export" because modern-screenshot's own image fetch can fail
    // silently (CORS / MIME / path).
    const imageMap = await precomputeImageDataUrls(doc);
    const fullCanvas = await domToCanvas(root, {
      scale,
      fetchFn: async (url: string) => imageMap.get(url) ?? false,
      // No background fill at body capture — the iframe's actual root
      // background already paints. We apply `bg` only at the cropped
      // canvas step so transparent / white affects only the slice.
    });

    const elRect = el.getBoundingClientRect();
    // Translate from viewport-relative coords (what getBoundingClientRect
    // returns) into body-relative coords (the captured canvas's frame).
    // For an unscrolled iframe with body at viewport origin these match,
    // but any margin/scroll/offset on body has to be subtracted out.
    const bodyRect = root.getBoundingClientRect();
    const localX = elRect.left - bodyRect.left;
    const localY = elRect.top - bodyRect.top;
    const sx = Math.max(0, Math.floor(localX * scale));
    const sy = Math.max(0, Math.floor(localY * scale));
    const sw = Math.max(1, Math.min(fullCanvas.width - sx, Math.ceil(elRect.width * scale)));
    const sh = Math.max(1, Math.min(fullCanvas.height - sy, Math.ceil(elRect.height * scale)));

    const cropCanvas = doc.createElement("canvas");
    cropCanvas.width = sw;
    cropCanvas.height = sh;
    const ctx = cropCanvas.getContext("2d");
    if (!ctx) throw new Error("[export] could not get 2d context");
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, sw, sh);
    }
    ctx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    if (isJpg) {
      return cropCanvas.toDataURL("image/jpeg", opts.quality ?? 0.95);
    }
    return cropCanvas.toDataURL("image/png");
  } finally {
    if (prevPCA) el.style.setProperty("print-color-adjust", prevPCA);
    else el.style.removeProperty("print-color-adjust");
    if (prevWebkitPCA) el.style.setProperty("-webkit-print-color-adjust", prevWebkitPCA);
    else el.style.removeProperty("-webkit-print-color-adjust");
  }
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
