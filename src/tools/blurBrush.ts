// Blur brush: a clone stamp whose source is a one-shot pre-blurred snapshot of
// the stroke region. The Swift original blurred through CoreImage; the CSS
// canvas `filter: blur()` is the browser stand-in (quality parity is fine for
// a brush). The snapshot is taken ONCE from the pristine layer canvas — lazily
// on first use, never re-rendered — so the brush never feeds its own output
// back into the blur. renderPart() then hands out sub-rects on demand.

import { makeCanvas, ctx2d, clamp } from '../core/canvasUtils';

export interface BlurRect { x: number; y: number; w: number; h: number }

/**
 * Blur sigma in layer pixels for a brush radius given in document pixels.
 * `layerScale` is document px per layer px; `side` (optional, the layer's
 * shorter side in px) caps sigma at half of it, mirroring the Swift
 * blurSigma(radius:perPixel:side:) helper.
 */
export function blurSigma(radiusDocPx: number, layerScale: number, side = Infinity): number {
  const perPixel = layerScale > 0 ? layerScale : 1;
  return Math.min(clamp(radiusDocPx, 0.5, 50) / perPixel, side / 2);
}

export class BlurBrushSource {
  private layer: HTMLCanvasElement;
  private rect: BlurRect; // whole-pixel, layer-local
  private sigma: number;  // layer px
  private blurred: HTMLCanvasElement | null = null;

  /**
   * @param layerCanvas the pristine layer raster
   * @param rect stroke region grown by the caller by a margin of ceil(3*sigma)
   * @param sigma blur sigma already converted to layer px
   */
  constructor(layerCanvas: HTMLCanvasElement, rect: BlurRect, sigma: number) {
    this.layer = layerCanvas;
    this.rect = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    };
    this.sigma = Math.max(0, sigma);
  }

  /** The blurred snapshot, rendered exactly once. */
  private snapshot(): HTMLCanvasElement {
    if (this.blurred) return this.blurred;
    const r = this.rect;
    const c = makeCanvas(r.w, r.h);
    const ctx = ctx2d(c);
    if (this.sigma > 0) ctx.filter = `blur(${this.sigma}px)`;
    ctx.drawImage(this.layer, -r.x, -r.y);
    ctx.filter = 'none';
    this.blurred = c;
    return c;
  }

  /**
   * Sub-rect of the blurred snapshot in layer-pixel coordinates, returned as a
   * fresh w x h canvas (transparent where the request falls outside the
   * snapshot). Cheap: one small drawImage from the cached snapshot.
   */
  renderPart(x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const snap = this.snapshot();
    const out = makeCanvas(w, h);
    const ux = Math.round(x - this.rect.x);
    const uy = Math.round(y - this.rect.y);
    const sx0 = Math.max(0, ux);
    const sy0 = Math.max(0, uy);
    const sx1 = Math.min(snap.width, ux + Math.round(w));
    const sy1 = Math.min(snap.height, uy + Math.round(h));
    if (sx1 > sx0 && sy1 > sy0) {
      ctx2d(out).drawImage(
        snap,
        sx0, sy0, sx1 - sx0, sy1 - sy0,
        sx0 - ux, sy0 - uy, sx1 - sx0, sy1 - sy0,
      );
    }
    return out;
  }
}
