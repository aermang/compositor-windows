// Blend-mode engine: the 16 modes Canvas 2D composites natively, plus the per-pixel
// path for the 8 Photoshop modes Chromium has no globalCompositeOperation for.
// Straight (non-premultiplied) RGBA math, matching Photoshop's separable blends.

import type { BlendMode } from './types';

const EXOTIC: ReadonlySet<BlendMode> = new Set([
  'Linear Burn', 'Linear Dodge (Add)', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix',
  'Subtract', 'Divide',
] as const);

export function isExoticBlend(mode: BlendMode): boolean {
  return EXOTIC.has(mode);
}

/** Blend function on 0-1 non-premultiplied values; returns the blended channel. */
type SepFn = (b: number, s: number) => number;

const f: Record<string, SepFn> = {
  'Linear Burn': (b, s) => b + s - 1,
  'Linear Dodge (Add)': (b, s) => b + s,
  'Vivid Light': (b, s) => s < 0.5 ? 1 - (1 - b) / (2 * s + 1e-6) : b / (2 * (1 - s) + 1e-6),
  'Linear Light': (b, s) => b + 2 * s - 1,
  'Pin Light': (b, s) => s < 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
  Subtract: (b, s) => b - s,
  Divide: (b, s) => s <= 0 ? 1 : Math.min(1, b / s),
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Blend `src` over `dst` with the given mode, alpha and opacity, in place on `src`'s
 * pixels. Both are straight RGBA8. Used when a layer's blend mode has no canvas
 * equivalent: the compositor snapshots the backdrop, then calls this.
 */
export function pixelBlend(
  dst: Uint8ClampedArray, src: Uint8ClampedArray, mode: BlendMode, opacity: number,
) {
  if (mode === 'Hard Mix') {
    // thresholded Vivid Light
    const vf = f['Vivid Light'];
    for (let i = 0; i < src.length; i += 4) {
      blendPixel(dst, src, i, (b, s) => (vf(b, s) >= 0.5 ? 1 : 0), opacity);
    }
    return;
  }
  const fn = f[mode];
  if (!fn) return;
  for (let i = 0; i < src.length; i += 4) {
    blendPixel(dst, src, i, fn, opacity);
  }
}

function blendPixel(dst: Uint8ClampedArray, src: Uint8ClampedArray, i: number, fn: SepFn, opacity: number) {
  const sa = (src[i + 3] / 255) * opacity;
  const da = dst[i + 3] / 255;
  if (sa <= 0) return;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) { dst[i + 3] = 0; return; }
  for (let c = 0; c < 3; c++) {
    const b = da > 0 ? dst[i + c] / 255 : 0; // straight backdrop color; 0 where transparent
    const s = src[i + c] / 255;
    const blended = clamp01(fn(b, s));
    // standard over: result color mixes backdrop and blend by source alpha
    const out = (blended * sa + b * da * (1 - sa)) / outA;
    dst[i + c] = out * 255;
  }
  dst[i + 3] = outA * 255;
}
