// Content-aware fill (exemplar patch synthesis, ported from the Swift
// ContentFiller): a single deterministic forward pass. Target pixels are filled
// in BFS (onion-peel) order from the boundary inward; each pixel copies the RGBA
// of the best-scoring donor patch, where candidates are the propagated source
// offsets of its 4 neighbors plus 24 LCG-drawn random donors, refined by a
// 6-level diminishing random-window search (r = 64, 32, 16, 8, 4, 1).

export interface ContentFillResult {
  ok: boolean;
  reason?: string;
}

/** Deterministic 32-bit LCG: x = 1664525·x + 1013904223 (mod 2^32). */
function makeLcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => (x = (Math.imul(1664525, x) + 1013904223) >>> 0);
}

const SEARCH_RADII = [64, 32, 16, 8, 4, 1];

/**
 * Fill the target region of `img` (pixels where targetMask != 0) in place.
 * Donors are unselected fully-opaque pixels whose whole 5×5 neighborhood is
 * known (r = 2, or r = 0 when the image is smaller than 5px). Regions that
 * touch only transparency are restarted from a random donor. Deterministic:
 * the LCG is seeded with a fixed constant.
 */
export function contentFill(img: ImageData, targetMask: Uint8Array): ContentFillResult {
  const w = img.width, h = img.height, n = w * h;
  if (targetMask.length !== n) return { ok: false, reason: '掩码尺寸与图像不一致' };
  const d = img.data;
  const rand = makeLcg(0x6d2b79f5);

  const r = Math.min(w, h) >= 5 ? 2 : 0;

  const target = new Uint8Array(n);
  let targetCount = 0;
  for (let p = 0; p < n; p++) {
    if (targetMask[p] !== 0) { target[p] = 1; targetCount++; }
  }
  if (targetCount === 0) return { ok: true };

  // initially known: unselected, fully opaque pixels (transparent non-target
  // pixels stay unknown — they are neither copied nor scored against)
  const known = new Uint8Array(n);
  for (let p = 0; p < n; p++) known[p] = target[p] === 0 && d[p * 4 + 3] === 255 ? 1 : 0;

  // donors: known pixels whose whole (2r+1)² patch is known and in bounds
  const donorFlag = new Uint8Array(n);
  const donors: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!known[p]) continue;
      let okDonor = true;
      for (let dy = -r; dy <= r && okDonor; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          // out-of-bounds cells are unknown → border-adjacent pixels are not donors
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !known[ny * w + nx]) {
            okDonor = false;
            break;
          }
        }
      }
      if (okDonor) { donorFlag[p] = 1; donors.push(p); }
    }
  }
  if (donors.length === 0) {
    return { ok: false, reason: '未选择区域周围没有足够的不透明像素可用作填充源' };
  }

  const chosen = new Int32Array(n).fill(-1); // source pixel index per filled target
  const queue: number[] = [];
  let head = 0;

  const enqueueUnknownNeighbors = (p: number) => {
    const x = p % w, y = (p / w) | 0;
    if (x > 0 && target[p - 1] && !known[p - 1]) queue.push(p - 1);
    if (x < w - 1 && target[p + 1] && !known[p + 1]) queue.push(p + 1);
    if (y > 0 && target[p - w] && !known[p - w]) queue.push(p - w);
    if (y < h - 1 && target[p + w] && !known[p + w]) queue.push(p + w);
  };

  // seed: target pixels 4-adjacent to known pixels (scan order keeps it deterministic)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!target[p] || known[p]) continue;
      if ((x > 0 && known[p - 1]) || (x < w - 1 && known[p + 1]) ||
          (y > 0 && known[p - w]) || (y < h - 1 && known[p + w])) {
        queue.push(p);
      }
    }
  }

  /** Mean squared RGBA difference over the known half of the patch around p. */
  const px = (p: number) => p % w;
  const py = (p: number) => (p / w) | 0;
  const scoreOf = (p: number, src: number): number => {
    const cx = px(p), cy = py(p), sx = px(src), sy = py(src);
    let sum = 0, cnt = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = cx + dx, ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const tp = ty * w + tx;
        if (!known[tp]) continue; // only the KNOWN half participates
        const ti = tp * 4, si = ((sy + dy) * w + (sx + dx)) * 4;
        const a = d[ti] - d[si], b = d[ti + 1] - d[si + 1];
        const c = d[ti + 2] - d[si + 2], e = d[ti + 3] - d[si + 3];
        sum += a * a + b * b + c * c + e * e;
        cnt += 4;
      }
    }
    return cnt ? sum / cnt : 0;
  };

  const copyPixel = (src: number, dst: number) => {
    const si = src * 4, ti = dst * 4;
    d[ti] = d[si]; d[ti + 1] = d[si + 1]; d[ti + 2] = d[si + 2]; d[ti + 3] = d[si + 3];
  };

  let scanCursor = 0; // rolling cursor so restart scans cost O(n) total
  const firstUnfilled = (): number => {
    while (scanCursor < n) {
      const p = scanCursor++;
      if (target[p] && !known[p]) return p;
    }
    return -1;
  };

  let filledCount = 0;
  while (filledCount < targetCount) {
    if (head >= queue.length) {
      // region touching only transparency: restart it from a random donor scan
      const seed = firstUnfilled();
      if (seed < 0) break; // defensive; filledCount should equal targetCount here
      const src = donors[rand() % donors.length];
      copyPixel(src, seed);
      chosen[seed] = src;
      known[seed] = 1;
      filledCount++;
      enqueueUnknownNeighbors(seed);
      continue;
    }
    const p = queue[head++];
    if (known[p]) continue;

    const cx = px(p), cy = py(p);

    // candidates: propagated neighbor offsets + 24 uniform random donors
    const cands: number[] = [];
    const tryPush = (q: number) => { if (donorFlag[q]) cands.push(q); };
    const pushPropagated = (t: number, dx: number, dy: number) => {
      const s = chosen[t];
      if (s < 0) return;
      const qx = px(s) + dx, qy = py(s) + dy;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) return;
      tryPush(qy * w + qx);
    };
    if (cx > 0) pushPropagated(p - 1, -1, 0);
    if (cx < w - 1) pushPropagated(p + 1, 1, 0);
    if (cy > 0) pushPropagated(p - w, 0, -1);
    if (cy < h - 1) pushPropagated(p + w, 0, 1);
    for (let i = 0; i < 24; i++) cands.push(donors[rand() % donors.length]);

    let best = cands[0];
    let bestScore = Infinity;
    for (const c of cands) {
      const s = scoreOf(p, c);
      if (s < bestScore) { bestScore = s; best = c; }
    }

    // 6-level diminishing random-window search around the current best
    for (const level of SEARCH_RADII) {
      for (let k = 0; k < 4; k++) {
        const qx = px(best) + ((rand() % (2 * level + 1)) - level);
        const qy = py(best) + ((rand() % (2 * level + 1)) - level);
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx;
        if (!donorFlag[q]) continue;
        const s = scoreOf(p, q);
        if (s < bestScore) { bestScore = s; best = q; }
      }
    }

    copyPixel(best, p);
    chosen[p] = best;
    known[p] = 1;
    filledCount++;
    enqueueUnknownNeighbors(p);
  }

  return { ok: true };
}
