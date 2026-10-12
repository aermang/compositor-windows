// One-click auto adjustments (自动色调/自动对比度/自动颜色): destructive ops on
// the active layer, history-tracked via rasterEdit like the filter commands.
// All three skip fully transparent pixels (alpha=0) in both the statistics and
// the modification, matching the repo's other pixel kernels.

import { ctx2dRead } from '../canvasUtils';
import type { Layer } from '../types';
import { rasterEdit } from '../store';

const CLIP = 0.001; // 0.1% tail clip at both histogram ends

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** smallest v such that cum(v) >= th (scanning up from 0) */
function percentileLow(hist: Uint32Array, th: number): number {
  let acc = 0;
  for (let v = 0; v <= 255; v++) {
    acc += hist[v];
    if (acc >= th) return v;
  }
  return 255;
}

/** largest v such that tail(v) >= th (scanning down from 255) */
function percentileHigh(hist: Uint32Array, th: number): number {
  let acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= th) return v;
  }
  return 0;
}

interface ChannelStats { hists: [Uint32Array, Uint32Array, Uint32Array]; n: number }

function channelStats(d: Uint8ClampedArray): ChannelStats {
  const hists: [Uint32Array, Uint32Array, Uint32Array] = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    hists[0][d[i]]++; hists[1][d[i + 1]]++; hists[2][d[i + 2]]++;
    n++;
  }
  return { hists, n };
}

function lumaStats(d: Uint8ClampedArray): { hist: Uint32Array; n: number } {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    hist[luma(d[i], d[i + 1], d[i + 2]) | 0]++;
    n++;
  }
  return { hist, n };
}

/**
 * Shared driver: `plan` inspects a scratch copy of the layer pixels and returns
 * a closure that transforms a pixel buffer, or null when there is nothing to do
 * (no bitmap / no opaque pixels / degenerate range). rasterEdit gives history
 * + bumpLayerRev for free.
 */
function autoAdjust(
  layer: Layer,
  label: string,
  plan: (scratch: Uint8ClampedArray) => ((px: Uint8ClampedArray) => void) | null,
): void {
  if (!layer.bitmap) return;
  const bx = ctx2dRead(layer.bitmap);
  const scratch = bx.getImageData(0, 0, layer.bitmap.width, layer.bitmap.height);
  const apply = plan(scratch.data);
  if (!apply) return;
  rasterEdit(layer, label, bmp => {
    const ctx = ctx2dRead(bmp);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    apply(img.data);
    ctx.putImageData(img, 0, 0);
  });
}

/** 自动色调: per-channel histogram stretch (clip 0.1% tails). */
export function autoTone(layer: Layer): void {
  autoAdjust(layer, '自动色调', d => {
    const { hists, n } = channelStats(d);
    if (!n) return null;
    const th = n * CLIP;
    const luts = hists.map(hh => {
      const lo = percentileLow(hh, th);
      const hi = percentileHigh(hh, th);
      if (hi <= lo) return null; // 跳过 lo>=hi 的通道(纯色/空通道)
      const lut = new Float32Array(256);
      for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
      return lut;
    }) as [Float32Array | null, Float32Array | null, Float32Array | null];
    return px => {
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        if (luts[0]) px[i] = luts[0][px[i]];
        if (luts[1]) px[i + 1] = luts[1][px[i + 1]];
        if (luts[2]) px[i + 2] = luts[2][px[i + 2]];
      }
    };
  });
}

/** 自动对比度: luminance stretch only (no color cast correction).
 *  One [lo,hi] from the luminance histogram; every pixel's luminance is mapped
 *  through lo→0 / hi→255 and its RGB channels are scaled by the same gain, so
 *  channel ratios (hue) are preserved. */
export function autoContrast(layer: Layer): void {
  autoAdjust(layer, '自动对比度', d => {
    const { hist, n } = lumaStats(d);
    if (!n) return null;
    const th = n * CLIP;
    const lo = percentileLow(hist, th);
    const hi = percentileHigh(hist, th);
    if (hi <= lo) return null;
    const k = 255 / (hi - lo);
    return px => {
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        const L = luma(px[i], px[i + 1], px[i + 2]);
        const Lp = Math.min(255, Math.max(0, (L - lo) * k));
        const gain = L > 0.5 ? Lp / L : 0;
        px[i] = px[i] * gain;
        px[i + 1] = px[i + 1] * gain;
        px[i + 2] = px[i + 2] * gain;
      }
    };
  });
}

/** 自动颜色: neutralize color cast (gray-world style) + gentle tone stretch.
 *  Per-channel medians mr/mg/mb → target gray g=(mr+mg+mb)/3 → each channel is
 *  scaled by g/mc; then a light autoContrast (0.1% clip) in the luminance
 *  domain. */
export function autoColor(layer: Layer): void {
  autoAdjust(layer, '自动颜色', d => {
    const { hists, n } = channelStats(d);
    if (!n) return null;
    const half = n / 2;
    const med = hists.map(hh => percentileLow(hh, half));
    const g = (med[0] + med[1] + med[2]) / 3;
    const gains = med.map(m => (m > 0 ? g / m : 1));
    const gainApply = (px: Uint8ClampedArray) => {
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        px[i] = px[i] * gains[0];
        px[i + 1] = px[i + 1] * gains[1];
        px[i + 2] = px[i + 2] * gains[2];
      }
    };
    // run the gray-world pass on the scratch copy so the tone stretch is
    // planned against the color-corrected pixels
    gainApply(d);
    const { hist, n: ln } = lumaStats(d);
    let k = 0, lo = 0;
    if (ln) {
      const lth = ln * CLIP;
      lo = percentileLow(hist, lth);
      const hi = percentileHigh(hist, lth);
      if (hi > lo) k = 255 / (hi - lo);
    }
    return px => {
      gainApply(px);
      if (!k) return;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        const L = luma(px[i], px[i + 1], px[i + 2]);
        const Lp = Math.min(255, Math.max(0, (L - lo) * k));
        const gain = L > 0.5 ? Lp / L : 0;
        px[i] = px[i] * gain;
        px[i + 1] = px[i + 1] * gain;
        px[i + 2] = px[i + 2] * gain;
      }
    };
  });
}
