// Alpha-channel morphology for layer effects (stroke): dilation by stride-doubling —
// each pass dilates by 2^k via two shifted max reads per axis, so any radius costs
// O(log r) passes regardless of size. Masks are 8-bit planes (the alpha channel).

export function dilatePlane(plane: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let r = Math.round(radius);
  let cur = plane;
  let stride = 1;
  while (r > 0) {
    const take = Math.min(stride, r);
    cur = shiftMax(cur, width, height, take);
    r -= take;
    stride *= 2;
  }
  return cur;
}

export function erodePlane(plane: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const inv = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i++) inv[i] = 255 - plane[i];
  const d = dilatePlane(inv, width, height, radius);
  const out = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i++) out[i] = 255 - d[i];
  return out;
}

/** One separable pass: out = max(p, p shifted by ±take on x, then on y). */
function shiftMax(src: Uint8Array, w: number, h: number, take: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = src[row + Math.max(0, x - take)];
      const r = src[row + Math.min(w - 1, x + take)];
      tmp[row + x] = Math.max(src[row + x], l, r);
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - take) * w;
    const dn = Math.min(h - 1, y + take) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      out[row + x] = Math.max(tmp[row + x], tmp[up + x], tmp[dn + x]);
    }
  }
  return out;
}
