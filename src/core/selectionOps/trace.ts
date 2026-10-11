// Crack-following outline tracer for binary masks (ported from the C `trace_outline`).
// Directed unit edges live on the (w+1)×(h+1) vertex grid; every selected pixel with
// an unselected 4-neighbor contributes the boundary edge oriented so the selected
// pixel is on the LEFT of the walking direction (top edge westward, right edge
// northward, bottom edge eastward, left edge southward). Loops are chained through
// a vertex adjacency map, collinear vertices are dropped, and the returned Path2D
// uses winding (nonzero) fill — holes wind opposite to outer loops, so filling
// reproduces the exact selected pixels.

export interface TracedOutline {
  contours: Array<Array<[number, number]>>;
  path: Path2D;
}

export interface PlaneMask {
  mask: Uint8Array; // 0/255, w×h
  w: number;
  h: number;
}

const EDGE_LIMIT = 8_000_000;

/** Unpremultiplied luma (0..255) of a premultiplied RGBA pixel; 0 when transparent. */
function lumaAt(d: Uint8ClampedArray, i: number): number {
  const a = d[i + 3];
  if (a === 0) return 0;
  const r = Math.min(255, (d[i] * 255 + a / 2) / a);
  const g = Math.min(255, (d[i + 1] * 255 + a / 2) / a);
  const b = Math.min(255, (d[i + 2] * 255 + a / 2) / a);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Trace the outline of a binary mask (pixel selected iff value >= 128) into closed
 * corner polylines plus a winding-fill Path2D. If the boundary exceeds 8M edges the
 * trace falls back to the largest 4-connected selected component; if even that is
 * too complex it throws '选区过于复杂'.
 */
export function traceOutline(mask: Uint8Array, w: number, h: number): TracedOutline {
  let m = mask;
  let edges = countEdges(m, w, h);
  if (edges > EDGE_LIMIT) {
    m = largestComponent(m, w, h);
    edges = countEdges(m, w, h);
    if (edges > EDGE_LIMIT) throw new Error('选区过于复杂');
  }

  const vw = w + 1;
  const sel = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] >= 128;

  // vertex id = vy*(w+1)+vx; adjacency: start vertex → end vertices
  const adj = new Map<number, number[]>();
  const addEdge = (from: number, to: number) => {
    let list = adj.get(from);
    if (!list) adj.set(from, (list = []));
    list.push(to);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!sel(x, y)) continue;
      const vTL = y * vw + x, vTR = vTL + 1, vBL = vTL + vw, vBR = vBL + 1;
      if (!sel(x, y - 1)) addEdge(vTR, vTL); // top, westward
      if (!sel(x + 1, y)) addEdge(vBR, vTR); // right, northward
      if (!sel(x, y + 1)) addEdge(vBL, vBR); // bottom, eastward
      if (!sel(x - 1, y)) addEdge(vTL, vBL); // left, southward
    }
  }

  const dirIndex = (from: number, to: number): number => {
    const d = to - from;
    return d === 1 ? 0 : d === vw ? 1 : d === -1 ? 2 : 3; // E, S, W, N
  };
  // used-edge key: start*4 + direction (two edges from one vertex never share a direction)
  const used = new Set<number>();
  const usedKey = (from: number, to: number) => from * 4 + dirIndex(from, to);

  const vx = (v: number) => v % vw;
  const vy = (v: number) => (v / vw) | 0;
  const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

  const contours: Array<Array<[number, number]>> = [];
  let budget = edges + 16;

  for (const [startV, ends] of adj) {
    for (const firstEnd of ends) {
      if (used.has(usedKey(startV, firstEnd))) continue;
      used.add(usedKey(startV, firstEnd));
      const pts: number[] = [startV];
      let prev = startV, cur = firstEnd;
      while (cur !== startV) {
        pts.push(cur);
        if (--budget < 0) break; // structural safety net; cannot happen on a valid grid
        const outs = adj.get(cur);
        let next = -1, bestTurn = 0;
        if (outs) {
          for (const cand of outs) {
            const key = cur * 4 + dirIndex(cur, cand);
            if (used.has(key)) continue;
            // prefer the sharpest turn that keeps the region on the left
            // (smallest cross product of incoming and outgoing directions)
            const turn = cross(
              vx(cur) - vx(prev), vy(cur) - vy(prev),
              vx(cand) - vx(cur), vy(cand) - vy(cur),
            );
            if (next < 0 || turn < bestTurn) { next = cand; bestTurn = turn; }
          }
        }
        if (next < 0) break; // open chain (should not happen); drop rather than loop forever
        used.add(cur * 4 + dirIndex(cur, next));
        prev = cur;
        cur = next;
      }
      if (pts.length < 3) continue;

      // drop collinear vertices, keep corners (cyclic)
      const n = pts.length;
      const contour: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        const p = pts[(i - 1 + n) % n], q = pts[i], r = pts[(i + 1) % n];
        if (cross(vx(q) - vx(p), vy(q) - vy(p), vx(r) - vx(q), vy(r) - vy(q)) !== 0) {
          contour.push([vx(q), vy(q)]);
        }
      }
      if (contour.length >= 3) contours.push(contour);
    }
  }

  const path = new Path2D();
  for (const c of contours) {
    path.moveTo(c[0][0], c[0][1]);
    for (let i = 1; i < c.length; i++) path.lineTo(c[i][0], c[i][1]);
    path.closePath();
  }
  return { contours, path };
}

/** Number of directed boundary edges of the mask (<= 4 per selected pixel). */
function countEdges(mask: Uint8Array, w: number, h: number): number {
  const sel = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] >= 128;
  let edges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!sel(x, y)) continue;
      if (!sel(x, y - 1)) edges++;
      if (!sel(x + 1, y)) edges++;
      if (!sel(x, y + 1)) edges++;
      if (!sel(x - 1, y)) edges++;
    }
  }
  return edges;
}

/** Reduced mask holding only the largest 4-connected selected component. */
function largestComponent(mask: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  let best = -1, bestSize = 0, next = 0;
  for (let seed = 0; seed < w * h; seed++) {
    if (label[seed] !== -1 || mask[seed] < 128) continue;
    const id = next++;
    let size = 0;
    stack.push(seed);
    label[seed] = id;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && label[p - 1] === -1 && mask[p - 1] >= 128) { label[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && label[p + 1] === -1 && mask[p + 1] >= 128) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && label[p - w] === -1 && mask[p - w] >= 128) { label[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && label[p + w] === -1 && mask[p + w] >= 128) { label[p + w] = id; stack.push(p + w); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  const out = new Uint8Array(w * h);
  if (best >= 0) {
    for (let p = 0; p < w * h; p++) if (label[p] === best) out[p] = 255;
  }
  return out;
}

/** Mask of visible dark content: any-alpha pixels whose unpremultiplied luma < 128. */
export function darkPixels(img: ImageData): PlaneMask {
  const w = img.width, h = img.height;
  const mask = new Uint8Array(w * h);
  const d = img.data;
  for (let p = 0; p < w * h; p++) {
    if (d[p * 4 + 3] === 0) continue;
    mask[p] = lumaAt(d, p * 4) < 128 ? 255 : 0;
  }
  return { mask, w, h };
}

/**
 * Mask of white content in mask/grayscale data: pixels with alpha >= 128 whose
 * unpremultiplied luma >= 128. Matches grayscale masks (value >= 128) as well as
 * alpha-carried selection masks (coverage >= 128, rgb = white).
 */
export function whitePixels(maskData: ImageData): PlaneMask {
  const w = maskData.width, h = maskData.height;
  const mask = new Uint8Array(w * h);
  const d = maskData.data;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (d[i + 3] < 128) continue;
    mask[p] = lumaAt(d, i) >= 128 ? 255 : 0;
  }
  return { mask, w, h };
}

/** Mask of fully opaque pixels (alpha >= 128). */
export function opaquePixels(img: ImageData): PlaneMask {
  const w = img.width, h = img.height;
  const mask = new Uint8Array(w * h);
  const d = img.data;
  for (let p = 0; p < w * h; p++) mask[p] = d[p * 4 + 3] >= 128 ? 255 : 0;
  return { mask, w, h };
}
