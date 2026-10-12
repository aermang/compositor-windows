// Healing engine — the pixel math behind the heal tool (src/tools/heal.ts).
// Pure ImageData-in/ImageData-out functions, no store access, so the algorithms
// stay testable and independent of the tool/session layer.
//
// - spotHealRegion: content-aware fill of the stroked area by multi-scale
//   diffusion. Unknown pixels (stamp alpha > threshold) relax toward the
//   weighted mean of their 8 neighbours (Gauss-Seidel sweeps, alternating
//   direction per round); large regions are solved on a coarse-to-fine pyramid
//   so the full-resolution sweep budget stays small. The solved field is then
//   soft-blended back by the stamp alpha, which keeps the stroke's feathered
//   edge seamless. A grain pass estimated from the boundary band breaks up the
//   plastic look of large fills — and vanishes on flat boundaries (σ ≈ 0).
// - fuseHealPatch: per-dab luminance transfer for the source-based healing
//   brush. The source patch's luminance structure is re-based onto the target
//   pixel (a ratio fusion keeps the target's chroma ratios); near-black targets
//   have no chroma worth preserving and the ratio degenerates (0 × ∞), so they
//   take the source verbatim through a smooth handover — that is what lets the
//   brush lift a black blemish all the way to the sampled colour.

import { clamp } from './canvasUtils';

export interface SpotHealOptions {
  /** Smaller-dim cap of the coarsest pyramid level (pixels). */
  coarseDim?: number;
  /** Sweep budget cap at the coarsest level. */
  maxRounds?: number;
}

/**
 * Content-aware fill of the masked region of `src`. `mask` carries the per-
 * pixel heal strength 0..255 (the stroke overlay's alpha channel); pixels with
 * strength > 0.02 are unknown and get diffused, all others act as anchors.
 * Returns a new ImageData with the fill soft-blended by the mask alpha.
 */
export function spotHealRegion(
  src: ImageData,
  mask: Uint8Array | Uint8ClampedArray,
  opts: SpotHealOptions = {},
): ImageData {
  const w = src.width, h = src.height, n = w * h;
  const out = new ImageData(new Uint8ClampedArray(src.data), w, h);
  if (mask.length !== n) return out;

  const strength = new Float32Array(n);
  let unknownCount = 0;
  for (let p = 0; p < n; p++) {
    const s = mask[p] / 255;
    if (s > 0.02) { strength[p] = s; unknownCount++; }
  }
  if (unknownCount === 0) return out;

  // Work on premultiplied planes: straight-alpha RGBA would bleed the black of
  // fully transparent pixels into the diffused fill.
  const px = new Float32Array(n * 4);
  for (let p = 0; p < n; p++) {
    const a = src.data[p * 4 + 3] / 255;
    px[p * 4] = src.data[p * 4] * a;
    px[p * 4 + 1] = src.data[p * 4 + 1] * a;
    px[p * 4 + 2] = src.data[p * 4 + 2] * a;
    px[p * 4 + 3] = src.data[p * 4 + 3];
  }
  const unknown = new Uint8Array(n);
  for (let p = 0; p < n; p++) unknown[p] = strength[p] > 0 ? 1 : 0;

  solveDiffusion(px, w, h, unknown, opts.coarseDim ?? 48, opts.maxRounds ?? 128);
  addBoundaryGrain(px, w, h, unknown);

  for (let p = 0; p < n; p++) {
    const s = strength[p];
    if (s === 0) continue;
    const i = p * 4;
    const fa = px[i + 3] / 255;
    if (fa <= 0.002) continue; // nothing to sample around here — keep original
    const inv = 1 / fa;
    out.data[i] = src.data[i] * (1 - s) + px[i] * inv * s;
    out.data[i + 1] = src.data[i + 1] * (1 - s) + px[i + 1] * inv * s;
    out.data[i + 2] = src.data[i + 2] * (1 - s) + px[i + 2] * inv * s;
    out.data[i + 3] = src.data[i + 3] * (1 - s) + px[i + 3] * s;
  }
  return out;
}

// ---------- multi-scale diffusion ----------

interface Plane { w: number; h: number; px: Float32Array; unknown: Uint8Array }

function solveDiffusion(
  px: Float32Array, w: number, h: number, unknown: Uint8Array,
  coarseDim: number, maxRounds: number,
) {
  const levels: Plane[] = [{ w, h, px, unknown }];
  // coarse-to-fine: halve until the smaller dim fits the coarse cap
  while (Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) > coarseDim * 2) {
    const fine = levels[levels.length - 1];
    if (fine.w < 4 || fine.h < 4) break;
    levels.push(downsamplePlane(fine));
  }
  const top = levels[levels.length - 1];
  seedWithKnownMean(top);
  // sweep budget scales down with area so huge fills stay a bounded one-shot
  const area = top.w * top.h;
  const coarseRounds = Math.max(16, Math.min(maxRounds, Math.floor(1_500_000 / Math.max(1, area))));
  for (let r = 0; r < coarseRounds; r++) if (relaxSweep(top, r) < 0.5) break;
  for (let li = levels.length - 2; li >= 0; li--) {
    const lv = levels[li];
    upsampleInto(levels[li + 1], lv);
    // finer levels start near the solution — a small budget just polishes
    const rounds = Math.min(maxRounds, li === 0 ? 16 : 12);
    for (let r = 0; r < rounds; r++) if (relaxSweep(lv, r) < 0.5) break;
  }
}

/** Box-downsample by 2: coarse pixels average their known children only; a
 *  cell with no known children stays unknown (and gets solved at this level). */
function downsamplePlane(f: Plane): Plane {
  const w = Math.max(1, f.w >> 1), h = Math.max(1, f.h >> 1);
  const px = new Float32Array(w * h * 4);
  const unknown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, k = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = y * 2 + dy;
        if (sy >= f.h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const sx = x * 2 + dx;
          if (sx >= f.w) continue;
          const sp = sy * f.w + sx;
          if (f.unknown[sp]) continue;
          const si = sp * 4;
          r += f.px[si]; g += f.px[si + 1]; b += f.px[si + 2]; a += f.px[si + 3];
          k++;
        }
      }
      const dp = y * w + x;
      if (k > 0) {
        const di = dp * 4;
        px[di] = r / k; px[di + 1] = g / k; px[di + 2] = b / k; px[di + 3] = a / k;
      } else {
        unknown[dp] = 1;
      }
    }
  }
  return { w, h, px, unknown };
}

/** Seed unknown pixels with the mean of the known ones: starting from the
 *  blemish's own colours would bias the relaxation toward what we're removing. */
function seedWithKnownMean(lv: Plane) {
  let r = 0, g = 0, b = 0, a = 0, k = 0;
  const n = lv.w * lv.h;
  for (let p = 0; p < n; p++) {
    if (lv.unknown[p]) continue;
    const i = p * 4;
    r += lv.px[i]; g += lv.px[i + 1]; b += lv.px[i + 2]; a += lv.px[i + 3];
    k++;
  }
  if (k === 0) return; // nothing anchored — the original values are the only guess
  r /= k; g /= k; b /= k; a /= k;
  for (let p = 0; p < n; p++) {
    if (!lv.unknown[p]) continue;
    const i = p * 4;
    lv.px[i] = r; lv.px[i + 1] = g; lv.px[i + 2] = b; lv.px[i + 3] = a;
  }
}

const DIAG_W = Math.SQRT1_2; // diagonal neighbours weigh less than orthogonal

/** One Gauss-Seidel sweep over the unknown pixels: each takes the weighted
 *  mean of its 8 neighbours (orthogonal 1, diagonal 1/√2) from the freshest
 *  values. Direction alternates per round so information crosses the region
 *  roughly twice as fast. Returns the total change — the convergence signal. */
function relaxSweep(lv: Plane, round: number): number {
  const { w, h, px, unknown } = lv;
  const forward = (round & 1) === 0;
  let delta = 0;
  for (let yi = 0; yi < h; yi++) {
    const y = forward ? yi : h - 1 - yi;
    const row = y * w;
    for (let xi = 0; xi < w; xi++) {
      const x = forward ? xi : w - 1 - xi;
      const p = row + x;
      if (!unknown[p]) continue;
      let sr = 0, sg = 0, sb = 0, sa = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const wt = dx !== 0 && dy !== 0 ? DIAG_W : 1;
          const q = (ny * w + nx) * 4;
          sr += px[q] * wt; sg += px[q + 1] * wt; sb += px[q + 2] * wt; sa += px[q + 3] * wt;
          wsum += wt;
        }
      }
      if (wsum === 0) continue;
      const i = p * 4;
      const nr = sr / wsum, ng = sg / wsum, nb = sb / wsum, na = sa / wsum;
      delta += Math.abs(nr - px[i]) + Math.abs(ng - px[i + 1])
        + Math.abs(nb - px[i + 2]) + Math.abs(na - px[i + 3]);
      px[i] = nr; px[i + 1] = ng; px[i + 2] = nb; px[i + 3] = na;
    }
  }
  return delta;
}

/** Bilinear-resample the coarse solution into the fine plane's unknown pixels;
 *  known pixels keep their own values — they are the anchors. */
function upsampleInto(c: Plane, f: Plane) {
  for (let y = 0; y < f.h; y++) {
    const cy = (y + 0.5) / 2 - 0.5;
    const y0 = Math.max(0, Math.min(c.h - 1, Math.floor(cy)));
    const y1 = Math.min(c.h - 1, y0 + 1);
    const ty = clamp(cy - y0, 0, 1);
    for (let x = 0; x < f.w; x++) {
      const p = y * f.w + x;
      if (!f.unknown[p]) continue;
      const cx = (x + 0.5) / 2 - 0.5;
      const x0 = Math.max(0, Math.min(c.w - 1, Math.floor(cx)));
      const x1 = Math.min(c.w - 1, x0 + 1);
      const tx = clamp(cx - x0, 0, 1);
      const i = p * 4;
      const q00 = (y0 * c.w + x0) * 4, q10 = (y0 * c.w + x1) * 4;
      const q01 = (y1 * c.w + x0) * 4, q11 = (y1 * c.w + x1) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const topV = c.px[q00 + ch] * (1 - tx) + c.px[q10 + ch] * tx;
        const botV = c.px[q01 + ch] * (1 - tx) + c.px[q11 + ch] * tx;
        f.px[i + ch] = topV * (1 - ty) + botV * ty;
      }
    }
  }
}

// ---------- boundary grain ----------

/** Deterministic 32-bit LCG (same family as contentFill's) so re-running the
 *  same stroke reproduces byte-identical pixels. */
function makeLcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => (x = (Math.imul(1664525, x) + 1013904223) >>> 0);
}

/** Re-inject boundary texture into the filled area: estimate the high-pass
 *  energy of the known band hugging the region, then scatter matching luma
 *  noise over the unknown pixels (luma-only keeps the fill's chroma). On flat
 *  boundaries σ ≈ 0 and the pass is a no-op, so clean test fills stay clean. */
function addBoundaryGrain(px: Float32Array, w: number, h: number, unknown: Uint8Array) {
  let sum = 0, sum2 = 0, cnt = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (unknown[p]) continue;
      // band pixel: known, with at least one unknown 4-neighbour
      if (!(x > 0 && unknown[p - 1]) && !(x < w - 1 && unknown[p + 1]) &&
          !(y > 0 && unknown[p - w]) && !(y < h - 1 && unknown[p + w])) continue;
      const i = p * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      let nl = 0, nk = 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1,
        y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || unknown[q]) continue;
        const j = q * 4;
        nl += 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
        nk++;
      }
      if (!nk) continue;
      const d = lum - nl / nk;
      sum += d; sum2 += d * d; cnt++;
    }
  }
  if (cnt < 16) return;
  const mean = sum / cnt;
  const sigma = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
  if (sigma < 0.75) return;
  const rand = makeLcg(0x9e3779b9);
  const n = w * h;
  for (let p = 0; p < n; p++) {
    if (!unknown[p]) continue;
    const i = p * 4;
    const noise = (rand() / 4294967296 - 0.5) * 2 * sigma * 0.6;
    px[i] += noise; px[i + 1] += noise; px[i + 2] += noise;
  }
}

// ---------- healing-brush fusion ----------

const NEAR_BLACK = 24; // below this target luma there is no chroma worth keeping

/**
 * Fuse one healing-brush dab. `target` is the pristine layer patch, `source`
 * the doc-snapshot patch aligned to the same dab-local grid (both d×d). The
 * source's luminance structure is grafted onto the target chroma; the patch
 * alpha follows the hardness feather, modulated by the target's own alpha so
 * healing never paints into transparency. Draw the result source-over.
 */
export function fuseHealPatch(target: ImageData, source: ImageData, hardness: number): ImageData {
  const w = target.width, h = target.height;
  const out = new ImageData(w, h);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const r = Math.max(1, Math.min(w, h) / 2 - 0.5);
  const core = clamp(hardness, 0, 0.95);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const tA = target.data[i + 3];
      if (tA === 0) continue;
      const dist = Math.hypot(x - cx, y - cy) / r;
      if (dist >= 1) continue;
      // smoothstep feather between the hardness core and the rim
      const t = dist <= core ? 0 : (dist - core) / (1 - core);
      const fall = 1 - t * t * (3 - 2 * t);
      const sa = source.data[i + 3] / 255;
      if (sa <= 0.002) continue; // no source content here — leave the target
      const srcLuma = lumaOf(source.data, i);
      const tgtLuma = lumaOf(target.data, i);
      // ratio fusion: keep the target's chroma ratios, re-base its luma on the
      // source. Near-black targets have no chroma to preserve and the ratio
      // degenerates, so they hand over to the source verbatim.
      const wgt = smoothstep(0, NEAR_BLACK, tgtLuma);
      const k = srcLuma / Math.max(tgtLuma, 8);
      for (let ch = 0; ch < 3; ch++) {
        const ratioC = clamp(target.data[i + ch] * k, 0, 255);
        const fused = source.data[i + ch] * (1 - wgt) + ratioC * wgt;
        // modulate by source alpha: a half-transparent source patch heals weakly
        out.data[i + ch] = target.data[i + ch] * (1 - sa) + fused * sa;
      }
      out.data[i + 3] = fall * tA;
    }
  }
  return out;
}

function lumaOf(d: Uint8ClampedArray, i: number): number {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

function smoothstep(e0: number, e1: number, v: number): number {
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
