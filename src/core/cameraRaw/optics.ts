// Camera Raw pipeline stage 8 (optics): chromatic aberration removal,
// distortion, purple/green defringe, lens vignetting. CA and distortion are
// inverse-map bilinear resamples; `scale` shrinks pixel shifts on previews.

import type { CameraRawSettings } from './settings';
import { clamp01, clampN, luma709, rgbToHslInto } from './hsl';

/** Bilinear sample of one channel with clamped edges. */
function sampleChannel(
  src: Uint8ClampedArray, w: number, h: number, x: number, y: number, ch: number,
): number {
  x = clampN(x, 0, w - 1);
  y = clampN(y, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4 + ch;
  const i10 = (y0 * w + x1) * 4 + ch;
  const i01 = (y1 * w + x0) * 4 + ch;
  const i11 = (y1 * w + x1) * 4 + ch;
  const top = src[i00] * (1 - fx) + src[i10] * fx;
  const bot = src[i01] * (1 - fx) + src[i11] * fx;
  return top * (1 - fy) + bot * fy;
}

/** Radial CA shift: red sampled inward, blue outward. */
function applyChromaticAberration(img: ImageData, scale: number): void {
  const { width: w, height: h, data: px } = img;
  const src = new Uint8ClampedArray(px);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const halfDiag = Math.sqrt((w / 2) * (w / 2) + (h / 2) * (h / 2));
  for (let y = 0; y < h; y++) {
    const ny = (y - cy) / halfDiag;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src[i + 3] === 0) continue;
      const nx = (x - cx) / halfDiag;
      const radial = Math.sqrt(nx * nx + ny * ny);
      if (radial < 1e-6) continue;
      const shift = 0.45 * radial * radial * 2.5 * scale;
      const dx = (nx / radial) * shift;
      const dy = (ny / radial) * shift;
      px[i] = sampleChannel(src, w, h, x - dx, y - dy, 0);
      px[i + 2] = sampleChannel(src, w, h, x + dx, y + dy, 2);
    }
  }
}

/** Barrel (k<0) / pincushion (k>0) distortion via inverse-map resample of r². */
function applyDistortion(img: ImageData, k: number): void {
  const { width: w, height: h, data: px } = img;
  const src = new Uint8ClampedArray(px);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const hw = w / 2, hh = h / 2;
  for (let y = 0; y < h; y++) {
    const ny = (y - cy) / hh;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nx = (x - cx) / hw;
      const r2 = nx * nx + ny * ny;
      const f = 1 + k * r2;
      const sx = cx + nx * f * hw;
      const sy = cy + ny * f * hh;
      px[i] = sampleChannel(src, w, h, sx, sy, 0);
      px[i + 1] = sampleChannel(src, w, h, sx, sy, 1);
      px[i + 2] = sampleChannel(src, w, h, sx, sy, 2);
      px[i + 3] = sampleChannel(src, w, h, sx, sy, 3);
    }
  }
}

/** Defringe: hue window → pull channels toward luma by amount·saturation. */
function applyDefringe(img: ImageData, s: CameraRawSettings): void {
  const pa = s.optics.defringePurple.amount / 100; // hue window 270–310
  const ga = s.optics.defringeGreen.amount / 100; // hue window 60–120
  if (pa <= 0 && ga <= 0) return;
  const px = img.data;
  const hsl = new Float32Array(3);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    rgbToHslInto(r, g, b, hsl);
    const hueDeg = hsl[0] * 360;
    let f = 1;
    if (pa > 0 && hueDeg >= 270 && hueDeg <= 310) f = 1 - pa * hsl[1];
    else if (ga > 0 && hueDeg >= 60 && hueDeg <= 120) f = 1 - ga * hsl[1];
    if (f >= 1) continue;
    const y = luma709(r, g, b);
    px[i] = clamp01(y + (r - y) * f) * 255;
    px[i + 1] = clamp01(y + (g - y) * f) * 255;
    px[i + 2] = clamp01(y + (b - y) * f) * 255;
  }
}

/** Lens vignette: dist⁴ falloff converted to exposure stops. */
function applyLensVignette(img: ImageData, a: number, midpoint: number): void {
  const { width: w, height: h, data: px } = img;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const halfDiag = Math.sqrt((w / 2) * (w / 2) + (h / 2) * (h / 2));
  const midFactor = 1 + (50 - midpoint) / 100;
  const mag = Math.pow(Math.abs(a), 1.15) * 1.98;
  const sign = a < 0 ? -1 : 1;
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] === 0) continue;
      const dx = x - cx;
      const dist = (Math.sqrt(dx * dx + dy * dy) / halfDiag) * midFactor;
      const stops = sign * mag * Math.pow(Math.max(dist, 0), 4.3);
      const f = Math.pow(2, stops);
      px[i] *= f;
      px[i + 1] *= f;
      px[i + 2] *= f;
    }
  }
}

export function applyOptics(img: ImageData, s: CameraRawSettings, verScale: number, scale: number): void {
  const op = s.optics;
  if (op.removeCA) applyChromaticAberration(img, scale);
  const k = (op.distortion * verScale) / 100;
  if (k !== 0) applyDistortion(img, k);
  applyDefringe(img, s);
  const lva = (op.lensVignette.amount * verScale) / 100;
  if (lva !== 0) applyLensVignette(img, lva, op.lensVignette.midpoint);
}
