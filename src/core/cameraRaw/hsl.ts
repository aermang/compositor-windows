// Shared color-space, noise and filtering primitives for the Camera Raw engine.
// Ported from the Swift/C original (CameraRawFilter); the original's 763 measured
// LUTs are substituted by formulas — the original degrades gracefully without
// them, so this is sanctioned.

// ---------- clamps / ramps ----------

export function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clampN((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------- transfer functions ----------

/** sRGB-encoded (0..1) → linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light → sRGB-encoded (0..1). */
export function linearToSrgb(c: number): number {
  if (c <= 0) return 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Rec.709 luminance of gamma-encoded components (used for tonal masks). */
export function luma709(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------- HSL ----------

/** RGB (0..1) → HSL with h in [0,1). Result written to out[0..2]. */
export function rgbToHslInto(r: number, g: number, b: number, out: Float32Array): void {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  out[0] = h;
  out[1] = s;
  out[2] = l;
}

/** HSL (h in [0,1)) → RGB (0..1). Result written to out[0..2]. */
export function hslToRgbInto(h: number, s: number, l: number, out: Float32Array): void {
  if (s <= 0) {
    out[0] = out[1] = out[2] = l;
    return;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  out[0] = f(h + 1 / 3);
  out[1] = f(h);
  out[2] = f(h - 1 / 3);
}

/** Cold-path tuple variant of hslToRgbInto. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const out = new Float32Array(3);
  hslToRgbInto(h, s, l, out);
  return [out[0], out[1], out[2]];
}

/** Circular hue distance in degrees (0..180). */
export function hueDistanceDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Move a pixel's RGB so its luminance becomes `target`, keeping hue:
 * multiplicative in the mids/highlights, additive black-lift near black
 * (a pure multiply is unstable for very dark pixels).
 * `y` must be luma709(r, g, b). Result written to out[0..2].
 */
export function scaleLuminanceInto(
  r: number, g: number, b: number, y: number, target: number, out: Float32Array,
): void {
  target = clamp01(target);
  const add = target - y;
  const mul = y > 1e-5 ? target / y : 0;
  // additive in deep blacks → multiplicative above ~0.35
  const w = smoothstep(0, 0.35, y);
  out[0] = clamp01((r + add) * (1 - w) + r * mul * w);
  out[1] = clamp01((g + add) * (1 - w) + g * mul * w);
  out[2] = clamp01((b + add) * (1 - w) + b * mul * w);
}

// ---------- separable box blur (exact fractional radius, clamped edges) ----------

/** Integral of the clamped-edge line from 0 to t (pixel i occupies [i, i+1)). */
function qInt(t: number, line: Float32Array, prefix: Float32Array, n: number): number {
  if (t <= 0) return t * line[0];
  if (t >= n) return prefix[n] + (t - n) * line[n - 1];
  const i = t | 0;
  return prefix[i] + (t - i) * line[i];
}

/** One axis of the box blur. Element (o, i) lives at base0 + o*baseStride + i*step. */
function blurAxis(
  src: Float32Array, dst: Float32Array, line: Float32Array, prefix: Float32Array,
  n: number, other: number, base0: number, baseStride: number, step: number, r: number,
): void {
  const inv = 1 / (2 * r);
  for (let o = 0; o < other; o++) {
    const base = base0 + o * baseStride;
    let acc = 0;
    prefix[0] = 0;
    for (let i = 0; i < n; i++) {
      const v = src[base + i * step];
      line[i] = v;
      acc += v;
      prefix[i + 1] = acc;
    }
    for (let i = 0; i < n; i++) {
      const c = i + 0.5;
      dst[base + i * step] = (qInt(c + r, line, prefix, n) - qInt(c - r, line, prefix, n)) * inv;
    }
  }
}

function blur2D(plane: Float32Array, w: number, h: number, r: number, scratch: Float32Array): Float32Array {
  const out = new Float32Array(plane.length);
  const line = new Float32Array(Math.max(w, h));
  const prefix = new Float32Array(Math.max(w, h) + 1);
  blurAxis(plane, scratch, line, prefix, w, h, 0, w, 1, r); // horizontal → scratch
  blurAxis(scratch, out, line, prefix, h, w, 0, 1, w, r); // vertical → out
  return out;
}

/**
 * Separable box blur of a float plane, radius in px (fractional supported).
 * With `weight` (0..1 per sample, typically alpha) this becomes an alpha-weighted
 * blur: blur(plane·weight) / blur(weight), so transparent samples don't leak in.
 */
export function boxBlur(
  plane: Float32Array, w: number, h: number, radius: number, weight: Float32Array | null = null,
): Float32Array {
  const r = Math.max(0, radius);
  if (r < 0.5) return plane.slice();
  const scratch = new Float32Array(plane.length);
  if (!weight) return blur2D(plane, w, h, r, scratch);
  const prem = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) prem[i] = plane[i] * weight[i];
  const num = blur2D(prem, w, h, r, scratch);
  const den = blur2D(weight, w, h, r, scratch);
  const out = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i++) out[i] = den[i] > 1e-4 ? num[i] / den[i] : plane[i];
  return out;
}

/**
 * Self-guided filter (fast guided filter, guide = signal) — edge-preserving
 * smoothing used by texture/clarity. eps = 0.01 per the original.
 */
export function selfGuidedFilter(
  luma: Float32Array, w: number, h: number, radius: number,
  eps = 0.01, weight: Float32Array | null = null,
): Float32Array {
  const meanI = boxBlur(luma, w, h, radius, weight);
  const ii = new Float32Array(luma.length);
  for (let i = 0; i < luma.length; i++) ii[i] = luma[i] * luma[i];
  const meanII = boxBlur(ii, w, h, radius, weight);
  const a = new Float32Array(luma.length);
  const b = new Float32Array(luma.length);
  for (let i = 0; i < luma.length; i++) {
    const varI = Math.max(0, meanII[i] - meanI[i] * meanI[i]);
    a[i] = varI / (varI + eps);
    b[i] = meanI[i] * (1 - a[i]);
  }
  const meanA = boxBlur(a, w, h, radius, weight);
  const meanB = boxBlur(b, w, h, radius, weight);
  const out = new Float32Array(luma.length);
  for (let i = 0; i < luma.length; i++) out[i] = meanA[i] * luma[i] + meanB[i];
  return out;
}

// ---------- seeded value noise ----------

export function mix32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = h ^ (h >>> 15);
  return h >>> 0;
}

/** Uniform [0,1) hash on an integer lattice. */
export function hashLattice(ix: number, iy: number, seed: number, salt: number): number {
  return mix32(Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca77) ^ Math.imul(seed + salt, 0xc2b2ae3d)) / 4294967296;
}

/**
 * Triangular [−1,1] value noise on the unit lattice, bilinear-smoothstep
 * interpolated, ×1.6 to undo the variance loss of interpolation.
 * Sample at (x/cell, y/cell) for grain of `cell` px.
 */
export function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const tx = fx * fx * (3 - 2 * fx);
  const ty = fy * fy * (3 - 2 * fy);
  const tri = (cx: number, cy: number): number =>
    hashLattice(cx, cy, seed, 0) + hashLattice(cx, cy, seed, 1) - 1;
  const n00 = tri(x0, y0);
  const n10 = tri(x0 + 1, y0);
  const n01 = tri(x0, y0 + 1);
  const n11 = tri(x0 + 1, y0 + 1);
  const n = (n00 * (1 - tx) + n10 * tx) * (1 - ty) + (n01 * (1 - tx) + n11 * tx) * ty;
  return n * 1.6;
}

// ---------- monotone spline (parametric curve smoothing) ----------

/**
 * Fritsch–Carlson monotone cubic through sorted points, sampled uniformly over
 * [0,1] into `count` values (clamped to 0..1). Falls back to constant when a
 * single point is given.
 */
export function monotoneSplineSamples(pts: { x: number; y: number }[], count: number): Float32Array {
  const out = new Float32Array(count);
  const p = [...pts].sort((a, b) => a.x - b.x);
  const n = p.length;
  if (n === 0) {
    for (let j = 0; j < count; j++) out[j] = j / (count - 1 || 1);
    return out;
  }
  if (n === 1) {
    out.fill(clamp01(p[0].y));
    return out;
  }
  const xs = p.map(q => q.x);
  const ys = p.map(q => q.y);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push(xs[i + 1] > xs[i] ? (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) : 0);
  const ms: number[] = new Array(n);
  ms[0] = d[0];
  ms[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) ms[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      ms[i] = 0;
      ms[i + 1] = 0;
      continue;
    }
    const a = ms[i] / d[i];
    const b = ms[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      ms[i] = t * a * d[i];
      ms[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let j = 0; j < count; j++) {
    const x = count > 1 ? j / (count - 1) : 0;
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const hSeg = xs[seg + 1] - xs[seg];
    const t = clampN(hSeg > 0 ? (x - xs[seg]) / hSeg : 0, 0, 1);
    const h00 = (1 + 2 * t) * (1 - t) * (1 - t);
    const h10 = t * (1 - t) * (1 - t);
    const h01 = t * t * (3 - 2 * t);
    const h11 = t * t * (t - 1);
    out[j] = clamp01(h00 * ys[seg] + h10 * hSeg * ms[seg] + h01 * ys[seg + 1] + h11 * hSeg * ms[seg + 1]);
  }
  return out;
}
