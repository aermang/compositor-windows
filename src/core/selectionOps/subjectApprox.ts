// Algorithmic approximation of a Vision-style subject matte (no ML): border-strip
// k-means background model → normalized RGB distance → Otsu-thresholded initial
// matte → morphological open/close → largest component + hole fill → guided-filter
// edge refinement. `pickObjectAt` is the click-based variant for the wand's
// object mode: adaptive-tolerance region grow + guided refine.

import { guidedFilter } from './guidedMatte';

const BORDER = 4;        // border strip thickness for background sampling
const K_MEANS = 5;       // background clusters
const KMEANS_ITERS = 8;

/** Unpremultiplied [r, g, b] (0..255) of a premultiplied RGBA pixel; null when a == 0. */
function unpremul(d: Uint8ClampedArray, i: number): [number, number, number] | null {
  const a = d[i + 3];
  if (a === 0) return null;
  return [
    Math.min(255, (d[i] * 255 + a / 2) / a),
    Math.min(255, (d[i + 1] * 255 + a / 2) / a),
    Math.min(255, (d[i + 2] * 255 + a / 2) / a),
  ];
}

/** Unpremultiplied luma (0..255) plane; transparent pixels contribute 0. */
function lumaPlane(img: ImageData): Float32Array {
  const w = img.width, h = img.height;
  const d = img.data;
  const out = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const rgb = unpremul(d, p * 4);
    if (rgb) out[p] = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  }
  return out;
}

/** k-means (Lloyd, deterministic evenly-spaced init) over border-strip samples. */
function backgroundKMeans(img: ImageData): { centers: Float32Array; weights: Float32Array } | null {
  const w = img.width, h = img.height;
  const d = img.data;
  const samples: number[] = [];
  for (let y = 0; y < h; y++) {
    const inTopStrip = y < BORDER, inBottomStrip = y >= h - BORDER;
    for (let x = 0; x < w; x++) {
      if (!inTopStrip && !inBottomStrip && x >= BORDER && x < w - BORDER) continue;
      const rgb = unpremul(d, (y * w + x) * 4);
      if (rgb) samples.push(rgb[0], rgb[1], rgb[2]);
    }
  }
  const m = samples.length / 3;
  if (m < K_MEANS) return null;

  const centers = new Float32Array(K_MEANS * 3);
  for (let i = 0; i < K_MEANS; i++) {
    const s = Math.floor((i * m) / K_MEANS) * 3;
    centers[i * 3] = samples[s];
    centers[i * 3 + 1] = samples[s + 1];
    centers[i * 3 + 2] = samples[s + 2];
  }
  const sums = new Float64Array(K_MEANS * 3);
  const counts = new Int32Array(K_MEANS);
  for (let iter = 0; iter < KMEANS_ITERS; iter++) {
    sums.fill(0);
    counts.fill(0);
    for (let s = 0; s < m; s++) {
      const r = samples[s * 3], g = samples[s * 3 + 1], b = samples[s * 3 + 2];
      let best = 0, bestD = Infinity;
      for (let c = 0; c < K_MEANS; c++) {
        const dr = r - centers[c * 3], dg = g - centers[c * 3 + 1], db = b - centers[c * 3 + 2];
        const dd = dr * dr + dg * dg + db * db;
        if (dd < bestD) { bestD = dd; best = c; }
      }
      sums[best * 3] += r; sums[best * 3 + 1] += g; sums[best * 3 + 2] += b;
      counts[best]++;
    }
    for (let c = 0; c < K_MEANS; c++) {
      if (counts[c] === 0) continue; // empty cluster keeps its previous center
      centers[c * 3] = sums[c * 3] / counts[c];
      centers[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
      centers[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
    }
  }

  // final assignment → weights (cluster mass fractions)
  const weights = new Float32Array(K_MEANS);
  counts.fill(0);
  for (let s = 0; s < m; s++) {
    const r = samples[s * 3], g = samples[s * 3 + 1], b = samples[s * 3 + 2];
    let best = 0, bestD = Infinity;
    for (let c = 0; c < K_MEANS; c++) {
      const dr = r - centers[c * 3], dg = g - centers[c * 3 + 1], db = b - centers[c * 3 + 2];
      const dd = dr * dr + dg * dg + db * db;
      if (dd < bestD) { bestD = dd; best = c; }
    }
    counts[best]++;
  }
  for (let c = 0; c < K_MEANS; c++) weights[c] = counts[c] / m;
  return { centers, weights };
}

/** Otsu threshold on a 256-bin histogram; returns the bin index (0..255). */
function otsu(hist: Uint32Array, total: number): number {
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0, sumB = 0, bestVar = -1, bestT = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; bestT = t; }
  }
  return bestT;
}

/** 3×3 binary erode with clamped (replicated) border sampling. */
function erode3(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = true;
      for (let dy = -1; dy <= 1 && all; dy++) {
        const cy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const cx = Math.min(w - 1, Math.max(0, x + dx));
          if (src[cy * w + cx] !== 255) { all = false; break; }
        }
      }
      out[y * w + x] = all ? 255 : 0;
    }
  }
  return out;
}

function dilate3(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let any = false;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        const cy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const cx = Math.min(w - 1, Math.max(0, x + dx));
          if (src[cy * w + cx] === 255) { any = true; break; }
        }
      }
      out[y * w + x] = any ? 255 : 0;
    }
  }
  return out;
}

/** Keep only the largest 4-connected foreground component. */
function keepLargestComponent(plane: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  let best = -1, bestSize = 0, next = 0;
  for (let seed = 0; seed < w * h; seed++) {
    if (label[seed] !== -1 || plane[seed] !== 255) continue;
    const id = next++;
    let size = 0;
    stack.push(seed);
    label[seed] = id;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && label[p - 1] === -1 && plane[p - 1] === 255) { label[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && label[p + 1] === -1 && plane[p + 1] === 255) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && label[p - w] === -1 && plane[p - w] === 255) { label[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && label[p + w] === -1 && plane[p + w] === 255) { label[p + w] = id; stack.push(p + w); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  const out = new Uint8Array(w * h);
  if (best >= 0) for (let p = 0; p < w * h; p++) if (label[p] === best) out[p] = 255;
  return out;
}

/** Fill enclosed holes: background pixels unreachable from the border become foreground. */
function fillHoles(plane: Uint8Array, w: number, h: number): Uint8Array {
  const reach = new Uint8Array(w * h);
  const stack: number[] = [];
  const pushIfBackground = (p: number) => {
    if (!reach[p] && plane[p] !== 255) { reach[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < w; x++) { pushIfBackground(x); pushIfBackground((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { pushIfBackground(y * w); pushIfBackground(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) pushIfBackground(p - 1);
    if (x < w - 1) pushIfBackground(p + 1);
    if (y > 0) pushIfBackground(p - w);
    if (y < h - 1) pushIfBackground(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = plane[p] === 255 || !reach[p] ? 255 : 0;
  return out;
}

/**
 * Approximate a subject matte (0..1, w×h): border k-means background model,
 * distance map normalized by its 95th percentile, Otsu-thresholded initial
 * matte, morphological open/close (3×3, 2 iterations each), largest component
 * + hole fill, then guided-filter refinement (radius 12, eps 1e-4, luma guide).
 */
export function approxSubjectMask(img: ImageData): Float32Array {
  const w = img.width, h = img.height, n = w * h;
  const out = new Float32Array(n);
  if (!n) return out;

  // (a) background clusters from the 4px border strips
  const km = backgroundKMeans(img);
  if (!km) return out; // nothing visible to model → empty matte

  // (b) per-pixel distance to the nearest background center, normalized by p95
  const d = img.data;
  const dist = new Float32Array(n);
  const MAX_RGB_DIST = 441.67295; // sqrt(3·255²)
  const p95Hist = new Uint32Array(512);
  for (let p = 0; p < n; p++) {
    const rgb = unpremul(d, p * 4);
    if (!rgb) { dist[p] = 0; p95Hist[0]++; continue; } // transparent → background
    let bestD = Infinity;
    for (let c = 0; c < K_MEANS; c++) {
      const dr = rgb[0] - km.centers[c * 3];
      const dg = rgb[1] - km.centers[c * 3 + 1];
      const db = rgb[2] - km.centers[c * 3 + 2];
      const dd = dr * dr + dg * dg + db * db;
      if (dd < bestD) bestD = dd;
    }
    dist[p] = Math.sqrt(bestD);
    p95Hist[Math.min(511, Math.floor((dist[p] / MAX_RGB_DIST) * 512))]++;
  }
  let cum = 0, p95Bin = 511;
  for (let b = 0; b < 512; b++) {
    cum += p95Hist[b];
    if (cum >= 0.95 * n) { p95Bin = b; break; }
  }
  const p95 = Math.max(((p95Bin + 1) / 512) * MAX_RGB_DIST, 1e-6);

  // (c) initial matte, threshold via Otsu on the distance map. Note: the distance
  // map measures background-likeness (small = near a background cluster), so the
  // subject matte is clamp(dist/threshold) — the literal "1 − clamp(dist/threshold)"
  // would mark the background as foreground and, after hole filling, swallow the
  // subject entirely.
  const otsuHist = new Uint32Array(256);
  for (let p = 0; p < n; p++) {
    const v = Math.min(1, dist[p] / p95);
    otsuHist[Math.min(255, Math.floor(v * 255))]++;
  }
  const threshold = Math.max(otsu(otsuHist, n) / 255, 1 / 255);

  const binary = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const v = Math.min(1, dist[p] / p95 / threshold);
    binary[p] = v >= 0.5 ? 255 : 0;
  }

  // (d) morphological open then close (3×3, 2 iterations each)
  let plane: Uint8Array = binary;
  for (let i = 0; i < 2; i++) plane = erode3(plane, w, h);
  for (let i = 0; i < 2; i++) plane = dilate3(plane, w, h);
  for (let i = 0; i < 2; i++) plane = dilate3(plane, w, h);
  for (let i = 0; i < 2; i++) plane = erode3(plane, w, h);

  // (e) largest foreground component + hole fill (flood from border on background)
  plane = keepLargestComponent(plane, w, h);
  plane = fillHoles(plane, w, h);

  // (f) guided-filter refine (radius 12, eps 1e-4) with a luma guide, then (g) clamp
  const luma = lumaPlane(img);
  const guide = new Float32Array(n);
  for (let p = 0; p < n; p++) guide[p] = luma[p] / 255;
  const matte01 = new Float32Array(n);
  for (let p = 0; p < n; p++) matte01[p] = plane[p] === 255 ? 1 : 0;
  const refined = guidedFilter(guide, matte01, w, h, 12, 1e-4);
  for (let p = 0; p < n; p++) {
    out[p] = refined[p] < 0 ? 0 : refined[p] > 1 ? 1 : refined[p];
  }
  return out;
}

/**
 * Click-based object approximation for the wand's object mode: region-grow from
 * the clicked pixel with an adaptive tolerance (mean + 2σ of the local 15×15
 * gradient), then guided refinement (radius 5) with a luma guide. Returns a 0..1
 * matte; out-of-bounds clicks yield an all-zero matte.
 */
export function pickObjectAt(img: ImageData, x: number, y: number): Float32Array {
  const w = img.width, h = img.height, n = w * h;
  const out = new Float32Array(n);
  if (x < 0 || y < 0 || x >= w || y >= h) return out;

  const luma = lumaPlane(img);

  // adaptive tolerance from the local 15×15 gradient (clamped window)
  const R = 7;
  let mean = 0, meanSq = 0, cnt = 0;
  for (let dy = -R; dy <= R; dy++) {
    const cy = Math.min(h - 1, Math.max(0, y + dy));
    const cy1 = Math.min(h - 1, Math.max(0, y + dy + 1));
    const cy0 = Math.min(h - 1, Math.max(0, y + dy - 1));
    for (let dx = -R; dx <= R; dx++) {
      const cx = Math.min(w - 1, Math.max(0, x + dx));
      const cx1 = Math.min(w - 1, Math.max(0, x + dx + 1));
      const cx0 = Math.min(w - 1, Math.max(0, x + dx - 1));
      const gx = luma[cy * w + cx1] - luma[cy * w + cx0];
      const gy = luma[cy1 * w + cx] - luma[cy0 * w + cx];
      const g = Math.sqrt(gx * gx + gy * gy);
      mean += g;
      meanSq += g * g;
      cnt++;
    }
  }
  mean /= cnt;
  const sigma = Math.sqrt(Math.max(0, meanSq / cnt - mean * mean));
  const tolerance = Math.min(255, Math.max(0, mean + 2 * sigma));

  // region grow from the seed luma with the adaptive tolerance (4-connected)
  const seedLuma = luma[y * w + x];
  const inRegion = new Uint8Array(n);
  const stack: number[] = [y * w + x];
  inRegion[y * w + x] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const px = p % w, py = (p / w) | 0;
    const tryVisit = (q: number) => {
      if (!inRegion[q] && Math.abs(luma[q] - seedLuma) <= tolerance) {
        inRegion[q] = 1;
        stack.push(q);
      }
    };
    if (px > 0) tryVisit(p - 1);
    if (px < w - 1) tryVisit(p + 1);
    if (py > 0) tryVisit(p - w);
    if (py < h - 1) tryVisit(p + w);
  }

  const matte = new Float32Array(n);
  for (let p = 0; p < n; p++) matte[p] = inRegion[p] ? 1 : 0;
  const guide = new Float32Array(n);
  for (let p = 0; p < n; p++) guide[p] = luma[p] / 255;

  const refined = guidedFilter(guide, matte, w, h, 5, 1e-4);
  for (let p = 0; p < n; p++) {
    out[p] = refined[p] < 0 ? 0 : refined[p] > 1 ? 1 : refined[p];
  }
  return out;
}
