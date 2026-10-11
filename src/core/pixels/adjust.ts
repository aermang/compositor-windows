// Pixel adjustments ported from Compositor's C sources (AdjustPixels.c, LevelsPixels.c,
// NoisePixels.c). ImageData here is straight (non-premultiplied) RGBA8; the C originals
// worked premultiplied, so alpha handling is folded in as noted per function.

import { clamp } from '../canvasUtils';
import type { AdjustmentData, CurvePoint } from '../types';

export type Px = Uint8ClampedArray;

// ---------- Levels (LevelsPixels.c: levels_apply) ----------

export interface LevelsLut { lut: Float32Array } // 256 entries, 0-255 output

export function buildLevelsLut(r: { black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }): Float32Array {
  const lut = new Float32Array(256);
  const span = r.white - r.black;
  for (let i = 0; i < 256; i++) {
    let v: number;
    if (span <= 0) {
      v = i >= r.white ? 1 : 0;
    } else {
      v = (i - r.black) / span;
      v = clamp(v, 0, 1);
      if (r.gamma !== 1) v = Math.pow(v, 1 / r.gamma);
    }
    lut[i] = r.outputBlack + v * (r.outputWhite - r.outputBlack);
  }
  return lut;
}

export function applyLutChannels(px: Px, luts: (Float32Array | null)[]) {
  const [rgb, r, g, b] = luts;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    if (rgb) {
      px[i] = rgb[px[i]]; px[i + 1] = rgb[px[i + 1]]; px[i + 2] = rgb[px[i + 2]];
    }
    if (r) px[i] = r[px[i]];
    if (g) px[i + 1] = g[px[i + 1]];
    if (b) px[i + 2] = b[px[i + 2]];
  }
}

export function levelsApply(px: Px, ranges: { black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }[]) {
  // ranges: [RGB, R, G, B]; identity ranges build identity LUTs
  const luts = ranges.map(buildLevelsLut);
  applyLutChannels(px, [luts[0], luts[1], luts[2], luts[3]]);
}

// ---------- Histogram (LevelsPixels.c: levels_histogram) ----------

export function histogram(px: Px): { rgb: Uint32Array; luma: Uint32Array } {
  const rgb = new Uint32Array(256);
  const luma = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (!a) continue;
    rgb[px[i]]++; rgb[px[i + 1]]++; rgb[px[i + 2]]++;
    const l = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0;
    luma[l]++;
  }
  return { rgb, luma };
}

// ---------- Curves ----------

function monotoneSpline(pts: CurvePoint[]): (x: number) => number {
  const p = [...pts].sort((a, b) => a.x - b.x);
  const n = p.length;
  if (n === 1) return () => p[0].y;
  const ys = new Float32Array(n), ms = new Float32Array(n);
  for (let i = 0; i < n; i++) ys[i] = p[i].y;
  // Fritsch–Carlson tangents (monotone cubic)
  const d = new Float32Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const h = p[i + 1].x - p[i].x;
    d[i] = h > 0 ? (p[i + 1].y - p[i].y) / h : 0;
  }
  ms[0] = d[0]; ms[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) ms[i] = 0;
    else ms[i] = (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { ms[i] = 0; ms[i + 1] = 0; continue; }
    const a = ms[i] / d[i], b = ms[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      ms[i] = t * a * d[i]; ms[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= p[0].x) return p[0].y;
    if (x >= p[n - 1].x) return p[n - 1].y;
    let i = 0;
    while (i < n - 2 && x > p[i + 1].x) i++;
    const h = p[i + 1].x - p[i].x;
    const t = (x - p[i].x) / h;
    const h00 = (1 + 2 * t) * (1 - t) * (1 - t);
    const h10 = t * (1 - t) * (1 - t);
    const h01 = t * t * (3 - 2 * t);
    const h11 = t * t * (t - 1);
    return h00 * ys[i] + h10 * h * ms[i] + h01 * ys[i + 1] + h11 * h * ms[i + 1];
  };
}

export function buildCurvesLuts(channels: CurvePoint[][]): Float32Array[] {
  return channels.map(pts => {
    const f = monotoneSpline(pts.length >= 2 ? pts : [{ x: 0, y: 0 }, { x: 255, y: 255 }]);
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = clamp(f(i), 0, 255);
    return lut;
  });
}

export function curvesApply(px: Px, channels: CurvePoint[][]) {
  const luts = buildCurvesLuts(channels);
  applyLutChannels(px, luts);
}

// ---------- Exposure (ImageAdjustments.swift: sRGB → linear → exposure → gamma LUT) ----------

export function buildExposureLut(exposure: number, offset: number, gamma: number): Float32Array {
  const lut = new Float32Array(256);
  const stops = Math.pow(2, exposure);
  for (let i = 0; i < 256; i++) {
    const s = i / 255;
    const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    let v = lin * stops + offset;
    v = clamp(v, 0, 1);
    if (gamma !== 1) v = Math.pow(v, 1 / gamma);
    lut[i] = (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
  }
  return lut;
}

export function exposureApply(px: Px, exposure: number, offset: number, gamma: number) {
  const lut = buildExposureLut(exposure, offset, gamma);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]];
  }
}

// ---------- Hue / Saturation ----------

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

export function hueSatApply(
  px: Px, hueShift: number, satShift: number, lightShift: number,
  colorize: boolean, colorizeHue: number, colorizeSat: number,
) {
  const hShift = hueShift / 360;
  const sMul = 1 + satShift / 100;
  const lAdd = lightShift / 100;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    let [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    if (colorize) {
      h = colorizeHue / 360;
      s = clamp(colorizeSat / 100, 0, 1);
    } else {
      h = (h + hShift + 1) % 1;
      s = clamp(s * sMul, 0, 1);
    }
    l = clamp(l + lAdd, 0, 1);
    const [r, g, b] = hslToRgb(h, s, l);
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
}

// ---------- Gradient Map (AdjustPixels.c:17-39) ----------

export function gradientMapApply(
  px: Px, shadows: [number, number, number], highlights: [number, number, number], reversed: boolean,
) {
  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = reversed ? 1 - i / 255 : i / 255;
    for (let c = 0; c < 3; c++) {
      const lo = reversed ? highlights[c] : shadows[c];
      const hi = reversed ? shadows[c] : highlights[c];
      table[i * 3 + c] = clamp((lo + (hi - lo) * t) * 255, 0, 255);
    }
  }
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0;
    px[i] = table[lum * 3]; px[i + 1] = table[lum * 3 + 1]; px[i + 2] = table[lum * 3 + 2];
  }
}

// ---------- Film Grain (AdjustPixels.c:74-106, seeded value-noise lattice, midtone weighted) ----------

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function grainApply(px: Px, width: number, amount: number, seed: number) {
  const amp = amount * 0.6; // slider 0-100
  for (let y = 0; y < px.length / (4 * width); y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (px[i + 3] === 0) continue;
      const fx = x + 0.5, fy = y + 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = smoothstep(0, 1, fx - x0), ty = smoothstep(0, 1, fy - y0);
      const n00 = hash2(x0, y0, seed), n10 = hash2(x0 + 1, y0, seed);
      const n01 = hash2(x0, y0 + 1, seed), n11 = hash2(x0 + 1, y0 + 1, seed);
      const n = (n00 * (1 - tx) + n10 * tx) * (1 - ty) + (n01 * (1 - tx) + n11 * tx) * ty;
      const noise = (n - 0.5) * 2 * amp;
      for (let c = 0; c < 3; c++) {
        const v = px[i + c] / 255;
        // midtone weighting: full strength at 0.5, fading at the extremes
        const weight = 1 - Math.abs(v - 0.5) * 1.6;
        px[i + c] = clamp(v + noise * Math.max(0, weight), 0, 1) * 255;
      }
    }
  }
}

// ---------- Black & White (AdjustPixels.c:120-162, Photoshop's six-range model) ----------

export function blackWhiteApply(
  px: Px, reds: number, yellows: number, greens: number, cyans: number, blues: number, magentas: number,
) {
  const rW = reds / 100, yW = yellows / 100, gW = greens / 100;
  const cW = cyans / 100, bW = blues / 100, mW = magentas / 100;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // range memberships with smooth rolloffs between neighboring bands
    const rr = (max - r) * 4, gr = (max - g) * 4, br = (max - b) * 4;
    const isRed = Math.min(1, Math.max(0, 2 - Math.abs(rr)));
    const isGreen = Math.min(1, Math.max(0, 2 - Math.abs(gr)));
    const isBlue = Math.min(1, Math.max(0, 2 - Math.abs(br)));
    const isCyan = Math.min(isGreen, isBlue) * (1 - min);
    const isMagenta = Math.min(isRed, isBlue) * (1 - min);
    const isYellow = Math.min(isRed, isGreen) * (1 - min);
    const v = lum + (rW * isRed + yW * isYellow + gW * isGreen + cW * isCyan + bW * isBlue + mW * isMagenta) * 0.15;
    const out = clamp(v, 0, 1) * 255;
    px[i] = out; px[i + 1] = out; px[i + 2] = out;
  }
}

// ---------- Color Balance (AdjustPixels.c:179-206, tonal weights + luminosity preserve) ----------

export function colorBalanceApply(
  px: Px,
  s: { shadowCyanRed: number; shadowMagentaGreen: number; shadowYellowBlue: number;
       midCyanRed: number; midMagentaGreen: number; midYellowBlue: number;
       highlightCyanRed: number; highlightMagentaGreen: number; highlightYellowBlue: number;
       preserveLuminosity: boolean },
) {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    let r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const wS = Math.max(0, 1 - lum * 2.5) ** 2;
    const wH = Math.max(0, (lum - 0.55) * 2.4) ** 2;
    const wM = Math.max(0, 1 - wS - wH);
    r += (s.shadowCyanRed * wS + s.midCyanRed * wM + s.highlightCyanRed * wH) / 100 * 0.25;
    g += (s.shadowMagentaGreen * wS + s.midMagentaGreen * wM + s.highlightMagentaGreen * wH) / 100 * 0.25;
    b += (s.shadowYellowBlue * wS + s.midYellowBlue * wM + s.highlightYellowBlue * wH) / 100 * 0.25;
    if (s.preserveLuminosity) {
      const nl = 0.299 * clamp(r, 0, 1) + 0.587 * clamp(g, 0, 1) + 0.114 * clamp(b, 0, 1);
      const d = (lum - nl) * (lum > 0 ? 1 : 0);
      r += d; g += d; b += d;
    }
    px[i] = clamp(r, 0, 1) * 255; px[i + 1] = clamp(g, 0, 1) * 255; px[i + 2] = clamp(b, 0, 1) * 255;
  }
}

// ---------- Invert ----------

export function invertApply(px: Px) {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255 - px[i]; px[i + 1] = 255 - px[i + 1]; px[i + 2] = 255 - px[i + 2];
  }
}

// ---------- Add Noise (NoisePixels.c — seeded, position-stable) ----------

function noiseHash(x: number, y: number, seed: number, channel: number): number {
  let h = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + 0xc2b2ae35, 0x27d4eb2f) ^ Math.imul(seed + channel, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967295;
}

export function addNoiseApply(
  px: Px, width: number, amount: number, gaussian: boolean, monochromatic: boolean, seed: number,
) {
  const amp = amount * 2.55 / 2; // slider 0-100 → ±127 at 100
  const h = Math.max(1, Math.round(px.length / (4 * width)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (px[i + 3] === 0) continue;
      const u1 = Math.max(1e-9, noiseHash(x, y, seed, 0));
      const u2 = noiseHash(x, y, seed, 1);
      const mag = gaussian
        ? Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
        : (u1 * 2 - 1);
      if (monochromatic) {
        const n = mag * amp;
        px[i] += n; px[i + 1] += n; px[i + 2] += n;
      } else {
        for (let c = 0; c < 3; c++) {
          const uc1 = Math.max(1e-9, noiseHash(x, y, seed, 2 + c * 2));
          const uc2 = noiseHash(x, y, seed, 3 + c * 2);
          const n = gaussian ? Math.sqrt(-2 * Math.log(uc1)) * Math.cos(2 * Math.PI * uc2) : (uc1 * 2 - 1);
          px[i + c] += n * amp;
        }
      }
    }
  }
}

// ---------- Motion Blur (directional; samples spread past edges are clamped) ----------

export function motionBlurApply(px: Px, width: number, height: number, angleDeg: number, distance: number) {
  const steps = Math.max(1, Math.min(64, Math.round(distance)));
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad), dy = -Math.sin(rad);
  const src = new Uint8ClampedArray(px);
  const acc = new Float64Array(3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (src[i + 3] === 0) continue;
      acc[0] = acc[1] = acc[2] = 0;
      for (let s = 0; s < steps; s++) {
        const t = s - (steps - 1) / 2;
        const sx = clamp(Math.round(x + dx * t), 0, width - 1);
        const sy = clamp(Math.round(y + dy * t), 0, height - 1);
        const j = (sy * width + sx) * 4;
        acc[0] += src[j]; acc[1] += src[j + 1]; acc[2] += src[j + 2];
      }
      px[i] = acc[0] / steps; px[i + 1] = acc[1] / steps; px[i + 2] = acc[2] / steps;
    }
  }
}

// ---------- Dispatcher ----------

export function applyAdjustment(px: Px, width: number, height: number, adj: AdjustmentData) {
  switch (adj.kind) {
    case 'Hue/Saturation':
      hueSatApply(px, adj.hueSat.hue, adj.hueSat.saturation, adj.hueSat.lightness,
        adj.hueSat.colorize, adj.hueSat.colorizeHue, adj.hueSat.colorizeSat);
      break;
    case 'Levels':
      levelsApply(px, adj.levels.ranges);
      break;
    case 'Curves':
      curvesApply(px, adj.curves.channels);
      break;
    case 'Exposure':
      exposureApply(px, adj.exposure.exposure, adj.exposure.offset, adj.exposure.gamma);
      break;
    case 'Gradient Map':
      gradientMapApply(px, adj.gradientMap.shadows, adj.gradientMap.highlights, adj.gradientMap.reversed);
      break;
    case 'Grain':
      grainApply(px, width, adj.grain.amount, adj.grain.seed);
      break;
    case 'Invert':
      invertApply(px);
      break;
    case 'Black & White':
      blackWhiteApply(px, adj.blackWhite.reds, adj.blackWhite.yellows, adj.blackWhite.greens,
        adj.blackWhite.cyans, adj.blackWhite.blues, adj.blackWhite.magentas);
      break;
    case 'Color Balance':
      colorBalanceApply(px, adj.colorBalance);
      break;
    case 'Add Noise':
      addNoiseApply(px, width, adj.noiseAmount, adj.noiseGaussian, adj.noiseMonochromatic, adj.noiseSeed);
      break;
    case 'Motion Blur':
      motionBlurApply(px, width, height, adj.motionAngle, adj.motionDistance);
      break;
    case 'Gaussian Blur':
      // handled by the compositor via ctx.filter (spreads across the whole composite)
      break;
  }
}
