// Puppet Warp (操控变形) mesh deformation engine.
//
// A PuppetMesh is a regular grid of (gx+1)×(gy+1) grid points over the working
// bitmap. ox/oy hold each grid point's DISPLACEMENT from its rest position
// (rest position of grid point j = (col*sx, row*sy), sx = w/gx, sy = h/gy).
//
// solveMesh derives those displacements from the pins with inverse-distance
// weighting (IDW): each pin contributes its own displacement D_i = target -
// rest, weighted by w = 1/(d² + ε) measured from the grid point's rest
// position to the pin's rest position. Nearby grid points inherit the pin's
// motion, far points converge to the (small) weighted average — with at least
// one other pin acting as an anchor, content near the anchor stays put. This
// is the deliberately simple stand-in for full ARAP; a single dragged pin
// therefore translates the whole layer (nothing anchors it), which matches
// Photoshop's behaviour for one pin.
//
// Pins snap to the nearest grid point (pinCells) so their weight concentrates
// on exactly one grid point and the dragged content tracks the pin cleanly.
//
// renderWarped draws the source through the mesh with the classic per-triangle
// affine trick: each cell splits into two triangles, the triangle is clipped
// out and the source is drawn through the affine map rest→deformed corners.
// An identity base blit first keeps untouched regions byte-exact, triangles
// whose corners move less than ~0.05px are skipped, and each triangle is
// inset a half pixel toward its centroid so seams never show white/transparent
// hairlines (the base blit shows through instead).

import { makeCanvas, ctx2d, clamp } from '../canvasUtils';

export interface PuppetPin { x: number; y: number }

export interface PuppetMesh {
  w: number;
  h: number;
  gx: number;            // cells horizontally
  gy: number;            // cells vertically
  ox: Float32Array;      // per-grid-point displacement from rest
  oy: Float32Array;
}

/** Pin → grid-point binding: `pin` (index into the pin list) rests on `cell`. */
export interface PinCell { cell: number; pin: number }

export function createMesh(w: number, h: number, spacing = 32): PuppetMesh {
  const sp = clamp(spacing, 2, 512);
  const gx = Math.max(1, Math.round(w / sp));
  const gy = Math.max(1, Math.round(h / sp));
  const n = (gx + 1) * (gy + 1);
  return { w: Math.round(w), h: Math.round(h), gx, gy, ox: new Float32Array(n), oy: new Float32Array(n) };
}

/** Grid step (pixels per cell) of the mesh. */
export function gridStep(mesh: PuppetMesh): { sx: number; sy: number } {
  return { sx: mesh.w / mesh.gx, sy: mesh.h / mesh.gy };
}

/** Rest position of a grid point (cell index = row*(gx+1)+col). */
export function cellPoint(mesh: PuppetMesh, cell: number): { x: number; y: number } {
  const { sx, sy } = gridStep(mesh);
  const col = cell % (mesh.gx + 1);
  const row = Math.floor(cell / (mesh.gx + 1));
  return { x: col * sx, y: row * sy };
}

/** Nearest grid point (index) to a working-space position. */
export function snapToCell(mesh: PuppetMesh, x: number, y: number): number {
  const { sx, sy } = gridStep(mesh);
  const col = clamp(Math.round(x / sx), 0, mesh.gx);
  const row = clamp(Math.round(y / sy), 0, mesh.gy);
  return row * (mesh.gx + 1) + col;
}

/**
 * Recompute mesh displacements from the pins. pinCells binds each pin to the
 * grid point it was snapped onto; a pin's displacement is measured from that
 * grid point's rest position to its current target. `dragged` (the pin being
 * dragged and its live position) overrides the pin-list position for that pin.
 * With no pins the mesh resets to identity.
 */
export function solveMesh(
  mesh: PuppetMesh,
  pins: PuppetPin[],
  pinCells: PinCell[],
  dragged?: { pin: number; x: number; y: number },
): void {
  mesh.ox.fill(0);
  mesh.oy.fill(0);
  const cn = pinCells.length;
  if (!cn) return;

  const { sx, sy } = gridStep(mesh);
  const cols = mesh.gx + 1;

  // Constraint table: rest position + displacement of each pin.
  const ax = new Float64Array(cn);
  const ay = new Float64Array(cn);
  const dx = new Float64Array(cn);
  const dy = new Float64Array(cn);
  for (let k = 0; k < cn; k++) {
    const { cell, pin } = pinCells[k];
    const rx = (cell % cols) * sx;
    const ry = Math.floor(cell / cols) * sy;
    ax[k] = rx;
    ay[k] = ry;
    let tx = rx;
    let ty = ry;
    const p = pins[pin];
    if (dragged && dragged.pin === pin) {
      tx = dragged.x;
      ty = dragged.y;
    } else if (p) {
      tx = p.x;
      ty = p.y;
    }
    dx[k] = tx - rx;
    dy[k] = ty - ry;
  }

  // IDW over the grid. ε = 0.01px² keeps the on-pin grid point dominated by
  // that pin (w = 100 there vs ~1e-3 for a cell a spacing away).
  const n = cols * (mesh.gy + 1);
  for (let j = 0; j < n; j++) {
    const px = (j % cols) * sx;
    const py = Math.floor(j / cols) * sy;
    let ws = 0;
    let ix = 0;
    let iy = 0;
    for (let k = 0; k < cn; k++) {
      const ddx = px - ax[k];
      const ddy = py - ay[k];
      const w = 1 / (ddx * ddx + ddy * ddy + 0.01);
      ws += w;
      ix += w * dx[k];
      iy += w * dy[k];
    }
    if (ws > 0) {
      mesh.ox[j] = ix / ws;
      mesh.oy[j] = iy / ws;
    }
  }
}

const SKIP_EPS = 0.05;   // triangle corners below this motion render as identity
const INSET = 0.4;       // triangle inset (px) toward centroid, hides seams

/**
 * Warp `src` through the mesh by per-triangle affine drawing. Returns a new
 * canvas; `src` is never mutated. Identity regions come from an exact base
 * blit, so a mesh with no displacement reproduces the source byte-for-byte.
 */
export function renderWarped(src: HTMLCanvasElement, mesh: PuppetMesh): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const c = ctx2d(out);
  c.drawImage(src, 0, 0);

  const cols = mesh.gx + 1;
  const rows = mesh.gy + 1;
  const n = cols * rows;
  const { sx, sy } = gridStep(mesh);

  // Deformed grid point positions.
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    px[j] = (j % cols) * sx + mesh.ox[j];
    py[j] = Math.floor(j / cols) * sy + mesh.oy[j];
  }

  for (let row = 0; row < mesh.gy; row++) {
    for (let col = 0; col < mesh.gx; col++) {
      const p00 = row * cols + col;
      const p10 = p00 + 1;
      const p01 = p00 + cols;
      const p11 = p01 + 1;
      drawTri(c, src, mesh, p00, p11, p10, px, py);
      drawTri(c, src, mesh, p00, p01, p11, px, py);
    }
  }
  return out;
}

/** Draw one mesh triangle: skip when identity, clip + affine otherwise. */
function drawTri(
  c: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  mesh: PuppetMesh,
  a: number, b: number, d: number,          // corner grid-point indices
  px: Float32Array, py: Float32Array,       // deformed grid positions
): void {
  const oa = Math.max(Math.abs(mesh.ox[a]), Math.abs(mesh.oy[a]));
  const ob = Math.max(Math.abs(mesh.ox[b]), Math.abs(mesh.oy[b]));
  const od = Math.max(Math.abs(mesh.ox[d]), Math.abs(mesh.oy[d]));
  if (Math.max(oa, ob, od) < SKIP_EPS) return; // identity: base blit shows through

  const { sx, sy } = gridStep(mesh);
  const cols = mesh.gx + 1;
  const ra: [number, number] = [(a % cols) * sx, Math.floor(a / cols) * sy];
  const rb: [number, number] = [(b % cols) * sx, Math.floor(b / cols) * sy];
  const rd: [number, number] = [(d % cols) * sx, Math.floor(d / cols) * sy];
  const da: [number, number] = [px[a], py[a]];
  const db: [number, number] = [px[b], py[b]];
  const dd: [number, number] = [px[d], py[d]];

  // Affine map rest → deformed (6 params), solving M·[x y 1]ᵀ = [u v]ᵀ.
  const det = (rb[0] - ra[0]) * (rd[1] - ra[1]) - (rd[0] - ra[0]) * (rb[1] - ra[1]);
  if (!isFinite(det) || Math.abs(det) < 1e-9) return; // degenerate triangle
  const ma = ((db[0] - da[0]) * (rd[1] - ra[1]) - (dd[0] - da[0]) * (rb[1] - ra[1])) / det;
  const mb = ((db[1] - da[1]) * (rd[1] - ra[1]) - (dd[1] - da[1]) * (rb[1] - ra[1])) / det;
  const mc = ((dd[0] - da[0]) * (rb[0] - ra[0]) - (db[0] - da[0]) * (rd[0] - ra[0])) / det;
  const md = ((dd[1] - da[1]) * (rb[0] - ra[0]) - (db[1] - da[1]) * (rd[0] - ra[0])) / det;
  const me = da[0] - ma * ra[0] - mc * ra[1];
  const mf = da[1] - mb * ra[0] - md * ra[1];

  // Dest triangle inset toward its centroid to avoid seam overdraw; the base
  // blit shows through the hairline gaps instead of white seams.
  const gx = (da[0] + db[0] + dd[0]) / 3;
  const gy = (da[1] + db[1] + dd[1]) / 3;
  const ins = (p: [number, number]): [number, number] => {
    const vx = p[0] - gx;
    const vy = p[1] - gy;
    const len = Math.hypot(vx, vy);
    if (len < 1e-3) return p;
    const k = Math.max(0, len - INSET) / len;
    return [gx + vx * k, gy + vy * k];
  };
  const ia = ins(da);
  const ib = ins(db);
  const id = ins(dd);

  c.save();
  c.beginPath();
  c.moveTo(ia[0], ia[1]);
  c.lineTo(ib[0], ib[1]);
  c.lineTo(id[0], id[1]);
  c.closePath();
  c.clip();
  c.transform(ma, mb, mc, md, me, mf);
  // Source-space bbox of the rest triangle limits sampling work; the transform
  // maps the same rect back onto itself so the result is identical to drawing
  // the whole source.
  const bx = Math.max(0, Math.floor(Math.min(ra[0], rb[0], rd[0])) - 1);
  const by = Math.max(0, Math.floor(Math.min(ra[1], rb[1], rd[1])) - 1);
  const bx1 = Math.min(src.width, Math.ceil(Math.max(ra[0], rb[0], rd[0])) + 1);
  const by1 = Math.min(src.height, Math.ceil(Math.max(ra[1], rb[1], rd[1])) + 1);
  const bw = bx1 - bx;
  const bh = by1 - by;
  if (bw > 0 && bh > 0) c.drawImage(src, bx, by, bw, bh, bx, by, bw, bh);
  c.restore();
}
