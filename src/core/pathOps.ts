// Vector path geometry shared by the pen tool's overlay, the PathsPanel raster
// ops (stroke/fill/selection) and history snapshots. Anchors store handles as
// offsets from the anchor point (see PathAnchor in types.ts), so the absolute
// control points are always p + handle.

import type { PathAnchor, PathSubpath } from './types';

export interface Pt { x: number; y: number }

export function anchorPoint(a: PathAnchor): Pt {
  return { x: a.p[0], y: a.p[1] };
}

/** Absolute position of a handle (null handle = corner anchor on that side). */
export function handleAbs(a: PathAnchor, which: 'in' | 'out'): Pt | null {
  const h = a[which];
  return h ? { x: a.p[0] + h[0], y: a.p[1] + h[1] } : null;
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function appendSegment(p: Path2D, a: PathAnchor, b: PathAnchor): void {
  const c1 = handleAbs(a, 'out');
  const c2 = handleAbs(b, 'in');
  if (!c1 && !c2) {
    p.lineTo(b.p[0], b.p[1]);
  } else {
    const f1 = c1 ?? anchorPoint(a);
    const f2 = c2 ?? anchorPoint(b);
    p.bezierCurveTo(f1.x, f1.y, f2.x, f2.y, b.p[0], b.p[1]);
  }
}

/** Append a subpath to a Path2D. Closed subpaths get an explicit closing
 *  segment + closePath(); open ones stay open — Canvas fill() implicitly
 *  straight-closes them, which is the v1 rule for selecting from open paths. */
export function addSubpathToPath2D(p: Path2D, sub: PathSubpath): void {
  if (sub.anchors.length < 2) return; // a lone anchor encloses no area
  const first = sub.anchors[0];
  p.moveTo(first.p[0], first.p[1]);
  for (let i = 1; i < sub.anchors.length; i++) {
    appendSegment(p, sub.anchors[i - 1], sub.anchors[i]);
  }
  if (sub.closed) {
    appendSegment(p, sub.anchors[sub.anchors.length - 1], first);
    p.closePath();
  }
}

/** All subpaths of a DocPath as one Path2D (fill/selection rasterization). */
export function pathToPath2D(subpaths: PathSubpath[]): Path2D {
  const p = new Path2D();
  for (const sub of subpaths) addSubpathToPath2D(p, sub);
  return p;
}

/** Arc-length samples along a subpath, roughly every `spacing` doc px,
 *  endpoints included. Closed subpaths also sample the closing segment back
 *  to the first anchor — that edge must be stroked too. Evaluation runs at
 *  ~1px granularity and is decimated to `spacing` so soft brush stamps
 *  overlap enough to stay continuous. */
export function sampleSubpath(sub: PathSubpath, spacing = 2): Pt[] {
  const pts: Pt[] = [];
  if (sub.anchors.length < 2) return pts;
  const emit = (p: Pt) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= spacing * 0.75) pts.push(p);
  };
  emit(anchorPoint(sub.anchors[0]));
  const n = sub.anchors.length;
  const segCount = sub.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = sub.anchors[i];
    const b = sub.anchors[(i + 1) % n];
    const p0 = anchorPoint(a);
    const p1 = handleAbs(a, 'out') ?? p0;
    const p2 = handleAbs(b, 'in') ?? anchorPoint(b);
    const p3 = anchorPoint(b);
    // control-polygon length ≥ curve length: close enough for step sizing
    const poly = Math.hypot(p1.x - p0.x, p1.y - p0.y)
      + Math.hypot(p2.x - p1.x, p2.y - p1.y)
      + Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const steps = Math.max(4, Math.ceil(poly));
    for (let s = 1; s <= steps; s++) emit(cubicAt(p0, p1, p2, p3, s / steps));
    pts.push(p3); // keep exact segment joints so consecutive segments connect
  }
  return pts;
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** '#rrggbb' + alpha → 'rgba(r,g,b,a)' (fallback black — store.fg is always a
 *  browser color input value, but never trust a persisted string). */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ---------- polygon boolean ops (v1: Greiner-Hormann over flattened polygons) ----------
//
// pathBoolean() flattens both inputs with sampleSubpath (~1.5 px), normalizes
// each closed polygon to positive orientation and clips the two polygon sets
// with a hand-rolled Greiner-Hormann traversal (no npm deps). Result loops come
// back as straight-line polygons (all-null handles, closed:true) — bezier
// geometry is not preserved. Open input subpaths are implicitly straight-closed,
// matching the Canvas fill semantics used by the panel's raster ops.
//
// v1 limitations:
//  - self-intersecting input subpaths can produce wrong results (GH assumes
//    simple polygons);
//  - outputs are dense straight polygons (collinear runs re-collapse to their
//    corners, but curved boundaries stay polylines at sampling resolution);
//  - degenerate contacts (shared edges, vertices landing on edges) are resolved
//    by re-running the clip with a deterministic jitter (0.8 px, then 3 px) on
//    B — such results carry that error near the contact;
//  - multi-subpath membership is even-odd (disjoint islands / properly nested
//    holes behave; overlapping same-side subpaths are a corner case).

export type BooleanOp = 'union' | 'subtract' | 'intersect';

const MERGE_EPS = 0.01;  // vertices closer than this count as one point
const TOUCH_EPS = 1e-6;  // endpoint-on-edge ⇒ degenerate contact (jitter & retry)
const CROSS_TOL = 1e-7;  // crossing params must sit inside this window to count
const AREA_EPS = 0.05;   // drop slivers below this area

interface Poly {
  pts: Pt[];
  hasX: boolean; // this polygon has intersections with the other set
}

/** Node of a polygon ring during clipping: original vertex or intersection. */
interface XNode {
  pt: Pt;
  isX: boolean;    // intersection node (twin lives in the other polygon's ring)
  enter: boolean;  // forward motion along this polygon enters the other set
  twin: XNode | null;
  visited: boolean;
  next: XNode;     // circular ring order, assigned by linkCircle()
}

const mkNode = (pt: Pt): XNode => ({
  pt, isX: false, enter: false, twin: null, visited: false, next: null as unknown as XNode,
});

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function distPtSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Consecutive near-duplicates collapse to one point; a trailing point equal to
 *  the first is dropped (closed subpaths sample back onto anchor 0). */
function dedupePts(pts: Pt[], eps = MERGE_EPS): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > eps) out.push(p);
  }
  while (out.length > 1
    && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) {
    out.pop();
  }
  return out;
}

/** Drop vertices whose removal moves the boundary < 0.01 px — re-collapses the
 *  sampled straight runs (a rectangle clips back to its 4 corners) while keeping
 *  curved detail (chord sagitta at 1.5 px sampling stays above this threshold). */
function simplifyLoop(pts: Pt[]): Pt[] {
  let cur = pts;
  for (let pass = 0; pass < 3 && cur.length > 4; pass++) {
    const n = cur.length;
    const keep = new Array<boolean>(n).fill(true);
    for (let i = 0; i < n; i++) {
      if (distPtSeg(cur[i], cur[(i - 1 + n) % n], cur[(i + 1) % n]) < 0.01) keep[i] = false;
    }
    const kept = keep.reduce((c, k) => c + (k ? 1 : 0), 0);
    if (kept === n || kept < 3) break;
    cur = cur.filter((_, i) => keep[i]);
  }
  return cur;
}

/** Even-odd ray cast — winding-agnostic, so it also works for the reversed
 *  (hole-tracing) polygons. */
function pointInPoly(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Region membership in a polygon SET, even-odd style (disjoint islands and
 *  properly nested holes both behave; overlapping same-side polys don't). */
function pointInSet(pt: Pt, polys: Pt[][]): boolean {
  let inside = false;
  for (const poly of polys) if (pointInPoly(pt, poly)) inside = !inside;
  return inside;
}

interface SegX { kind: 'none' | 'cross' | 'touch'; t: number; u: number; pt: Pt }

/** Segment-segment intersection. 'touch' flags degenerate contacts (endpoint on
 *  edge, collinear overlap) — GH cannot treat them, the caller jitters & retries. */
function segX(a1: Pt, a2: Pt, b1: Pt, b2: Pt): SegX {
  const rx = a2.x - a1.x, ry = a2.y - a1.y;
  const sx = b2.x - b1.x, sy = b2.y - b1.y;
  const qx = b1.x - a1.x, qy = b1.y - a1.y;
  const touches = () =>
    distPtSeg(a1, b1, b2) < TOUCH_EPS || distPtSeg(a2, b1, b2) < TOUCH_EPS ||
    distPtSeg(b1, a1, a2) < TOUCH_EPS || distPtSeg(b2, a1, a2) < TOUCH_EPS;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) {
    // parallel: only a collinear overlap counts as a degenerate contact
    return { kind: touches() ? 'touch' : 'none', t: 0, u: 0, pt: a1 };
  }
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  const pt = { x: a1.x + t * rx, y: a1.y + t * ry };
  if (t >= CROSS_TOL && t <= 1 - CROSS_TOL && u >= CROSS_TOL && u <= 1 - CROSS_TOL) {
    return { kind: 'cross', t, u, pt };
  }
  const inWindow = t >= -CROSS_TOL && t <= 1 + CROSS_TOL && u >= -CROSS_TOL && u <= 1 + CROSS_TOL;
  return { kind: inWindow && touches() ? 'touch' : 'none', t, u, pt };
}

/** Smallest prime ≥ n (inputs stay small: per-segment sample counts). Prime
 *  step counts keep sample positions off rational lattices: k·len/steps can
 *  only hit a round position at the segment endpoints, so vertices of one
 *  polygon don't land exactly on the other's edges (a degenerate contact for
 *  Greiner-Hormann that ceil(len/1.4) steps would still hit, e.g. 100·36/72). */
function nextPrime(n: number): number {
  const isPrime = (m: number) => {
    if (m < 2) return false;
    for (let d = 2; d * d <= m; d++) if (m % d === 0) return false;
    return true;
  };
  while (!isPrime(n)) n++;
  return n;
}

/** Flatten one subpath to a closed polygon point list (open subpaths close
 *  implicitly along the last→first chord, like Canvas fill). Deliberately NOT
 *  sampleSubpath: its decimation lands straight-edge vertices on a neat
 *  periodic lattice (every 2 px for integer geometry), which makes vertices of
 *  one polygon sit exactly on the other's edges. */
function flattenPolyPts(sub: PathSubpath): Pt[] {
  const n = sub.anchors.length;
  if (n < 2) return [];
  const pts: Pt[] = [anchorPoint(sub.anchors[0])];
  const segCount = sub.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const a = sub.anchors[i], b = sub.anchors[(i + 1) % n];
    const p0 = anchorPoint(a);
    const p1 = handleAbs(a, 'out') ?? p0;
    const p2 = handleAbs(b, 'in') ?? anchorPoint(b);
    const p3 = anchorPoint(b);
    // control-polygon length ≥ curve length: close enough for step sizing
    const poly = Math.hypot(p1.x - p0.x, p1.y - p0.y)
      + Math.hypot(p2.x - p1.x, p2.y - p1.y)
      + Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const steps = nextPrime(Math.max(2, Math.ceil(poly / 1.4)));
    for (let s = 1; s <= steps; s++) pts.push(cubicAt(p0, p1, p2, p3, s / steps));
  }
  return dedupePts(pts, MERGE_EPS);
}

/** Flatten subpaths to positively-oriented closed polygons. */
function flattenInput(subpaths: PathSubpath[]): Poly[] {
  const out: Poly[] = [];
  for (const sub of subpaths) {
    if (sub.anchors.length < 2) continue; // a lone anchor encloses no area
    const pts = flattenPolyPts(sub);
    const area = signedArea(pts);
    if (pts.length < 3 || Math.abs(area) < AREA_EPS) continue;
    out.push({ pts: area < 0 ? pts.reverse() : pts, hasX: false });
  }
  return out;
}

/** Deterministic sub-pixel displacement that breaks endpoint-on-edge and
 *  collinear-overlap degeneracies; only applied when such a contact is found. */
function jitterPts(pts: Pt[], scale: number): Pt[] {
  return pts.map((p, i) => ({
    x: p.x + Math.sin((i + 1) * 12.9898) * scale,
    y: p.y + Math.cos((i + 1) * 4.898) * scale,
  }));
}

function bboxOverlap(p: Pt[], q: Pt[]): boolean {
  const bb = (pts: Pt[]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of pts) {
      if (v.x < x0) x0 = v.x;
      if (v.y < y0) y0 = v.y;
      if (v.x > x1) x1 = v.x;
      if (v.y > y1) y1 = v.y;
    }
    return { x0, y0, x1, y1 };
  };
  const a = bb(p), b = bb(q);
  return a.x0 <= b.x1 + 0.5 && b.x0 <= a.x1 + 0.5 && a.y0 <= b.y1 + 0.5 && b.y0 <= a.y1 + 0.5;
}

function spliceX(ring: XNode[], perEdge: { t: number; node: XNode }[][]): void {
  const n = ring.length;
  let pos = 0; // nodes inserted so far (shifts later insertion indices)
  for (let e = 0; e < n; e++) {
    const list = perEdge[e];
    if (!list.length) continue;
    list.sort((p, q) => p.t - q.t);
    for (let k = 0; k < list.length; k++) ring.splice(e + pos + 1 + k, 0, list[k].node);
    pos += list.length;
  }
}

/** GH phase 2: find all crossings, splice intersection nodes into both rings. */
function phase2(
  A: Poly[], B: Poly[], aRings: XNode[][], bRings: XNode[][], force: boolean,
): 'ok' | 'touch' {
  const aXs = A.map(p => p.pts.map(() => [] as { t: number; node: XNode }[]));
  const bXs = B.map(p => p.pts.map(() => [] as { t: number; node: XNode }[]));
  let any = false;
  for (let i = 0; i < A.length; i++) {
    const P = A[i].pts, n = P.length;
    for (let j = 0; j < B.length; j++) {
      const Q = B[j].pts, m = Q.length;
      if (!bboxOverlap(P, Q)) continue;
      for (let e = 0; e < n; e++) {
        const a1 = P[e], a2 = P[(e + 1) % n];
        for (let f = 0; f < m; f++) {
          const x = segX(a1, a2, Q[f], Q[(f + 1) % m]);
          if (x.kind === 'touch') {
            if (!force) return 'touch';
            continue;
          }
          if (x.kind !== 'cross') continue;
          const na = mkNode(x.pt); na.isX = true;
          const nb = mkNode({ x: x.pt.x, y: x.pt.y }); nb.isX = true;
          na.twin = nb; nb.twin = na;
          aXs[i][e].push({ t: x.t, node: na });
          bXs[j][f].push({ t: x.u, node: nb });
          any = true;
        }
      }
    }
  }
  if (any) {
    for (let i = 0; i < A.length; i++) {
      if (aXs[i].some(l => l.length)) A[i].hasX = true;
      spliceX(aRings[i], aXs[i]);
    }
    for (let j = 0; j < B.length; j++) {
      if (bXs[j].some(l => l.length)) B[j].hasX = true;
      spliceX(bRings[j], bXs[j]);
    }
  }
  for (const r of aRings) linkCircle(r);
  for (const r of bRings) linkCircle(r);
  return 'ok';
}

function linkCircle(ring: XNode[]): void {
  const n = ring.length;
  for (let i = 0; i < n; i++) ring[i].next = ring[(i + 1) % n];
}

/** Enter flags for a ring: set membership flips at every crossing, so the first
 *  crossing's status derives from the edge-start vertex and the rest alternate. */
function assignEnter(ring: XNode[], otherPts: Pt[][]): void {
  const n = ring.length;
  if (!n) return;
  let inside = pointInSet(ring[0].pt, otherPts);
  for (let k = 1; k <= n; k++) {
    const node = ring[k % n];
    if (node.isX) {
      inside = !inside;
      node.enter = inside;
    }
  }
}

/** GH phase 3: walk the combined boundary from an entry intersection — forward
 *  along the start's own polygon, switching to the twin polygon whenever a
 *  crossing is reached — until back at the start. Null on abnormal revisit
 *  (degenerate topology) so the partial loop is discarded. */
function traceLoop(start: XNode, maxSteps: number): Pt[] | null {
  const twin = start.twin;
  if (!twin) return null;
  const pts: Pt[] = [start.pt];
  start.visited = true;
  twin.visited = true;
  let cur: XNode = start.next; // walk the start's polygon first, switch on arrival
  let steps = 1;
  while (true) {
    // the loop closes when it comes back to the starting intersection — which
    // may be reached through either ring; both nodes are the same point
    if (cur === start || cur === twin) break;
    if (cur.visited) return null;
    pts.push(cur.pt);
    if (cur.isX) {
      cur.visited = true;
      const tw = cur.twin;
      if (!tw || tw.visited) return null;
      tw.visited = true;
      cur = tw.next;
    } else {
      cur = cur.next;
    }
    if (++steps > maxSteps) return null;
  }
  return pts;
}

function toSubpath(pts: Pt[]): PathSubpath {
  return {
    closed: true,
    anchors: pts.map(p => ({ p: [p.x, p.y] as [number, number], in: null, out: null })),
  };
}

/** True when both polygon sets trace the same boundary (same-path input and
 *  exact duplicates) — fast-pathed because GH mis-handles shared edges. */
function boundariesMatch(a: Poly[], b: Poly[]): boolean {
  if (!a.length || !b.length) return false;
  const bPts = b.map(p => p.pts);
  const aPts = a.map(p => p.pts);
  const onBoundary = (pt: Pt, polys: Pt[][]): boolean => {
    for (const poly of polys) {
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        if (distPtSeg(pt, poly[i], poly[(i + 1) % n]) < MERGE_EPS) return true;
      }
    }
    return false;
  };
  let areaA = 0, areaB = 0;
  for (const p of a) {
    areaA += Math.abs(signedArea(p.pts));
    for (const pt of p.pts) if (!onBoundary(pt, bPts)) return false;
  }
  for (const p of b) {
    areaB += Math.abs(signedArea(p.pts));
    for (const pt of p.pts) if (!onBoundary(pt, aPts)) return false;
  }
  return Math.abs(areaA - areaB) < 0.5;
}

function emitLoop(out: PathSubpath[], pts: Pt[]): void {
  const clean = simplifyLoop(dedupePts(pts, MERGE_EPS));
  if (clean.length >= 3 && Math.abs(signedArea(clean)) > AREA_EPS) out.push(toSubpath(clean));
}

function clipOnce(
  aPolys: Poly[], bPolys: Poly[], op: BooleanOp, jitter: number, force: boolean,
): PathSubpath[] | null {
  const A = aPolys.map(p => ({ pts: p.pts, hasX: false }));
  // subtract walks B reversed (hole boundaries trace against the grain)
  const B = bPolys.map(p => ({
    pts: op === 'subtract' ? [...p.pts].reverse() : [...p.pts],
    hasX: false,
  }));
  if (jitter > 0) for (const p of B) p.pts = jitterPts(p.pts, jitter);
  const aRings = A.map(p => p.pts.map(mkNode));
  const bRings = B.map(p => p.pts.map(mkNode));
  if (phase2(A, B, aRings, bRings, force) === 'touch') return null;
  const aPts = A.map(p => p.pts);
  const bPts = B.map(p => p.pts);
  for (const ring of aRings) assignEnter(ring, bPts);

  // entry rule: intersect starts where A enters B; union and subtract (B
  // already reversed) start where A leaves B
  const rule = op === 'intersect';
  const maxSteps = aRings.reduce((n, r) => n + r.length, 0)
    + bRings.reduce((n, r) => n + r.length, 0) + 16;
  const out: PathSubpath[] = [];
  for (const ring of aRings) {
    for (const nd of ring) {
      if (!nd.isX || nd.visited || nd.enter !== rule) continue;
      const loop = traceLoop(nd, maxSteps);
      if (loop) emitLoop(out, loop);
    }
  }
  // polygons that never crossed the other set: keep per set membership
  for (const P of A) {
    if (P.hasX) continue;
    const inside = pointInSet(P.pts[0], bPts);
    const keep = op === 'intersect' ? inside : !inside;
    if (keep) emitLoop(out, P.pts);
  }
  for (const Q of B) {
    if (Q.hasX) continue;
    const inside = pointInSet(Q.pts[0], aPts);
    if (op === 'union' && !inside) emitLoop(out, Q.pts);
    else if (op === 'intersect' && inside) emitLoop(out, Q.pts);
    // Q is already reversed for subtract ⇒ opposite winding ⇒ a fill hole
    else if (op === 'subtract' && inside) emitLoop(out, Q.pts);
  }
  return out;
}

/** Boolean combination of two path subpath sets. Both inputs are flattened to
 *  polygons first, so the result is always straight-line closed subpaths (v1:
 *  bezier handles are not preserved, and hole loops come out counter-wound so
 *  nonzero-winding Canvas fill punches them). */
export function pathBoolean(aSubs: PathSubpath[], bSubs: PathSubpath[], op: BooleanOp): PathSubpath[] {
  const a = flattenInput(aSubs);
  const b = flattenInput(bSubs);
  if (!a.length || !b.length) {
    // empty operand: union = the other side, subtract/intersect = nothing
    return op === 'union' ? (a.length ? a : b).map(p => toSubpath(simplifyLoop(p.pts))) : [];
  }
  if (boundariesMatch(a, b)) {
    if (op === 'subtract') return [];
    return a.map(p => toSubpath(simplifyLoop(p.pts))); // union/intersect of equals
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    // jitter amplitudes: first two generic, last must exceed the ~1.4 px
    // sampling step to move a whole zigzag edge off the contact
    const jitter = attempt === 0 ? 0 : attempt === 1 ? 0.8 : 3;
    const out = clipOnce(a, b, op, jitter, attempt === 2);
    if (out) return out;
  }
  return [];
}
