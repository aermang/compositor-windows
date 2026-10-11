// Camera Raw pipeline stages 2–6 (per-pixel color work), ported in the
// original's exact order: calibration shadow tint → tone/color formula pass →
// parametric + point curves + refine saturation → HSL mixer → color grading.
// ImageData is straight RGBA; alpha=0 pixels are skipped by every stage.

import type { CameraRawSettings, CameraRawPointCurvePoint } from './settings';
import {
  clamp01, lerp, luma709, hueDistanceDeg, hslToRgb, linearToSrgb,
  monotoneSplineSamples, rgbToHslInto, hslToRgbInto, scaleLuminanceInto,
  smoothstep, srgbToLinear,
} from './hsl';

// ---------- stage 2: calibration shadow tint (HSL, l < 0.35) ----------

export function applyCalibrationShadowTint(img: ImageData, s: CameraRawSettings, verScale: number): void {
  const st = (s.calibration.shadowTint * verScale) / 100;
  if (st === 0) return;
  const shift = st * 0.06; // turns of hue at full weight
  const px = img.data;
  const hsl = new Float32Array(3);
  const rgb = new Float32Array(3);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    rgbToHslInto(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, hsl);
    // smooth 0.10-wide fade around the l = 0.35 cutoff (avoids banding)
    const w = clamp01((0.35 - hsl[2]) / 0.1);
    if (w <= 0 || hsl[1] <= 0) continue;
    let h = hsl[0] + shift * w;
    h -= Math.floor(h);
    hslToRgbInto(h, hsl[1], hsl[2], rgb);
    px[i] = rgb[0] * 255;
    px[i + 1] = rgb[1] * 255;
    px[i + 2] = rgb[2] * 255;
  }
}

// ---------- stage 3: tone/color formula pass (single loop) ----------

export function applyToneColor(img: ImageData, s: CameraRawSettings, verScale: number): void {
  const li = s.light;
  const co = s.color;
  const temp = (co.temperature * verScale) / 100;
  const tint = (co.tint * verScale) / 100;
  const contrast = (li.contrast * verScale) / 100;
  const highlights = (li.highlights * verScale) / 100;
  const shadows = (li.shadows * verScale) / 100;
  const whites = (li.whites * verScale) / 100;
  const blacks = (li.blacks * verScale) / 100;
  const saturation = (co.saturation * verScale) / 100;
  const vibrance = (co.vibrance * verScale) / 100;
  const exposure = li.exposure;
  if (exposure === 0 && temp === 0 && tint === 0 && contrast === 0 && highlights === 0 &&
    shadows === 0 && whites === 0 && blacks === 0 && saturation === 0 && vibrance === 0) return;

  // exposure + WB share one per-channel LUT: decode sRGB → linear, ×2^exposure,
  // ×channel gain, re-encode. LUTs store 0..1.
  const stops = Math.pow(2, exposure);
  const gainR = Math.max(0.05, 1 + temp / 200);
  const gainG = Math.max(0.05, 1 + tint / 300);
  const gainB = Math.max(0.05, 1 - temp / 200);
  const lutR = new Float32Array(256);
  const lutG = new Float32Array(256);
  const lutB = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const lin = srgbToLinear(i / 255);
    lutR[i] = clamp01(linearToSrgb(lin * stops * gainR));
    lutG[i] = clamp01(linearToSrgb(lin * stops * gainG));
    lutB[i] = clamp01(linearToSrgb(lin * stops * gainB));
  }

  const kPos = Math.min(1, Math.max(0, contrast));
  const kNegSlope = Math.max(0.05, 1 + Math.min(0, contrast));
  const applyContrast = (x: number): number =>
    contrast >= 0
      ? x + (x * x * (3 - 2 * x) - x) * kPos // smoothstep S-curve blend
      : 0.5 + (x - 0.5) * kNegSlope; // slope reduction toward 0.5
  const whitePoint = Math.max(0.25, 1 - whites / 2); // whites −1..1 → wp 0.5..1.5
  const blackPoint = blacks / 2; // blacks −1..1 → bp −0.5..0.5

  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    let r = lutR[px[i]];
    let g = lutG[px[i + 1]];
    let b = lutB[px[i + 2]];
    r = applyContrast(r);
    g = applyContrast(g);
    b = applyContrast(b);
    let y = luma709(r, g, b);
    if (highlights !== 0) {
      const w = smoothstep(0.5, 1, y);
      const d = highlights * 0.3 * w;
      r += d; g += d; b += d;
    }
    if (shadows !== 0) {
      const w = 1 - smoothstep(0, 0.5, y);
      const d = shadows * 0.3 * w;
      r += d; g += d; b += d;
    }
    if (whites !== 0) {
      r /= whitePoint; g /= whitePoint; b /= whitePoint;
    }
    if (blacks !== 0) {
      const q = 1 - blackPoint;
      r = blackPoint + r * q; g = blackPoint + g * q; b = blackPoint + b * q;
    }
    if (saturation !== 0 || vibrance !== 0) {
      y = luma709(r, g, b);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const satPix = (mx - mn) / (mx + mn + 1e-4);
      const f = 1 + saturation + vibrance * (1 - satPix);
      r = y + (r - y) * f;
      g = y + (g - y) * f;
      b = y + (b - y) * f;
    }
    px[i] = clamp01(r) * 255;
    px[i + 1] = clamp01(g) * 255;
    px[i + 2] = clamp01(b) * 255;
  }
}

// ---------- stage 4: curves ----------

/** Piecewise bend below a divider: div·(t/div)^(2^(−slider/100·1.66)). */
function bendLow(t: number, div: number, slider: number): number {
  if (div <= 0 || t >= div) return t;
  const e = Math.pow(2, (-slider / 100) * 1.66);
  return div * Math.pow(t / div, e);
}

/** Piecewise bend above a divider: 1−(1−div)·((1−t)/(1−div))^(2^(slider/100·1.66)). */
function bendHigh(t: number, div: number, slider: number): number {
  if (div >= 1 || t <= div) return t;
  const e = Math.pow(2, (slider / 100) * 1.66);
  return 1 - (1 - div) * Math.pow((1 - t) / (1 - div), e);
}

function buildParametricCurveLut(cu: CameraRawSettings['curve'], verScale: number): Float32Array | null {
  const sh = cu.shadows * verScale;
  const da = cu.darks * verScale;
  const li = cu.lights * verScale;
  const hi = cu.highlights * verScale;
  if (sh === 0 && da === 0 && li === 0 && hi === 0) return null;
  const spl = cu.shadowSplit / 100;
  const dpl = cu.darkSplit / 100;
  const lpl = cu.lightSplit / 100;
  // nested: shadows/highlights against their splits, then darks/lights around
  // the dark split; evaluated over 33 anchors and smoothed with a monotone spline
  const f = (t: number): number =>
    bendHigh(bendLow(bendHigh(bendLow(t, spl, sh), lpl, hi), dpl, da), dpl, li);
  const anchors: CameraRawPointCurvePoint[] = [];
  for (let i = 0; i <= 32; i++) anchors.push({ x: i / 32, y: clamp01(f(i / 32)) });
  return monotoneSplineSamples(anchors, 256);
}

/** Point curve ({x,y} 0..1, sorted) → 256-entry LUT with linear interpolation. */
function pointCurveLut(pts: CameraRawPointCurvePoint[]): Float32Array | null {
  if (!pts.length) return null;
  const p = pts;
  const lut = new Float32Array(256);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    if (p.length === 1) {
      lut[i] = clamp01(p[0].y);
      continue;
    }
    while (j < p.length - 2 && p[j + 1].x < x) j++;
    if (x <= p[0].x) lut[i] = clamp01(p[0].y);
    else if (x >= p[p.length - 1].x) lut[i] = clamp01(p[p.length - 1].y);
    else {
      const a = p[j];
      const b = p[j + 1];
      const t = (x - a.x) / Math.max(1e-9, b.x - a.x);
      lut[i] = clamp01(a.y + (b.y - a.y) * t);
    }
  }
  return lut;
}

/** Compose byte→0..1 LUTs into a single 256-entry LUT, or null if all identity. */
function composeCurveLuts(luts: (Float32Array | null)[]): Float32Array | null {
  const chain = luts.filter((l): l is Float32Array => l !== null);
  if (chain.length === 0) return null;
  const out = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    for (const l of chain) v = l[Math.min(255, Math.round(v * 255))];
    out[i] = v;
  }
  return out;
}

export function applyCurvesStage(img: ImageData, s: CameraRawSettings, verScale: number): void {
  const cu = s.curve;
  const param = buildParametricCurveLut(cu, verScale);
  const pRgb = pointCurveLut(cu.pointRgb);
  const pR = pointCurveLut(cu.pointRed);
  const pG = pointCurveLut(cu.pointGreen);
  const pB = pointCurveLut(cu.pointBlue);
  const rs = (cu.refineSaturation * verScale) / 100;
  // rgb tone (parametric then rgb point) first, then per-channel curves
  const lutR = composeCurveLuts([param, pRgb, pR]);
  const lutG = composeCurveLuts([param, pRgb, pG]);
  const lutB = composeCurveLuts([param, pRgb, pB]);
  if (!lutR && !lutG && !lutB && rs === 0) return;

  const px = img.data;
  const rgb = new Float32Array(3);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r0 = px[i] / 255, g0 = px[i + 1] / 255, b0 = px[i + 2] / 255;
    let r = lutR ? lutR[px[i]] : r0;
    let g = lutG ? lutG[px[i + 1]] : g0;
    let b = lutB ? lutB[px[i + 2]] : b0;
    if (rs !== 0) {
      const y1 = luma709(r, g, b); // pivot: post-curve luma
      const f = 1 + rs;
      const nr = y1 + (r - y1) * f;
      const ng = y1 + (g - y1) * f;
      const nb = y1 + (b - y1) * f;
      if (rs < 0) {
        // blend toward a luma-preserving version of the desaturation
        const yn = luma709(clamp01(nr), clamp01(ng), clamp01(nb));
        scaleLuminanceInto(nr, ng, nb, yn, y1, rgb);
        r = lerp(nr, rgb[0], -rs);
        g = lerp(ng, rgb[1], -rs);
        b = lerp(nb, rgb[2], -rs);
      } else {
        r = nr; g = ng; b = nb;
      }
    }
    px[i] = clamp01(r) * 255;
    px[i + 1] = clamp01(g) * 255;
    px[i + 2] = clamp01(b) * 255;
  }
}

// ---------- stage 5: HSL mixer (8 families + target points) ----------

const FAMILY_HUE_CENTERS = [0, 30, 60, 120, 180, 240, 270, 300];
const HUE_SHIFT_TURNS = 30 / 360; // full slider with full weight → 30°

export function applyMixer(img: ImageData, s: CameraRawSettings, verScale: number): void {
  const mix = s.mixer;
  const fams = FAMILY_HUE_CENTERS.map((_, f) => {
    const fam = mix.families[f];
    return {
      hue: ((fam?.hue ?? 0) * verScale) / 100,
      sat: ((fam?.saturation ?? 0) * verScale) / 100,
      lum: ((fam?.luminance ?? 0) * verScale) / 100,
    };
  });
  const pts = mix.points.map(p => ({
    hue: p.hue, sat: p.sat, lum: p.lum,
    hueRange: p.hueRange, satRange: p.satRange, lumRange: p.lumRange,
    hueShift: (p.hueShift * verScale) / 100,
    satShift: (p.satShift * verScale) / 100,
    lumShift: (p.lumShift * verScale) / 100,
  }));
  const anyFam = fams.some(f => f.hue || f.sat || f.lum);
  const anyPt = pts.some(p => p.hueShift || p.satShift || p.lumShift);
  if (!anyFam && !anyPt) return;

  const px = img.data;
  const hsl = new Float32Array(3);
  const rgb = new Float32Array(3);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    rgbToHslInto(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, hsl);
    const hueDeg = hsl[0] * 360;
    let wSum = 0, dh = 0, ds = 0, dl = 0;
    for (let f = 0; f < 8; f++) {
      const dist = hueDistanceDeg(hueDeg, FAMILY_HUE_CENTERS[f]);
      if (dist >= 40) continue;
      const w = 1 - dist / 40;
      dh += fams[f].hue * w;
      ds += fams[f].sat * w;
      dl += fams[f].lum * 0.25 * w;
      wSum += w;
    }
    for (const p of pts) {
      // separable box: circular hue window × sat window × lum window
      if (hueDistanceDeg(hueDeg, p.hue) > p.hueRange) continue;
      if (Math.abs(hsl[1] - p.sat) > p.satRange) continue;
      if (Math.abs(hsl[2] - p.lum) > p.lumRange) continue;
      dh += p.hueShift;
      ds += p.satShift;
      dl += p.lumShift * 0.25;
    }
    if (wSum > 1) {
      dh /= wSum;
      ds /= wSum;
      dl /= wSum;
    }
    let h = hsl[0] + dh * HUE_SHIFT_TURNS;
    h -= Math.floor(h);
    const sat = clamp01(hsl[1] * (1 + ds));
    const lig = clamp01(hsl[2] + dl);
    hslToRgbInto(h, sat, lig, rgb);
    px[i] = rgb[0] * 255;
    px[i + 1] = rgb[1] * 255;
    px[i + 2] = rgb[2] * 255;
  }
}

// ---------- stage 6: color grading (4 wheels) ----------

export function applyGrading(img: ImageData, s: CameraRawSettings, verScale: number): void {
  const gr = s.grading;
  const wheels = [gr.shadows, gr.midtones, gr.highlights, gr.global];
  if (wheels.every(w => w.saturation === 0 && w.luminance === 0)) return;
  const split = 0.5 - ((gr.balance * verScale) / 100) * 0.2;
  const reach = 0.12 + (gr.blending / 100) * 0.38;
  const tints = wheels.map(w => {
    const [r, g, b] = hslToRgb(w.hue / 360, 1, 0.5);
    const k = (w.saturation / 100) * 0.85;
    return [(r - 0.5) * k, (g - 0.5) * k, (b - 0.5) * k];
  });
  const lums = wheels.map(w => ((w.luminance * verScale) / 100) * 0.25);
  const weights = new Float32Array(4);

  const px = img.data;
  const rgb = new Float32Array(3);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    let r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const y = luma709(r, g, b);
    // clamped ramps, normalized to sum 1; the global wheel is always full weight
    weights[0] = clamp01((split - y) / reach);
    weights[2] = clamp01((y - split) / reach);
    weights[1] = clamp01(1 - weights[0] - weights[2]);
    weights[3] = 1;
    for (let k = 0; k < 4; k++) {
      const w = weights[k];
      if (w <= 0) continue;
      r += tints[k][0] * w;
      g += tints[k][1] * w;
      b += tints[k][2] * w;
    }
    let dy = 0;
    for (let k = 0; k < 4; k++) dy += lums[k] * weights[k];
    const y2 = luma709(r, g, b);
    scaleLuminanceInto(r, g, b, y2, y2 * (1 + dy), rgb);
    px[i] = rgb[0] * 255;
    px[i + 1] = rgb[1] * 255;
    px[i + 2] = rgb[2] * 255;
  }
}
