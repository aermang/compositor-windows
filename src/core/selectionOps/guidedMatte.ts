// Fast guided filter (He, Sun, Tang — "Guided Image Filtering", ECCV 2010) on
// Float32 planes, ported from the Swift implementation used for matte refinement.
// Box means use two separable running-sum passes with edge replication, so the
// cost is O(w·h) regardless of radius.

/** Box mean with edge clamping/replication over a (2r+1)² window, separable. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const win = 2 * r + 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

  // horizontal pass: prefix sums per row, replicate edges so every window has win samples
  const rowP = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    const P = rowP;
    for (let x = 0; x < w; x++) { acc += src[row + x]; P[x + 1] = acc; }
    const first = src[row], last = src[row + w - 1];
    for (let x = 0; x < w; x++) {
      const lo = x - r, hi = x + r;
      const loC = lo < 0 ? 0 : lo;
      const hiC = hi > w - 1 ? w - 1 : hi;
      let sum = P[hiC + 1] - P[loC];
      if (lo < 0) sum += -lo * first;
      if (hi > w - 1) sum += (hi - (w - 1)) * last;
      tmp[row + x] = sum / win;
    }
  }

  // vertical pass over columns
  const colP = new Float64Array(h + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    const P = colP;
    for (let y = 0; y < h; y++) { acc += tmp[y * w + x]; P[y + 1] = acc; }
    const first = tmp[x], last = tmp[(h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      const lo = y - r, hi = y + r;
      const loC = lo < 0 ? 0 : lo;
      const hiC = hi > h - 1 ? h - 1 : hi;
      let sum = P[hiC + 1] - P[loC];
      if (lo < 0) sum += -lo * first;
      if (hi > h - 1) sum += (hi - (h - 1)) * last;
      out[y * w + x] = sum / win;
    }
  }
  return out;
}

/**
 * Guided filter: smooth `input` while transferring the edges of `guide`
 * (grayscale 0..1). Returns q = clamp(box(a)·I + box(b), 0..1) where
 * a = cov(I,p)/(var(I)+eps) and b = meanP − a·meanI per box window.
 */
export function guidedFilter(
  guide: Float32Array, // gray 0..1
  input: Float32Array,
  w: number,
  h: number,
  radius: number,
  eps = 1e-4,
): Float32Array {
  const n = w * h;
  const r = Math.max(0, Math.round(radius));

  const meanI = boxMean(guide, w, h, r);
  const meanP = boxMean(input, w, h, r);

  const ip = new Float32Array(n);
  const ii = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ip[i] = guide[i] * input[i];
    ii[i] = guide[i] * guide[i];
  }
  const covIP = boxMean(ip, w, h, r);
  const varI = boxMean(ii, w, h, r);

  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varIi = varI[i] - meanI[i] * meanI[i];
    const covIi = covIP[i] - meanI[i] * meanP[i];
    a[i] = covIi / (varIi + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }

  const meanA = boxMean(a, w, h, r);
  const meanB = boxMean(b, w, h, r);

  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = meanA[i] * guide[i] + meanB[i];
    q[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return q;
}

/** Area-average downsample of a plane to (sw, sh). */
function downsample(src: Float32Array, w: number, h: number, sw: number, sh: number): Float32Array {
  const out = new Float32Array(sw * sh);
  for (let ly = 0; ly < sh; ly++) {
    const y0 = Math.floor((ly * h) / sh), y1 = Math.max(y0 + 1, Math.floor(((ly + 1) * h) / sh));
    for (let lx = 0; lx < sw; lx++) {
      const x0 = Math.floor((lx * w) / sw), x1 = Math.max(x0 + 1, Math.floor(((lx + 1) * w) / sw));
      let acc = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) acc += src[row + x];
      }
      out[ly * sw + lx] = acc / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Bilinear upsample of a plane from (sw, sh) to (w, h) with clamped sampling. */
function upsample(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * sh / h - 0.5;
    const y0 = Math.floor(fy);
    const cy = Math.min(sh - 1, Math.max(0, y0));
    const cy1 = Math.min(sh - 1, Math.max(0, y0 + 1));
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) * sw / w - 0.5;
      const x0 = Math.floor(fx);
      const cx = Math.min(sw - 1, Math.max(0, x0));
      const cx1 = Math.min(sw - 1, Math.max(0, x0 + 1));
      const tx = fx - x0;
      const v00 = src[cy * sw + cx], v10 = src[cy * sw + cx1];
      const v01 = src[cy1 * sw + cx], v11 = src[cy1 * sw + cx1];
      out[y * w + x] =
        v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) +
        v01 * (1 - tx) * ty + v11 * tx * ty;
    }
  }
  return out;
}

/**
 * Refine a matte on a downscaled copy when the long side exceeds `maxSide`
 * (radius scaled proportionally), then bilinearly upsample back to full size.
 */
export function refineMatte(
  guideGray: Float32Array,
  matte: Float32Array,
  w: number,
  h: number,
  radius: number,
  maxSide = 1400,
): Float32Array {
  const longSide = Math.max(w, h);
  if (longSide <= maxSide) return guidedFilter(guideGray, matte, w, h, radius, 1e-4);

  const scale = maxSide / longSide;
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const sr = Math.max(1, Math.round(radius * scale));

  const smallGuide = downsample(guideGray, w, h, sw, sh);
  const smallMatte = downsample(matte, w, h, sw, sh);
  const refined = guidedFilter(smallGuide, smallMatte, sw, sh, sr, 1e-4);
  return upsample(refined, sw, sh, w, h);
}
