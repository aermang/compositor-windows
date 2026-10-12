// Liquify workspace deformation engine.
//
// A LiquifyField is a per-pixel displacement grid over the working bitmap:
//   dx/dy  — destination-side displacement: "the content shown at this pixel
//            came from (x-dx, y-dy)" in the source canvas, so writing +d at a
//            pixel visually moves the content there by +d.
//   freeze — 0..1 protection painted by the freeze brush. Every displacement
//            increment is scaled by (1-freeze) and applyField blends frozen
//            pixels back toward the original, so frozen areas stay put.
//
// stampBrush accumulates dabs with a (1-t)^2 radial profile (t = dist/radius,
// the same falloff family the smear tool's Metal shader uses); reconstruct
// walks a field back toward a reference field (progressive revert); applyField
// warps a source canvas through the field by inverse mapping with bilinear
// filtering and edge clamping.

import { makeCanvas, ctx2d, ctx2dRead, clamp } from '../canvasUtils';

export interface LiquifyField {
  w: number;
  h: number;
  dx: Float32Array;
  dy: Float32Array;
  freeze: Float32Array;
}

export type LiquifyStampMode =
  | 'forward' | 'twistCW' | 'twistCCW' | 'pucker' | 'bloat' | 'pushLeft';

export function createField(w: number, h: number): LiquifyField {
  const fw = Math.max(1, Math.round(w));
  const fh = Math.max(1, Math.round(h));
  const n = fw * fh;
  return {
    w: fw,
    h: fh,
    dx: new Float32Array(n),
    dy: new Float32Array(n),
    freeze: new Float32Array(n),
  };
}

/**
 * Paint one brush dab into the field at (cx, cy). The dab writes displacement
 * with a smooth (1-t)^2 radial profile:
 *   forward   — along the drag direction (dirx, diry)
 *   pushLeft  — along the drag direction's left normal (diry, -dirx)
 *   twistCW   — tangential, clockwise on screen; twistCCW counter-clockwise
 *   pucker    — centripetal (toward the dab center); bloat outward
 * The per-dab magnitude scales with the brush radius so big brushes move more.
 * All increments are multiplied by (1-freeze), so frozen pixels never move.
 */
export function stampBrush(
  f: LiquifyField,
  mode: LiquifyStampMode,
  cx: number,
  cy: number,
  radius: number,
  pressure: number,
  dirx: number,
  diry: number,
): void {
  const r = Math.max(1, radius);
  const str = clamp(pressure, 0, 1);
  if (str <= 0) return;
  const { w, h, dx, dy, freeze } = f;
  const K = Math.max(1, r / 30); // big brushes push further per dab
  let ux = dirx;
  let uy = diry;
  const ul = Math.hypot(ux, uy);
  const hasDir = ul > 1e-6;
  if (hasDir) { ux /= ul; uy /= ul; }

  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const ry = y - cy;
    for (let x = x0; x <= x1; x++) {
      const rx = x - cx;
      const dist = Math.hypot(rx, ry);
      if (dist >= r) continue;
      const t = dist / r;
      const profile = (1 - t) * (1 - t);
      const s = str * profile;
      if (s <= 0) continue;
      const i = y * w + x;
      const gate = 1 - freeze[i];
      if (gate <= 0) continue;

      let ix = 0;
      let iy = 0;
      if (mode === 'forward') {
        ix = ux * s * K;
        iy = uy * s * K;
      } else if (mode === 'pushLeft') {
        // left of travel on screen (y down): rotate dir by -90°
        ix = uy * s * K;
        iy = -ux * s * K;
      } else if (mode === 'twistCW') {
        const k = (s * K) / r;
        ix = -ry * k;
        iy = rx * k;
      } else if (mode === 'twistCCW') {
        const k = (s * K) / r;
        ix = ry * k;
        iy = -rx * k;
      } else {
        // pucker / bloat: radial; divide by max(dist,1) keeps the center singularity smooth
        const k = (s * K) / Math.max(dist, 1);
        const sign = mode === 'pucker' ? -1 : 1;
        ix = rx * k * sign;
        iy = ry * k * sign;
      }
      dx[i] += ix * gate;
      dy[i] += iy * gate;
    }
  }
}

/**
 * Walk the field f back toward src by amount (0..1). The dialog holds an empty
 * reference field so the reconstruct tool progressively reverts the warping;
 * freeze is untouched (unfreezing is the freeze brush's job).
 */
export function reconstruct(f: LiquifyField, src: LiquifyField, amount: number): void {
  const a = clamp(amount, 0, 1);
  if (a <= 0) return;
  const n = Math.min(f.dx.length, src.dx.length);
  if (a >= 1) {
    f.dx.set(src.dx.subarray(0, n));
    f.dy.set(src.dy.subarray(0, n));
    return;
  }
  for (let i = 0; i < n; i++) {
    f.dx[i] += (src.dx[i] - f.dx[i]) * a;
    f.dy[i] += (src.dy[i] - f.dy[i]) * a;
  }
}

/**
 * Warp src through the field by inverse mapping: for each target pixel (x, y)
 * the source sample is bilinearly taken at (x - dx, y - dy), clamped to the
 * canvas edges. Near-zero displacements take an identity fast path so
 * untouched and fully frozen regions stay byte-exact; partially frozen pixels
 * (freeze > 0) blend the warped sample back toward the original pixel.
 * Returns a new canvas; src is never mutated.
 */
export function applyField(src: HTMLCanvasElement, f: LiquifyField): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const out = makeCanvas(w, h);
  const sd = ctx2dRead(src).getImageData(0, 0, w, h).data;
  const octx = ctx2d(out);
  const img = octx.createImageData(w, h);
  const od = img.data;
  const fw = f.w;
  const fh = f.h;
  const fdx = f.dx;
  const fdy = f.dy;
  const fz = f.freeze;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    const frow = y < fh ? y * fw : -1;
    for (let x = 0; x < w; x++) {
      const o = (row + x) * 4;
      const fi = frow >= 0 && x < fw ? frow + x : -1;
      const dxv = fi >= 0 ? fdx[fi] : 0;
      const dyv = fi >= 0 ? fdy[fi] : 0;

      if (dxv * dxv + dyv * dyv < 1e-6) {
        // identity (covers the zero field and fully frozen pixels)
        od[o] = sd[o];
        od[o + 1] = sd[o + 1];
        od[o + 2] = sd[o + 2];
        od[o + 3] = sd[o + 3];
        continue;
      }

      let sx = x - dxv;
      let sy = y - dyv;
      if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
      if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1;
      const xi = Math.floor(sx);
      const yi = Math.floor(sy);
      const xj = xi + 1 < w ? xi + 1 : xi;
      const yj = yi + 1 < h ? yi + 1 : yi;
      const fx = sx - xi;
      const fy = sy - yi;
      const gx = 1 - fx;
      const gy = 1 - fy;
      const i00 = (yi * w + xi) * 4;
      const i10 = (yi * w + xj) * 4;
      const i01 = (yj * w + xi) * 4;
      const i11 = (yj * w + xj) * 4;
      const fzv = fi >= 0 ? fz[fi] : 0;
      for (let ch = 0; ch < 4; ch++) {
        const top = sd[i00 + ch] * gx + sd[i10 + ch] * fx;
        const bot = sd[i01 + ch] * gx + sd[i11 + ch] * fx;
        let v = top * gy + bot * fy;
        if (fzv > 0) v = v * (1 - fzv) + sd[o + ch] * fzv;
        od[o + ch] = v;
      }
    }
  }

  octx.putImageData(img, 0, 0);
  return out;
}
