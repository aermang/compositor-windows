// Camera Raw pipeline stage 7 (effects: texture, clarity, dehaze, glow,
// vignette, grain) and stage 9 (detail: luminance NR, color NR, sharpen).
// `scale` is the preview scale used to shrink radii so previews match exports.

import type { CameraRawSettings } from './settings';
import {
  boxBlur, clamp01, clampN, hashLattice, lerp, luma709, scaleLuminanceInto,
  selfGuidedFilter, smoothstep, valueNoise,
} from './hsl';

// ---------- shared: luma plane + alpha weights ----------

function lumaPlane(img: ImageData): { plane: Float32Array; weight: Float32Array } {
  const px = img.data;
  const n = img.width * img.height;
  const plane = new Float32Array(n);
  const weight = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = px[i + 3] / 255;
    weight[p] = a;
    if (a > 0) plane[p] = luma709(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
  }
  return { plane, weight };
}

/** Add luma detail (tone − filtered) scaled by v·k, re-embedding via scaleLuminance. */
function applyDetailField(
  img: ImageData, tone: Float32Array, filtered: Float32Array, v: number, k: number,
): void {
  const px = img.data;
  const rgb = new Float32Array(3);
  for (let p = 0, i = 0; p < tone.length; p++, i += 4) {
    if (px[i + 3] === 0) continue;
    const y = tone[p];
    const target = y + v * k * (y - filtered[p]);
    scaleLuminanceInto(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, y, target, rgb);
    px[i] = rgb[0] * 255;
    px[i + 1] = rgb[1] * 255;
    px[i + 2] = rgb[2] * 255;
  }
}

// ---------- texture / clarity (self-guided filter on the luma plane) ----------

function applyTextureClarity(img: ImageData, s: CameraRawSettings, verScale: number, scale: number): void {
  const tex = (s.effects.texture * verScale) / 100;
  const cla = (s.effects.clarity * verScale) / 100;
  if (tex === 0 && cla === 0) return;
  const w = img.width, h = img.height;
  const side = Math.max(w, h); // reference long edge (original: 1456)
  const { plane, weight } = lumaPlane(img);
  if (tex !== 0) {
    const radius = Math.max(1, (side * 8) / 1456) * scale;
    if (radius >= 0.5) {
      const filtered = selfGuidedFilter(plane, w, h, radius, 0.01, weight);
      applyDetailField(img, plane, filtered, tex, tex > 0 ? 0.6 : 0.5);
    }
  }
  if (cla !== 0) {
    const radius = Math.max(2, (side * 32) / 1456) * scale;
    if (radius >= 0.5) {
      const filtered = selfGuidedFilter(plane, w, h, radius, 0.01, weight);
      applyDetailField(img, plane, filtered, cla, cla > 0 ? 0.85 : 0.5);
    }
  }
}

// ---------- dehaze ----------

function applyDehaze(img: ImageData, s: CameraRawSettings, verScale: number): void {
  const a = (s.effects.dehaze * verScale) / 100;
  if (a === 0) return;
  const px = img.data;
  const n = img.width * img.height;
  // haze color = alpha-weighted mean of the brightest 1% by luminance
  const hist = new Uint32Array(256);
  let count = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const al = px[i + 3];
    if (al === 0) continue;
    hist[(luma709(px[i], px[i + 1], px[i + 2]) | 0)]++; // 0..255 luma
    count++;
  }
  if (count === 0) return;
  let thresh = 255;
  let cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= count * 0.99) {
      thresh = v;
      break;
    }
  }
  let hr = 0, hg = 0, hb = 0, hw = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const al = px[i + 3];
    if (al === 0) continue;
    if ((luma709(px[i], px[i + 1], px[i + 2]) | 0) < thresh) continue;
    const aw = al / 255;
    hr += (px[i] / 255) * aw;
    hg += (px[i + 1] / 255) * aw;
    hb += (px[i + 2] / 255) * aw;
    hw += aw;
  }
  if (hw <= 0) return;
  const hzR = Math.max(1e-3, hr / hw);
  const hzG = Math.max(1e-3, hg / hw);
  const hzB = Math.max(1e-3, hb / hw);
  const veil = 0.3 * Math.pow(Math.abs(a), 1.3);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    if (a >= 0) {
      const dark = Math.min(r / hzR, g / hzG, b / hzB);
      const trans = Math.max(0.5, 1 - 0.7 * a * dark);
      px[i] = clamp01((r - hzR) / trans + hzR) * 255;
      px[i + 1] = clamp01((g - hzG) / trans + hzG) * 255;
      px[i + 2] = clamp01((b - hzB) / trans + hzB) * 255;
    } else {
      px[i] = clamp01(r * (1 - veil) + hzR * veil) * 255;
      px[i + 1] = clamp01(g * (1 - veil) + hzG * veil) * 255;
      px[i + 2] = clamp01(b * (1 - veil) + hzB * veil) * 255;
    }
  }
}

// ---------- glow (diffusion / bloom / halation) ----------

function applyGlow(img: ImageData, s: CameraRawSettings, verScale: number, scale: number): void {
  const gl = s.effects.glow;
  const amt = gl.amount / 100;
  if (amt <= 0) return;
  const w = img.width, h = img.height;
  const px = img.data;
  const n = w * h;
  const range = (gl.range * verScale) / 100;
  const spread = (gl.spread * verScale) / 100;
  const warmth = gl.warmth / 100;
  const thr = clampN(0.55 + 0.4 * range, 0.05, 0.98);
  const width = Math.max(0.05, 1 - thr);
  // soft-threshold masked color planes
  const mR = new Float32Array(n), mG = new Float32Array(n), mB = new Float32Array(n);
  const weight = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = px[i + 3] / 255;
    weight[p] = a;
    if (a <= 0) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const m = smoothstep(thr, thr + width, luma709(r, g, b));
    if (m <= 0) continue;
    mR[p] = r * m;
    mG[p] = g * m;
    mB[p] = b * m;
  }
  const base = gl.style === 'diffusion' ? 5 : gl.style === 'bloom' ? 2 : 4;
  const radius = clampN(base * (1 + spread) * scale, 1, 64);
  const bR = boxBlur(mR, w, h, radius, weight);
  const bG = boxBlur(mG, w, h, radius, weight);
  const bB = boxBlur(mB, w, h, radius, weight);
  const tint = gl.style === 'halation'
    ? [1, 0.35 - 0.3 * warmth, 0.2 - 0.2 * warmth]
    : [0.75 + 0.25 * warmth, 0.6 + 0.2 * warmth, 0.75 - 0.6 * warmth];
  const gain = gl.style === 'bloom' ? 1.4 : 1.0;
  const k = amt * gain;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (px[i + 3] === 0) continue;
    px[i] = clamp01(px[i] / 255 + bR[p] * tint[0] * k) * 255;
    px[i + 1] = clamp01(px[i + 1] / 255 + bG[p] * tint[1] * k) * 255;
    px[i + 2] = clamp01(px[i + 2] / 255 + bB[p] * tint[2] * k) * 255;
  }
}

// ---------- vignette (highlight priority / color priority / paint overlay) ----------

function applyVignette(img: ImageData, s: CameraRawSettings, verScale: number): void {
  const vi = s.effects.vignette;
  const a = (vi.amount * verScale) / 100;
  if (a === 0) return;
  const w = img.width, h = img.height;
  const px = img.data;
  const roundMix = (1 - (vi.roundness * verScale) / 100) / 2;
  const start = (vi.midpoint / 100) * 0.85;
  const soft = Math.max(vi.feather / 100, 0.05);
  const hiProt = vi.highlights / 100;
  for (let y = 0; y < h; y++) {
    const ny = (2 * y) / Math.max(1, h - 1) - 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] === 0) continue;
      const nx = (2 * x) / Math.max(1, w - 1) - 1;
      const circle = Math.sqrt(nx * nx + ny * ny) / Math.SQRT2;
      const square = Math.max(Math.abs(nx), Math.abs(ny));
      const dist = circle + (square - circle) * roundMix;
      const m = smoothstep(start, start + soft, dist);
      if (m <= 0) continue;
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const y0 = luma709(r, g, b);
      let nr = r, ng = g, nb = b;
      if (vi.style === 'highlightPriority') {
        const bright = clamp01((y0 - 0.45) / 0.55);
        if (a < 0) {
          const ease = (1 - 0.3 * bright) * (1 - hiProt * bright);
          const gain = Math.exp(-5.8 * Math.pow(-a, 1.43) * m * ease);
          nr = r * gain; ng = g * gain; nb = b * gain;
        } else {
          const t = Math.pow(a, 0.85) * Math.pow(m, 1 + 1.5 * (1 - a));
          nr = r + (1 - r) * t;
          ng = g + (1 - g) * t;
          nb = b + (1 - b) * t;
        }
      } else if (vi.style === 'colorPriority') {
        const effect = a * m * 0.85;
        const satScale = 1 - 0.75 * m * Math.abs(a);
        nr = y0 + (r * (1 + effect) - y0) * satScale;
        ng = y0 + (g * (1 + effect) - y0) * satScale;
        nb = y0 + (b * (1 + effect) - y0) * satScale;
      } else {
        // paint overlay: multiply (darken) / screen (lighten) at opacity m·|a|
        const o = m * Math.abs(a);
        if (a < 0) {
          nr = r * (1 - o) + o * r * r;
          ng = g * (1 - o) + o * g * g;
          nb = b * (1 - o) + o * b * b;
        } else {
          nr = r * (1 - o) + o * (1 - (1 - r) * (1 - r));
          ng = g * (1 - o) + o * (1 - (1 - g) * (1 - g));
          nb = b * (1 - o) + o * (1 - (1 - b) * (1 - b));
        }
      }
      px[i] = clamp01(nr) * 255;
      px[i + 1] = clamp01(ng) * 255;
      px[i + 2] = clamp01(nb) * 255;
    }
  }
}

// ---------- grain ----------

function applyGrain(img: ImageData, s: CameraRawSettings, seed: number, scale: number): void {
  const gr = s.effects.grain;
  const amt = gr.amount / 100;
  if (amt <= 0) return;
  const w = img.width, h = img.height;
  const px = img.data;
  const cell = Math.max(0.25, (0.5 + (gr.size / 100) * 19.5) * scale);
  const rough = ((gr.roughness - 50) / 50) * 0.6; // per-cell amplitude jitter strength
  const amp = amt * 0.3;
  for (let y = 0; y < h; y++) {
    const fy = y / cell;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] === 0) continue;
      const fx = x / cell;
      const noise = valueNoise(seed, fx, fy);
      const jitter = rough === 0
        ? 1
        : 1 + rough * (hashLattice(Math.floor(fx), Math.floor(fy), seed, 7) * 2 - 1);
      const d = noise * amp * jitter * 255;
      px[i] += d;
      px[i + 1] += d;
      px[i + 2] += d;
    }
  }
}

// ---------- stage 7 dispatcher ----------

export function applyEffects(
  img: ImageData, s: CameraRawSettings, verScale: number, scale: number, seed: number,
): void {
  applyTextureClarity(img, s, verScale, scale);
  applyDehaze(img, s, verScale);
  applyGlow(img, s, verScale, scale);
  applyVignette(img, s, verScale);
  applyGrain(img, s, seed, scale);
}

// ---------- stage 9: detail ----------

function applyNoiseLuminance(img: ImageData, s: CameraRawSettings, verScale: number, scale: number): void {
  const nl = s.detail.noiseLuminance;
  if (nl.amount <= 0) return;
  const strength = nl.amount / 100;
  const preserve = nl.detail / 100;
  const contrast = (nl.contrast * verScale) / 100;
  const w = img.width, h = img.height;
  const { plane, weight } = lumaPlane(img);
  const blurred = boxBlur(plane, w, h, (1 + nl.amount / 50) * scale, weight);
  const px = img.data;
  const rgb = new Float32Array(3);
  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    if (px[i + 3] === 0) continue;
    const y = plane[p];
    const bb = blurred[p];
    const edge = Math.abs(y - bb);
    const local = strength * (1 - preserve * Math.min(1, edge * 6));
    const target = bb + (y - bb) * local + 0.25 * contrast * (y - bb);
    scaleLuminanceInto(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, y, target, rgb);
    px[i] = rgb[0] * 255;
    px[i + 1] = rgb[1] * 255;
    px[i + 2] = rgb[2] * 255;
  }
}

function applyNoiseColor(img: ImageData, s: CameraRawSettings, scale: number): void {
  const nc = s.detail.noiseColor;
  if (nc.amount <= 0) return;
  const strength = nc.amount / 100;
  const keep = (nc.detail / 100) * 0.6; // chroma detail blend-back
  const w = img.width, h = img.height;
  const n = w * h;
  const px = img.data;
  const dR = new Float32Array(n);
  const dB = new Float32Array(n);
  const yPlane = new Float32Array(n);
  const weight = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = px[i + 3] / 255;
    weight[p] = a;
    if (a <= 0) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const y = luma709(r, g, b);
    yPlane[p] = y;
    dR[p] = r - y;
    dB[p] = b - y;
  }
  const radius = (1.5 + strength * 4 * (0.5 + nc.smoothness / 100)) * scale;
  const bR = boxBlur(dR, w, h, radius, weight);
  const bB = boxBlur(dB, w, h, radius, weight);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (px[i + 3] === 0) continue;
    const y = yPlane[p];
    const r = y + lerp(bR[p], dR[p], keep);
    const b = y + lerp(bB[p], dB[p], keep);
    const g = (y - 0.2126 * r - 0.0722 * b) / 0.7152; // solve green from luma
    px[i] = clamp01(r) * 255;
    px[i + 1] = clamp01(g) * 255;
    px[i + 2] = clamp01(b) * 255;
  }
}

function applySharpen(img: ImageData, s: CameraRawSettings, scale: number): void {
  const sh = s.detail.sharpen;
  if (sh.amount <= 0) return;
  const det = sh.detail / 100;
  const radius = clampN((0.5 + (sh.radius / 100) * 2.5) * scale, 0.5, 64);
  const thr = (sh.masking / 100) * 0.35;
  const maskDiv = Math.max(0.04, 0.35 - thr * 0.5);
  const w = img.width, h = img.height;
  const { plane, weight } = lumaPlane(img);
  const blurred = boxBlur(plane, w, h, radius, weight);
  const stride = Math.max(1, Math.round(radius));
  const sampleLuma = (x: number, y: number, fallback: number): number => {
    const xi = clampN(Math.round(x), 0, w - 1);
    const yi = clampN(Math.round(y), 0, h - 1);
    const idx = yi * w + xi;
    return weight[idx] > 0 ? plane[idx] : fallback;
  };
  const px = img.data;
  const rgb = new Float32Array(3);
  const amount = sh.amount / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      if (px[i + 3] === 0) continue;
      const y0 = plane[p];
      const edge = (
        Math.abs(sampleLuma(x - stride, y, y0) - y0) +
        Math.abs(sampleLuma(x + stride, y, y0) - y0) +
        Math.abs(sampleLuma(x, y - stride, y0) - y0) +
        Math.abs(sampleLuma(x, y + stride, y0) - y0)
      ) / 4;
      const mask = clamp01((edge * (0.5 + det) - thr) / maskDiv);
      const target = y0 + (y0 - blurred[p]) * amount * mask * 1.9 * (0.5 + det);
      scaleLuminanceInto(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, y0, target, rgb);
      px[i] = rgb[0] * 255;
      px[i + 1] = rgb[1] * 255;
      px[i + 2] = rgb[2] * 255;
    }
  }
}

export function applyDetail(img: ImageData, s: CameraRawSettings, verScale: number, scale: number): void {
  applyNoiseLuminance(img, s, verScale, scale);
  applyNoiseColor(img, s, scale);
  applySharpen(img, s, scale);
}
