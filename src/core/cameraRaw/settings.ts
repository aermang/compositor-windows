// Camera Raw Filter settings struct — port of the original's huge settings
// record. All values are numbers unless noted. Ranges are enforced by
// normalizeCameraRawSettings(); defaults come from defaultCameraRawSettings().

import { clampN, srgbToLinear } from './hsl';

// ---------- section types ----------

export interface CameraRawLightSettings {
  exposure: number; // −5..5, 0.01 step
  contrast: number; // −100..100
  highlights: number; // −100..100
  shadows: number; // −100..100
  whites: number; // −100..100
  blacks: number; // −100..100
}

export type CameraRawWhiteBalanceMode = 'custom' | 'auto';

export interface CameraRawColorSettings {
  whiteBalance: CameraRawWhiteBalanceMode;
  temperature: number; // −100..100
  tint: number; // −100..100
  vibrance: number; // −100..100
  saturation: number; // −100..100
}

export interface CameraRawPointCurvePoint { x: number; y: number } // 0..1

export interface CameraRawCurveSettings {
  shadows: number; // parametric −100..100
  darks: number;
  lights: number;
  highlights: number;
  shadowSplit: number; // 5..90 def 25 (kept ordered: shadow ≤ dark ≤ light)
  darkSplit: number; // def 50
  lightSplit: number; // def 75
  pointRgb: CameraRawPointCurvePoint[]; // {x,y} 0..1
  pointRed: CameraRawPointCurvePoint[];
  pointGreen: CameraRawPointCurvePoint[];
  pointBlue: CameraRawPointCurvePoint[];
  refineSaturation: number; // −100..100
}

/** One of the 8 mixer families (hue centers 0,30,60,120,180,240,270,300). */
export interface CameraRawMixerFamily {
  hue: number; // −100..100
  saturation: number;
  luminance: number;
}

export interface CameraRawMixerPoint {
  hue: number; // 0..360
  sat: number; // 0..1
  lum: number; // 0..1
  hueShift: number; // ±100
  satShift: number;
  lumShift: number;
  hueRange: number; // 5..180 def 30 (degrees)
  satRange: number; // 0.05..1 def 0.4
  lumRange: number; // def 0.4
}

export interface CameraRawMixerSettings {
  families: CameraRawMixerFamily[]; // exactly 8 after normalize
  points: CameraRawMixerPoint[]; // up to 8
}

export interface CameraRawColorWheel {
  hue: number; // 0..360
  saturation: number; // 0..100
  luminance: number; // −100..100
}

export interface CameraRawGradingSettings {
  shadows: CameraRawColorWheel;
  midtones: CameraRawColorWheel;
  highlights: CameraRawColorWheel;
  global: CameraRawColorWheel;
  blending: number; // 0..100 def 50
  balance: number; // −100..100 def 0
}

export type CameraRawGlowStyle = 'diffusion' | 'bloom' | 'halation';

export interface CameraRawGlowSettings {
  amount: number; // 0..100
  style: CameraRawGlowStyle;
  range: number; // −100..100
  spread: number; // −100..100
  warmth: number; // −100..100
}

export type CameraRawVignetteStyle = 'highlightPriority' | 'colorPriority' | 'paintOverlay';

export interface CameraRawVignetteSettings {
  amount: number; // −100..100
  style: CameraRawVignetteStyle;
  midpoint: number; // 0..100 def 50
  roundness: number; // −100..100
  feather: number; // 0..100 def 50
  highlights: number; // 0..100
}

export interface CameraRawGrainSettings {
  amount: number; // 0..100
  size: number; // 0..100 def 25
  roughness: number; // 0..100 def 50
}

export interface CameraRawEffectsSettings {
  texture: number; // −100..100
  clarity: number; // −100..100
  dehaze: number; // −100..100
  glow: CameraRawGlowSettings;
  vignette: CameraRawVignetteSettings;
  grain: CameraRawGrainSettings;
}

export interface CameraRawSharpenSettings {
  amount: number; // 0..150
  radius: number; // 0..100 def 10
  detail: number; // 0..100 def 25
  masking: number; // 0..100
}

export interface CameraRawNoiseLuminanceSettings {
  amount: number; // 0..100
  detail: number; // 0..100 def 50
  contrast: number; // −100..100
}

export interface CameraRawNoiseColorSettings {
  amount: number; // 0..100
  detail: number; // 0..100 def 50
  smoothness: number; // 0..100 def 50
}

export interface CameraRawDetailSettings {
  sharpen: CameraRawSharpenSettings;
  noiseLuminance: CameraRawNoiseLuminanceSettings;
  noiseColor: CameraRawNoiseColorSettings;
}

export interface CameraRawOpticsSettings {
  removeCA: boolean;
  distortion: number; // −100..100
  defringePurple: { amount: number }; // 0..100, hue window 270–310
  defringeGreen: { amount: number }; // 0..100, hue window 60–120
  lensVignette: { amount: number; midpoint: number }; // amount −100..100, midpoint 0..100 def 50
}

export interface CameraRawGeometrySettings {
  vertical: number; // −100..100
  horizontal: number; // −100..100
  aspect: number; // −100..100
  scale: number; // −100..100 (zoom)
  offsetX: number; // −100..100
  offsetY: number; // −100..100
  rotate: number; // −45..45 (degrees)
  constrainCrop: boolean;
}

export interface CameraRawCalibrationSettings {
  processVersion: number; // 1..6 def 6
  shadowTint: number; // −100..100
}

export interface CameraRawSettings {
  light: CameraRawLightSettings;
  color: CameraRawColorSettings;
  curve: CameraRawCurveSettings;
  mixer: CameraRawMixerSettings;
  grading: CameraRawGradingSettings;
  effects: CameraRawEffectsSettings;
  detail: CameraRawDetailSettings;
  optics: CameraRawOpticsSettings;
  geometry: CameraRawGeometrySettings;
  calibration: CameraRawCalibrationSettings;
}

// ---------- process version scaling ----------

/** Effect-strength multipliers for process versions 1..6 (index v−1). */
export const PROCESS_VERSION_SCALES = [0.55, 0.65, 0.75, 0.85, 0.92, 1.0];

export function processVersionScale(v: number): number {
  const idx = clampN(Math.round(v), 1, 6) - 1;
  return PROCESS_VERSION_SCALES[idx];
}

// ---------- defaults ----------

export function defaultCameraRawSettings(): CameraRawSettings {
  return {
    light: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    color: { whiteBalance: 'custom', temperature: 0, tint: 0, vibrance: 0, saturation: 0 },
    curve: {
      shadows: 0, darks: 0, lights: 0, highlights: 0,
      shadowSplit: 25, darkSplit: 50, lightSplit: 75,
      pointRgb: [], pointRed: [], pointGreen: [], pointBlue: [],
      refineSaturation: 0,
    },
    mixer: {
      families: [
        { hue: 0, saturation: 0, luminance: 0 }, { hue: 0, saturation: 0, luminance: 0 },
        { hue: 0, saturation: 0, luminance: 0 }, { hue: 0, saturation: 0, luminance: 0 },
        { hue: 0, saturation: 0, luminance: 0 }, { hue: 0, saturation: 0, luminance: 0 },
        { hue: 0, saturation: 0, luminance: 0 }, { hue: 0, saturation: 0, luminance: 0 },
      ],
      points: [],
    },
    grading: {
      shadows: { hue: 0, saturation: 0, luminance: 0 },
      midtones: { hue: 0, saturation: 0, luminance: 0 },
      highlights: { hue: 0, saturation: 0, luminance: 0 },
      global: { hue: 0, saturation: 0, luminance: 0 },
      blending: 50,
      balance: 0,
    },
    effects: {
      texture: 0, clarity: 0, dehaze: 0,
      glow: { amount: 0, style: 'diffusion', range: 0, spread: 0, warmth: 0 },
      vignette: { amount: 0, style: 'highlightPriority', midpoint: 50, roundness: 0, feather: 50, highlights: 0 },
      grain: { amount: 0, size: 25, roughness: 50 },
    },
    detail: {
      sharpen: { amount: 0, radius: 10, detail: 25, masking: 0 },
      noiseLuminance: { amount: 0, detail: 50, contrast: 0 },
      noiseColor: { amount: 0, detail: 50, smoothness: 50 },
    },
    optics: {
      removeCA: false, distortion: 0,
      defringePurple: { amount: 0 },
      defringeGreen: { amount: 0 },
      lensVignette: { amount: 0, midpoint: 50 },
    },
    geometry: {
      vertical: 0, horizontal: 0, aspect: 0, scale: 0,
      offsetX: 0, offsetY: 0, rotate: 0, constrainCrop: false,
    },
    calibration: { processVersion: 6, shadowTint: 0 },
  };
}

// ---------- normalization ----------

function cl(v: number | undefined, lo: number, hi: number, def = 0): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return clampN(n, lo, hi);
}

function normPointCurve(pts: CameraRawPointCurvePoint[] | undefined): CameraRawPointCurvePoint[] {
  if (!Array.isArray(pts)) return [];
  return pts
    .filter(p => p && typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y))
    .map(p => ({ x: clampN(p.x, 0, 1), y: clampN(p.y, 0, 1) }))
    .sort((a, b) => a.x - b.x);
}

function normWheel(w: CameraRawColorWheel | undefined): CameraRawColorWheel {
  return {
    hue: cl(w?.hue, 0, 360),
    saturation: cl(w?.saturation, 0, 100),
    luminance: cl(w?.luminance, -100, 100),
  };
}

/**
 * Clamp every field to its documented range and return a fresh settings object
 * (the input is not mutated; missing/invalid fields fall back to defaults).
 * Parametric splits are kept ordered (shadow ≤ dark ≤ light).
 */
export function normalizeCameraRawSettings(s: CameraRawSettings): CameraRawSettings {
  const d = defaultCameraRawSettings();
  const li = s.light ?? d.light;
  const co = s.color ?? d.color;
  const cu = s.curve ?? d.curve;
  const mi = s.mixer ?? d.mixer;
  const gr = s.grading ?? d.grading;
  const ef = s.effects ?? d.effects;
  const de = s.detail ?? d.detail;
  const op = s.optics ?? d.optics;
  const geo = s.geometry ?? d.geometry;
  const ca = s.calibration ?? d.calibration;

  // ordered splits: shadow ≤ dark ≤ light, each clamped to 5..90
  const [shadowSplit, darkSplit, lightSplit] = [
    cl(cu.shadowSplit, 5, 90, 25),
    cl(cu.darkSplit, 5, 90, 50),
    cl(cu.lightSplit, 5, 90, 75),
  ].sort((a, b) => a - b);

  const families: CameraRawMixerFamily[] = [];
  for (let i = 0; i < 8; i++) {
    const f = mi.families?.[i];
    families.push({
      hue: cl(f?.hue, -100, 100),
      saturation: cl(f?.saturation, -100, 100),
      luminance: cl(f?.luminance, -100, 100),
    });
  }

  const points: CameraRawMixerPoint[] = (Array.isArray(mi.points) ? mi.points : [])
    .filter(p => p && typeof p === 'object')
    .slice(0, 8)
    .map(p => ({
      hue: cl(p.hue, 0, 360),
      sat: cl(p.sat, 0, 1, 0.5),
      lum: cl(p.lum, 0, 1, 0.5),
      hueShift: cl(p.hueShift, -100, 100),
      satShift: cl(p.satShift, -100, 100),
      lumShift: cl(p.lumShift, -100, 100),
      hueRange: cl(p.hueRange, 5, 180, 30),
      satRange: cl(p.satRange, 0.05, 1, 0.4),
      lumRange: cl(p.lumRange, 0.05, 1, 0.4),
    }));

  const glowStyle: CameraRawGlowStyle =
    ef.glow?.style === 'bloom' || ef.glow?.style === 'halation' ? ef.glow.style : 'diffusion';
  const vinStyle: CameraRawVignetteStyle =
    ef.vignette?.style === 'colorPriority' || ef.vignette?.style === 'paintOverlay' ? ef.vignette.style : 'highlightPriority';

  return {
    light: {
      exposure: Math.round(cl(li.exposure, -5, 5) * 100) / 100,
      contrast: cl(li.contrast, -100, 100),
      highlights: cl(li.highlights, -100, 100),
      shadows: cl(li.shadows, -100, 100),
      whites: cl(li.whites, -100, 100),
      blacks: cl(li.blacks, -100, 100),
    },
    color: {
      whiteBalance: co.whiteBalance === 'auto' ? 'auto' : 'custom',
      temperature: cl(co.temperature, -100, 100),
      tint: cl(co.tint, -100, 100),
      vibrance: cl(co.vibrance, -100, 100),
      saturation: cl(co.saturation, -100, 100),
    },
    curve: {
      shadows: cl(cu.shadows, -100, 100),
      darks: cl(cu.darks, -100, 100),
      lights: cl(cu.lights, -100, 100),
      highlights: cl(cu.highlights, -100, 100),
      shadowSplit, darkSplit, lightSplit,
      pointRgb: normPointCurve(cu.pointRgb),
      pointRed: normPointCurve(cu.pointRed),
      pointGreen: normPointCurve(cu.pointGreen),
      pointBlue: normPointCurve(cu.pointBlue),
      refineSaturation: cl(cu.refineSaturation, -100, 100),
    },
    mixer: { families, points },
    grading: {
      shadows: normWheel(gr.shadows),
      midtones: normWheel(gr.midtones),
      highlights: normWheel(gr.highlights),
      global: normWheel(gr.global),
      blending: cl(gr.blending, 0, 100, 50),
      balance: cl(gr.balance, -100, 100),
    },
    effects: {
      texture: cl(ef.texture, -100, 100),
      clarity: cl(ef.clarity, -100, 100),
      dehaze: cl(ef.dehaze, -100, 100),
      glow: {
        amount: cl(ef.glow?.amount, 0, 100),
        style: glowStyle,
        range: cl(ef.glow?.range, -100, 100),
        spread: cl(ef.glow?.spread, -100, 100),
        warmth: cl(ef.glow?.warmth, -100, 100),
      },
      vignette: {
        amount: cl(ef.vignette?.amount, -100, 100),
        style: vinStyle,
        midpoint: cl(ef.vignette?.midpoint, 0, 100, 50),
        roundness: cl(ef.vignette?.roundness, -100, 100),
        feather: cl(ef.vignette?.feather, 0, 100, 50),
        highlights: cl(ef.vignette?.highlights, 0, 100),
      },
      grain: {
        amount: cl(ef.grain?.amount, 0, 100),
        size: cl(ef.grain?.size, 0, 100, 25),
        roughness: cl(ef.grain?.roughness, 0, 100, 50),
      },
    },
    detail: {
      sharpen: {
        amount: cl(de.sharpen?.amount, 0, 150),
        radius: cl(de.sharpen?.radius, 0, 100, 10),
        detail: cl(de.sharpen?.detail, 0, 100, 25),
        masking: cl(de.sharpen?.masking, 0, 100),
      },
      noiseLuminance: {
        amount: cl(de.noiseLuminance?.amount, 0, 100),
        detail: cl(de.noiseLuminance?.detail, 0, 100, 50),
        contrast: cl(de.noiseLuminance?.contrast, -100, 100),
      },
      noiseColor: {
        amount: cl(de.noiseColor?.amount, 0, 100),
        detail: cl(de.noiseColor?.detail, 0, 100, 50),
        smoothness: cl(de.noiseColor?.smoothness, 0, 100, 50),
      },
    },
    optics: {
      removeCA: op.removeCA === true,
      distortion: cl(op.distortion, -100, 100),
      defringePurple: { amount: cl(op.defringePurple?.amount, 0, 100) },
      defringeGreen: { amount: cl(op.defringeGreen?.amount, 0, 100) },
      lensVignette: {
        amount: cl(op.lensVignette?.amount, -100, 100),
        midpoint: cl(op.lensVignette?.midpoint, 0, 100, 50),
      },
    },
    geometry: {
      vertical: cl(geo.vertical, -100, 100),
      horizontal: cl(geo.horizontal, -100, 100),
      aspect: cl(geo.aspect, -100, 100),
      scale: cl(geo.scale, -100, 100),
      offsetX: cl(geo.offsetX, -100, 100),
      offsetY: cl(geo.offsetY, -100, 100),
      rotate: cl(geo.rotate, -45, 45),
      constrainCrop: geo.constrainCrop === true,
    },
    calibration: {
      processVersion: Math.round(cl(ca.processVersion, 1, 6, 6)),
      shadowTint: cl(ca.shadowTint, -100, 100),
    },
  };
}

// ---------- identity check ----------

function pointCurveIsIdentity(pts: CameraRawPointCurvePoint[]): boolean {
  if (pts.length === 0) return true;
  const p = [...pts].sort((a, b) => a.x - b.x);
  if (p[0].x !== 0 || p[0].y !== 0) return false;
  const last = p[p.length - 1];
  if (last.x !== 1 || last.y !== 1) return false;
  return p.every(pt => Math.abs(pt.x - pt.y) < 1e-6);
}

/** True when every pipeline stage would be a no-op for these settings. */
export function cameraRawIsIdentity(s: CameraRawSettings): boolean {
  const n = normalizeCameraRawSettings(s);
  const geo = n.geometry;
  if (geo.vertical || geo.horizontal || geo.aspect || geo.scale || geo.offsetX || geo.offsetY || geo.rotate) return false;
  if (n.calibration.shadowTint !== 0) return false;
  const li = n.light;
  if (li.exposure || li.contrast || li.highlights || li.shadows || li.whites || li.blacks) return false;
  const co = n.color;
  if (co.whiteBalance !== 'custom' || co.temperature || co.tint || co.vibrance || co.saturation) return false;
  const cu = n.curve;
  if (cu.shadows || cu.darks || cu.lights || cu.highlights || cu.refineSaturation) return false;
  if (!pointCurveIsIdentity(cu.pointRgb) || !pointCurveIsIdentity(cu.pointRed) ||
    !pointCurveIsIdentity(cu.pointGreen) || !pointCurveIsIdentity(cu.pointBlue)) return false;
  if (n.mixer.families.some(f => f.hue || f.saturation || f.luminance)) return false;
  if (n.mixer.points.some(p => p.hueShift || p.satShift || p.lumShift)) return false;
  const gr = n.grading;
  if ([gr.shadows, gr.midtones, gr.highlights, gr.global].some(w => w.saturation || w.luminance)) return false;
  const ef = n.effects;
  if (ef.texture || ef.clarity || ef.dehaze) return false;
  if (ef.glow.amount || ef.vignette.amount || ef.grain.amount) return false;
  const de = n.detail;
  if (de.sharpen.amount || de.noiseLuminance.amount || de.noiseColor.amount) return false;
  const op = n.optics;
  if (op.removeCA || op.distortion || op.defringePurple.amount || op.defringeGreen.amount || op.lensVignette.amount) return false;
  return true;
}

// ---------- auto white balance ----------

/**
 * Gray-world auto WB: alpha-weighted mean of each channel in linear light, then
 * a coarse-to-fine pattern search (steps 10, 2, 0.5) over temperature/tint that
 * minimizes max−min of the gained channel means (the same gains the tone pass
 * applies: r·(1+t/200), g·(1+tint/300), b·(1−t/200)).
 */
export function autoWhiteBalance(img: ImageData): { temperature: number; tint: number } {
  const px = img.data;
  const total = px.length >> 2;
  if (total === 0) return { temperature: 0, tint: 0 };
  const stride = Math.max(1, Math.floor(total / 250000)); // cap work on huge layers
  let sr = 0, sg = 0, sb = 0, sw = 0;
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    const a = px[i + 3] / 255;
    if (a <= 0) continue;
    sr += srgbToLinear(px[i] / 255) * a;
    sg += srgbToLinear(px[i + 1] / 255) * a;
    sb += srgbToLinear(px[i + 2] / 255) * a;
    sw += a;
  }
  if (sw <= 0) return { temperature: 0, tint: 0 };
  const mr = sr / sw, mg = sg / sw, mb = sb / sw;
  const spread = (t: number, ti: number): number => {
    const r = mr * (1 + t / 200);
    const g = mg * (1 + ti / 300);
    const b = mb * (1 - t / 200);
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  let bt = 0, bti = 0;
  for (const st of [10, 2, 0.5]) {
    for (let iter = 0; iter < 8; iter++) {
      let best = spread(bt, bti);
      let moved = false;
      for (const dt of [-st, 0, st]) {
        for (const dti of [-st, 0, st]) {
          if (dt === 0 && dti === 0) continue;
          const t = clampN(bt + dt, -100, 100);
          const ti = clampN(bti + dti, -100, 100);
          const v = spread(t, ti);
          if (v < best - 1e-12) {
            best = v;
            bt = t;
            bti = ti;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }
  return { temperature: Math.round(bt * 10) / 10, tint: Math.round(bti * 10) / 10 };
}
