// Corner-pin distort, ported from Compositor's Swift DistortRenderer
// (CoreImage CIPerspectiveTransform + a folded-quad triangle fallback).
//
// Convex quads: exact homography, per-destination-pixel inverse mapping with
// premultiplied bilinear sampling — pure JS, acceptable for a one-shot op.
// Non-convex/folded quads: split along the TL-BR diagonal into two triangles,
// each drawn with an exact affine (setTransform + clip + drawImage). Canvas 2D
// cannot disable path antialiasing the way the Metal source did, so the seam
// on the shared diagonal is healed by nudging each half's clip 0.5px across
// the seam (the two halves sample the same source line there, so the overlap
// composites to the correct color).

import { makeCanvas, ctx2d, ctx2dRead } from './canvasUtils';

/** Quad corners in order TL, TR, BR, BL. */
export type Quad = [x: number, y: number][];

type Pt = [number, number];

/**
 * Closed-form homography src -> dst with h33 = 1, as 8 coefficients
 * [a,b,c,d,e,f,g,h]:
 *   X = (a*x + b*y + c) / (g*x + h*y + 1)
 *   Y = (d*x + e*y + f) / (g*x + h*y + 1)
 * Returns null for degenerate inputs (singular system / failed round-trip).
 */
export function homography(src: Quad, dst: Quad): number[] | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const A: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); rhs.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); rhs.push(Y);
  }
  // Gaussian elimination with partial pivoting on the 8x8 system.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[piv][col])) piv = row;
    }
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const tr = A[piv]; A[piv] = A[col]; A[col] = tr;
      const tv = rhs[piv]; rhs[piv] = rhs[col]; rhs[col] = tv;
    }
    for (let row = col + 1; row < 8; row++) {
      const factor = A[row][col] / A[col][col];
      if (factor === 0) continue;
      for (let k = col; k < 8; k++) A[row][k] -= factor * A[col][k];
      rhs[row] -= factor * rhs[col];
    }
  }
  const h = new Array<number>(8).fill(0);
  for (let row = 7; row >= 0; row--) {
    let s = rhs[row];
    for (let k = row + 1; k < 8; k++) s -= A[row][k] * h[k];
    h[row] = s / A[row][row];
  }
  // Round-trip check: catches ill-conditioned inputs the pivot test missed.
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    const den = h[6] * x + h[7] * y + 1;
    if (Math.abs(den) < 1e-9) return null;
    const err = Math.hypot(
      (h[0] * x + h[1] * y + h[2]) / den - X,
      (h[3] * x + h[4] * y + h[5]) / den - Y,
    );
    if (err > 1e-3 * (1 + Math.abs(X) + Math.abs(Y))) return null;
  }
  return h;
}

/** True when the quad is convex (consistent winding; collinear edges allowed). */
export function isConvex(q: Quad): boolean {
  if (q.length !== 4) return false;
  let pos = false, neg = false;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross > 0) pos = true;
    else if (cross < 0) neg = true;
  }
  return pos !== neg;
}

/**
 * Warp the whole `src` canvas onto the destination quad. Returns a canvas the
 * size of the quad's whole-pixel bounding box (floor min, ceil max), with the
 * quad's TL corner at the bbox origin.
 */
export function renderDistort(src: HTMLCanvasElement, dst: Quad): HTMLCanvasElement {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of dst) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bx = Math.floor(minX), by = Math.floor(minY);
  const out = makeCanvas(Math.ceil(maxX) - bx, Math.ceil(maxY) - by);
  const local: Quad = dst.map(([x, y]) => [x - bx, y - by]);

  const W = src.width, H = src.height;
  let hm: number[] | null = null;
  if (isConvex(dst)) {
    // Inverse map: destination pixel center -> source pixel, via dst -> corners.
    hm = homography(dst, [[0, 0], [W, 0], [W, H], [0, H]] as Quad);
  }
  if (hm) {
    renderHomography(src, out, hm);
  } else {
    drawTriangleHalves(out, src, local);
  }
  return out;
}

/** Crop to the alpha bounds (first/last row & column with alpha > 0). */
export function warpTrimmed(c: HTMLCanvasElement): HTMLCanvasElement {
  const W = c.width, H = c.height;
  const d = ctx2dRead(c).getImageData(0, 0, W, H).data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      if (d[row + x * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return makeCanvas(1, 1); // fully transparent
  const out = makeCanvas(maxX - minX + 1, maxY - minY + 1);
  ctx2d(out).drawImage(c, -minX, -minY);
  return out;
}

// ---------------------------------------------------------------- internals

/** Per-pixel inverse-map render of H (dest -> src) with bilinear sampling. */
function renderHomography(src: HTMLCanvasElement, out: HTMLCanvasElement, hm: number[]): void {
  const W = src.width, H = src.height;
  const sd = ctx2dRead(src).getImageData(0, 0, W, H).data;
  const octx = ctx2dRead(out);
  const img = octx.createImageData(out.width, out.height);
  const od = img.data;
  const [a, b, c, d, e, f, g, h] = hm;
  const Ow = out.width, Oh = out.height;
  for (let py = 0; py < Oh; py++) {
    const cy = py + 0.5;
    for (let px = 0; px < Ow; px++) {
      const cx = px + 0.5;
      const den = g * cx + h * cy + 1;
      if (den === 0) continue;
      const sx = (a * cx + b * cy + c) / den;
      const sy = (d * cx + e * cy + f) / den;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const cxp = Math.min(sx, W - 1), cyp = Math.min(sy, H - 1);
      const x0 = Math.floor(cxp), y0 = Math.floor(cyp);
      const x1 = x0 + 1 < W ? x0 + 1 : x0;
      const y1 = y0 + 1 < H ? y0 + 1 : y0;
      const tx = cxp - x0, ty = cyp - y0;
      const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
      const i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty, w11 = tx * ty;
      // Premultiplied bilinear: weight colors by corner alpha, then divide out.
      const a00 = sd[i00 + 3], a10 = sd[i10 + 3], a01 = sd[i01 + 3], a11 = sd[i11 + 3];
      const al = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
      const o = (py * Ow + px) * 4;
      if (al <= 1e-3) continue; // stays transparent
      od[o] = (sd[i00] * a00 * w00 + sd[i10] * a10 * w10 + sd[i01] * a01 * w01 + sd[i11] * a11 * w11) / al;
      od[o + 1] = (sd[i00 + 1] * a00 * w00 + sd[i10 + 1] * a10 * w10 + sd[i01 + 1] * a01 * w01 + sd[i11 + 1] * a11 * w11) / al;
      od[o + 2] = (sd[i00 + 2] * a00 * w00 + sd[i10 + 2] * a10 * w10 + sd[i01 + 2] * a01 * w01 + sd[i11 + 2] * a11 * w11) / al;
      od[o + 3] = al;
    }
  }
  octx.putImageData(img, 0, 0);
}

/** Overlap (px) that heals the AA seam canvas leaves on the shared diagonal. */
const DIAGONAL_OVERLAP = 0.5;

/** Exact affine mapping a source triangle onto a destination triangle, or null. */
function affineFromTriangles(s3: Pt[], d3: Pt[]): [number, number, number, number, number, number] | null {
  const [x1, y1] = s3[0], [x2, y2] = s3[1], [x3, y3] = s3[2];
  const [u1, v1] = d3[0], [u2, v2] = d3[1], [u3, v3] = d3[2];
  const det = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
  if (Math.abs(det) < 1e-9) return null;
  // u = A*x + B*y + C ; v = D*x + E*y + F (Cramer on the 2x2 reduced system)
  const A = ((u2 - u1) * (y3 - y1) - (u3 - u1) * (y2 - y1)) / det;
  const B = ((u3 - u1) * (x2 - x1) - (u2 - u1) * (x3 - x1)) / det;
  const C = u1 - A * x1 - B * y1;
  const D = ((v2 - v1) * (y3 - y1) - (v3 - v1) * (y2 - y1)) / det;
  const E = ((v3 - v1) * (x2 - x1) - (v2 - v1) * (x3 - x1)) / det;
  const F = v1 - D * x1 - E * y1;
  return [A, B, C, D, E, F];
}

/** Clip to the destination triangle, then drawImage through the affine. */
function drawAffineTriangle(
  ctx: CanvasRenderingContext2D, image: HTMLCanvasElement, s3: Pt[], d3: Pt[],
): void {
  const m = affineFromTriangles(s3, d3);
  if (!m) return;
  const [A, B, C, D, E, F] = m;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d3[0][0], d3[0][1]);
  ctx.lineTo(d3[1][0], d3[1][1]);
  ctx.lineTo(d3[2][0], d3[2][1]);
  ctx.closePath();
  ctx.clip();
  // canvas transform(): x' = a*x + c*y + e ; y' = b*x + d*y + f
  ctx.transform(A, D, B, E, C, F);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

/** Displace edge a->b by d px along its normal, pointing away from `awayFrom`. */
function pushEdge(a: Pt, b: Pt, awayFrom: Pt, d: number): [Pt, Pt] {
  let nx = b[1] - a[1], ny = -(b[0] - a[0]);
  const len = Math.hypot(nx, ny);
  if (len < 1e-9) return [a, b];
  nx /= len; ny /= len;
  if ((awayFrom[0] - a[0]) * nx + (awayFrom[1] - a[1]) * ny > 0) {
    nx = -nx; ny = -ny;
  }
  return [[a[0] + nx * d, a[1] + ny * d], [b[0] + nx * d, b[1] + ny * d]];
}

/** Folded-quad fallback: TL-TR-BR and TL-BR-BL halves on the TL-BR diagonal. */
function drawTriangleHalves(out: HTMLCanvasElement, src: HTMLCanvasElement, d: Quad): void {
  const W = src.width, H = src.height;
  const sTL: Pt = [0, 0], sTR: Pt = [W, 0], sBR: Pt = [W, H], sBL: Pt = [0, H];
  const TL: Pt = d[0], TR: Pt = d[1], BR: Pt = d[2], BL: Pt = d[3];
  const ctx = ctx2d(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Half 1: TL-TR-BR, shared edge TL-BR nudged away from TR.
  const [a1, c1] = pushEdge(TL, BR, TR, DIAGONAL_OVERLAP);
  drawAffineTriangle(ctx, src, [sTL, sTR, sBR], [a1, TR, c1]);
  // Half 2: TL-BR-BL, shared edge nudged away from BL (the opposite side).
  const [a2, c2] = pushEdge(TL, BR, BL, DIAGONAL_OVERLAP);
  drawAffineTriangle(ctx, src, [sTL, sBR, sBL], [a2, c2, BL]);
}
