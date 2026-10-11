// Magic wand ported from WandPixels.c: contiguous/non-contiguous color-similarity
// flood fill plus a color-range mask. Output is an alpha mask (0/255 in a
// Uint8ClampedArray's alpha channel) ready to use as a selection.

export interface WandResult {
  mask: Uint8Array;      // width*height, 0 or 255
  minX: number; minY: number; maxX: number; maxY: number; // selection bbox
  count: number;
}

export function wandMask(
  px: Uint8ClampedArray, width: number, height: number,
  startX: number, startY: number, radius: number, tolerance: number, contiguous: boolean,
): WandResult {
  const mask = new Uint8Array(width * height);
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;

  // reference color = average of the (2r+1)² sample box, as in the C
  const ref = [0, 0, 0, 0];
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = startX + dx, y = startY + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 4;
      ref[0] += px[i]; ref[1] += px[i + 1]; ref[2] += px[i + 2]; ref[3] += px[i + 3];
      n++;
    }
  }
  if (!n) return { mask, minX: 0, minY: 0, maxX: -1, maxY: -1, count: 0 };
  const r0 = ref[0] / n, g0 = ref[1] / n, b0 = ref[2] / n, a0 = ref[3] / n;
  const tol = Math.max(0, Math.min(255, tolerance));

  const match = (i: number) =>
    Math.abs(px[i] - r0) <= tol && Math.abs(px[i + 1] - g0) <= tol &&
    Math.abs(px[i + 2] - b0) <= tol && Math.abs(px[i + 3] - a0) <= tol;

  const mark = (x: number, y: number) => {
    mask[y * width + x] = 255;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    count++;
  };

  if (!contiguous) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (match((y * width + x) * 4)) mark(x, y);
      }
    }
    return { mask, minX, minY, maxX, maxY, count };
  }

  // scanline flood fill with a growable stack, as in the C
  if (!match((startY * width + startX) * 4)) return { mask, minX: 0, minY: 0, maxX: -1, maxY: -1, count: 0 };
  const stack: number[] = [startX, startY];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    if (mask[y * width + x]) continue;
    // walk left
    while (x > 0 && !mask[y * width + x - 1] && match((y * width + x - 1) * 4)) x--;
    let spanUp = false, spanDown = false;
    while (x < width) {
      const p = y * width + x;
      if (mask[p] || !match(p * 4)) break;
      mark(x, y);
      if (y > 0) {
        const up = !mask[p - width] && match((p - width) * 4);
        if (up && !spanUp) { stack.push(x, y - 1); spanUp = true; }
        else if (!up) spanUp = false;
      }
      if (y < height - 1) {
        const dn = !mask[p + width] && match((p + width) * 4);
        if (dn && !spanDown) { stack.push(x, y + 1); spanDown = true; }
        else if (!dn) spanDown = false;
      }
      x++;
    }
  }
  return { mask, minX, minY, maxX, maxY, count };
}

/** Color Range-style mask (WandPixels.c:184-205): distance to a key color with fuzziness. */
export function colorRangeMask(
  px: Uint8ClampedArray, width: number, height: number,
  key: [number, number, number], fuzziness: number,
): WandResult {
  const mask = new Uint8Array(width * height);
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
  const f = Math.max(0, Math.min(100, fuzziness)) / 100 * 441.67; // max RGB distance
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    if (px[i + 3] === 0) continue;
    const d = Math.sqrt(
      (px[i] - key[0]) ** 2 + (px[i + 1] - key[1]) ** 2 + (px[i + 2] - key[2]) ** 2);
    if (d <= f) {
      mask[p] = 255;
      const x = p % width, y = (p / width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      count++;
    }
  }
  return { mask, minX, minY, maxX, maxY, count };
}

/**
 * Trace a binary mask into polygons for marching ants, following directed boundary
 * edges on the (w+1)×(h+1) corner grid as the C `wand_trace` does. Orientation keeps
 * the region interior on the right, so outer loops run clockwise and holes counter-
 * clockwise; the even-odd fill of the returned polygons is correct either way.
 */
export function traceMask(mask: Uint8Array, width: number, height: number): number[][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < width && y < height ? mask[y * width + x] : 0);
  // directed edges keyed by start corner "x,y" → list of end corners
  const edges = new Map<string, number[][]>();
  const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const k = x0 + ',' + y0;
    let list = edges.get(k);
    if (!list) edges.set(k, list = []);
    list.push([x1, y1]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y);           // top, →
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);   // right, ↓
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);   // bottom, ←
      if (!at(x - 1, y)) addEdge(x, y + 1, x, y);           // left, ↑
    }
  }
  const key = (x: number, y: number) => x + ',' + y;
  const polygons: number[][] = [];
  const used = new Set<string>(); // "x0,y0>x1,y1"
  for (const [startKey, ends] of edges) {
    for (const end of ends) {
      if (used.has(startKey + '>' + end[0] + ',' + end[1])) continue;
      // follow the loop
      const pts: number[] = [];
      let cx = +startKey.split(',')[0], cy = +startKey.split(',')[1];
      let ex = end[0], ey = end[1];
      const startEdge = startKey + '>' + ex + ',' + ey;
      used.add(startEdge);
      pts.push(cx, cy);
      let guard = 0;
      const limit = 4 * width * height + 16;
      while (guard++ < limit) {
        pts.push(ex, ey);
        if (ex === +startKey.split(',')[0] && ey === +startKey.split(',')[1]) break;
        const cands = edges.get(key(ex, ey))?.filter(c => !used.has(key(ex, ey) + '>' + c[0] + ',' + c[1])) ?? [];
        if (!cands.length) break;
        // at junctions prefer the sharpest right turn to keep following the same boundary
        const inDx = ex - cx, inDy = ey - cy;
        cands.sort((a, b) => turnScore(inDx, inDy, a[0] - ex, a[1] - ey) - turnScore(inDx, inDy, b[0] - ex, b[1] - ey));
        const next = cands[0];
        used.add(key(ex, ey) + '>' + next[0] + ',' + next[1]);
        cx = ex; cy = ey; ex = next[0]; ey = next[1];
      }
      // drop collinear points
      const poly: number[] = [];
      const n = pts.length / 2;
      for (let i = 0; i < n; i++) {
        const px0 = pts[(i * 2) % pts.length], py0 = pts[(i * 2 + 1) % pts.length];
        const qx = pts[((i + 1) * 2) % pts.length], qy = pts[((i + 1) * 2 + 1) % pts.length];
        const rx = pts[((i + 2) * 2) % pts.length], ry = pts[((i + 2) * 2 + 1) % pts.length];
        if ((qx - px0) * (ry - qy) - (qy - py0) * (rx - qx) !== 0) poly.push(qx, qy);
      }
      if (poly.length >= 6) polygons.push(poly);
    }
  }
  return polygons;
}

/** Lower score = sharper right turn (preferred at junctions). Screen coords: y grows down,
 *  so a clockwise/right turn has a positive cross product; negating sorts sharp-right first. */
function turnScore(inDx: number, inDy: number, outDx: number, outDy: number): number {
  return -(inDx * outDy - inDy * outDx);
}
