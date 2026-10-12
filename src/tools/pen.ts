// Pen tool: bezier paths with corner/smooth anchors, work path, PathsPanel ops.
//
// Interaction (matches the ToolOptions hint):
//   click          → corner anchor (straight segments)
//   drag           → smooth anchor, mirrored in/out handles
//   Alt+drag       → broken handles (outgoing only, `in` stays null)
//   click 1st pt   → close current subpath (8 doc px tolerance)
//   double-click / Enter → close current subpath
//   Escape         → discard the current open subpath (or clear the work path)
//
// Post-editing (hit-tested against the existing work path, in this priority):
//   drag handle    → move that handle; the opposite side mirrors unless Alt
//                    (Alt keeps it put — broken handles)
//   drag anchor    → move the anchor; handles translate along (they are
//                    anchor-relative offsets)
//   Alt+click anchor (no drag) → delete it, but only if >2 anchors would remain
//                    in the subpath
//   click segment  → insert an anchor at the nearest bezier point and drag it
//   double-click anchor → toggle smooth (mirrored handles along the neighbor
//                    direction, length = neighbor distance / 3) ↔ corner
//   miss everything → the plain "add anchor" flow above
//
// The in-progress "work path" lives in module state (penState.work), NOT in
// doc.paths — Photoshop semantics: it renders via a registered overlay and is
// committed into doc.paths by the PathsPanel (提交为路径). penState is a Vue
// reactive so PathsPanel can computed() off it while the overlay reads it raw
// each frame (store.tick drives those repaints).

import { reactive } from 'vue';
import { store, invalidate } from '../core/store';
import { registerOverlay } from '../core/overlayRegistry';
import { onToolKey } from '../core/toolKeys';
import { anchorPoint, handleAbs } from '../core/pathOps';
import type { Pt } from '../core/pathOps';
import type { Tool, ToolEvent } from './index';
import type { DocPath, PathAnchor, PathSubpath } from '../core/types';

const CLOSE_TOLERANCE = 8; // doc px: click-near-first-anchor closes the subpath
const HIT_HANDLE = 6;      // doc px: grab a bezier handle
const HIT_ANCHOR = 8;      // doc px: grab / Alt-delete / double-click an anchor
const HIT_SEGMENT = 6;     // doc px: click a segment to insert an anchor
const PEN_BLUE = '#4aa3ff';

/** Live work-path state. `docId` tags which document the work path belongs to;
 *  a doc switch (new/open/tab) orphans it on next touch — no setDoc hook needed. */
export const penState = reactive({
  work: null as DocPath | null,
  docId: '' as string,
  hover: null as { x: number; y: number } | null, // last pen-tool hover, doc px
  snap: false,                                    // hovering the first anchor
  // post-edit hover feedback: which anchor/handle the pointer is over
  // (`which` null = the anchor itself; si/ai index work.subpaths / anchors)
  hoverHit: null as { si: number; ai: number; which: 'in' | 'out' | null } | null,
});

/** The work path for the current document, or null. Panel ops target this when
 *  no saved path row is selected. */
export function getWorkPath(): DocPath | null {
  if (!store.doc || penState.docId !== store.doc.id) return null;
  return penState.work;
}

export function clearWorkPath(): void {
  penState.work = null;
  penState.docId = '';
  penState.snap = false;
  penState.hoverHit = null;
}

function ensureWork(): DocPath | null {
  if (!store.doc) return null;
  if (penState.docId !== store.doc.id) clearWorkPath();
  if (!penState.work) {
    penState.work = {
      id: crypto.randomUUID().toUpperCase(),
      name: '工作路径',
      subpaths: [],
    };
    penState.docId = store.doc.id;
  }
  return penState.work;
}

/** The subpath currently being drawn: the last one, while still open. */
function currentOpenSub(work: DocPath): PathSubpath | null {
  const last = work.subpaths[work.subpaths.length - 1];
  return last && !last.closed ? last : null;
}

function closeCurrentSubpath(): boolean {
  const work = getWorkPath();
  const open = work && currentOpenSub(work);
  if (!open || open.anchors.length < 2) return false;
  open.closed = true;
  return true;
}

// ---------- post-edit hit testing ----------

// Local copy of pathOps' private evaluator — pathOps keeps it internal.
function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** The four bezier control points of the segment a→b (null handles collapse to
 *  the anchor itself, i.e. straight segments). */
function segmentControls(a: PathAnchor, b: PathAnchor): [Pt, Pt, Pt, Pt] {
  const p0 = anchorPoint(a);
  const p3 = anchorPoint(b);
  return [p0, handleAbs(a, 'out') ?? p0, handleAbs(b, 'in') ?? p3, p3];
}

interface AnchorHit { sub: PathSubpath; index: number }
interface HandleHit extends AnchorHit { which: 'in' | 'out' }
interface SegmentHit { sub: PathSubpath; index: number; t: number; pt: Pt }

function hitHandle(work: DocPath, x: number, y: number): HandleHit | null {
  let best: HandleHit | null = null;
  let bestD = HIT_HANDLE;
  for (let si = 0; si < work.subpaths.length; si++) {
    const anchors = work.subpaths[si].anchors;
    for (let ai = 0; ai < anchors.length; ai++) {
      for (const which of ['in', 'out'] as const) {
        const h = handleAbs(anchors[ai], which);
        if (!h) continue;
        const d = Math.hypot(x - h.x, y - h.y);
        if (d <= bestD) { bestD = d; best = { sub: work.subpaths[si], index: ai, which }; }
      }
    }
  }
  return best;
}

function hitAnchor(work: DocPath, x: number, y: number): AnchorHit | null {
  let best: AnchorHit | null = null;
  let bestD = HIT_ANCHOR;
  for (let si = 0; si < work.subpaths.length; si++) {
    const anchors = work.subpaths[si].anchors;
    for (let ai = 0; ai < anchors.length; ai++) {
      const d = Math.hypot(x - anchors[ai].p[0], y - anchors[ai].p[1]);
      if (d <= bestD) { bestD = d; best = { sub: work.subpaths[si], index: ai }; }
    }
  }
  return best;
}

/** Nearest point on any segment (open subpaths: anchor→anchor runs; closed:
 *  also the closing edge back to anchor 0), sampled at ~1 doc px. */
function hitSegment(work: DocPath, x: number, y: number): SegmentHit | null {
  let best: SegmentHit | null = null;
  let bestD = HIT_SEGMENT;
  for (let si = 0; si < work.subpaths.length; si++) {
    const sub = work.subpaths[si];
    const n = sub.anchors.length;
    if (n < 2) continue;
    const segCount = sub.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const [p0, p1, p2, p3] = segmentControls(sub.anchors[i], sub.anchors[(i + 1) % n]);
      // control-polygon length ≥ curve length — same sizing rule as pathOps
      const poly = Math.hypot(p1.x - p0.x, p1.y - p0.y)
        + Math.hypot(p2.x - p1.x, p2.y - p1.y)
        + Math.hypot(p3.x - p2.x, p3.y - p2.y);
      const steps = Math.max(8, Math.min(96, Math.ceil(poly)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const pt = cubicAt(p0, p1, p2, p3, t);
        const d = Math.hypot(x - pt.x, y - pt.y);
        if (d <= bestD) { bestD = d; best = { sub, index: i, t, pt }; }
      }
    }
  }
  return best;
}

/** Split-free insertion: a new anchor at the hit point with tangent-aligned
 *  handles ±(c2−c1)/6 (c1/c2 are the segment's effective control points, so
 *  for straight segments this is exactly the chord direction and the outline
 *  is unchanged). Inserted after the segment's start anchor — for the closing
 *  edge of a closed subpath that appends at the end, keeping 0…n-1 order. */
function insertAnchorOnSegment(hit: SegmentHit): number {
  const n = hit.sub.anchors.length;
  const a = hit.sub.anchors[hit.index];
  const b = hit.sub.anchors[(hit.index + 1) % n];
  if (!a || !b) return -1;
  const [, p1, p2] = segmentControls(a, b);
  const p = cubicAt(anchorPoint(a), p1, p2, anchorPoint(b), hit.t);
  const anchor: PathAnchor = {
    p: [p.x, p.y],
    in: [(p1.x - p2.x) / 6, (p1.y - p2.y) / 6],
    out: [(p2.x - p1.x) / 6, (p2.y - p1.y) / 6],
  };
  const at = hit.index + 1;
  hit.sub.anchors.splice(at, 0, anchor);
  return at;
}

/** Smooth ⇄ corner toggle. With handles → corner (both null). Without →
 *  mirrored handles along the neighbor line, length = neighbor distance / 3;
 *  open subpaths' first/last anchors get a single-sided handle. */
function toggleAnchorSmooth(sub: PathSubpath, index: number): void {
  const a = sub.anchors[index];
  if (!a) return;
  if (a.in || a.out) { a.in = null; a.out = null; return; }
  const n = sub.anchors.length;
  if (n < 2) return;
  const prev = sub.closed || index > 0 ? sub.anchors[(index - 1 + n) % n] : null;
  const next = sub.closed || index < n - 1 ? sub.anchors[(index + 1) % n] : null;
  if (prev && next) {
    const dx = next.p[0] - prev.p[0], dy = next.p[1] - prev.p[1];
    const L = Math.hypot(dx, dy);
    if (!L) return; // coincident neighbors: no direction to derive
    const len = (Math.hypot(next.p[0] - a.p[0], next.p[1] - a.p[1])
      + Math.hypot(prev.p[0] - a.p[0], prev.p[1] - a.p[1])) / 6; // avg dist / 3
    a.out = [dx / L * len, dy / L * len];
    a.in = [-a.out[0], -a.out[1]];
  } else if (next) {
    // single neighbor: len = dist/3 along the neighbor direction ⇒ dist/3 vector
    a.out = [(next.p[0] - a.p[0]) / 3, (next.p[1] - a.p[1]) / 3];
  } else if (prev) {
    a.in = [(prev.p[0] - a.p[0]) / 3, (prev.p[1] - a.p[1]) / 3];
  }
}

// ---------- pointer interaction ----------

// While a down→drag→up gesture runs, this describes what the gesture grabbed:
//  - 'anchor': an existing anchor (handles ride along — they are offsets)
//  - 'handle': a handle; a freshly added anchor starts as its own 'out' handle,
//    which reproduces the classic click-drag smooth-anchor gesture
// Writes go through the reactive subpath proxy so PathsPanel stays in sync.
type DragTarget =
  | { kind: 'anchor'; sub: PathSubpath; index: number }
  | { kind: 'handle'; sub: PathSubpath; index: number; which: 'in' | 'out' };
let drag: DragTarget | null = null;

// Armed by Alt+down over an anchor; if the pointer never moves before up, the
// anchor is deleted (kept when the subpath would drop to ≤2 anchors).
let altDelete: { sub: PathSubpath; index: number } | null = null;

function onDown(e: ToolEvent) {
  const doc = e.doc;
  altDelete = null; // every gesture re-arms it fresh
  const work = getWorkPath();
  if (work && work.subpaths.length) {
    // 1. handles beat everything (they sit inside the anchor tolerance)
    const h = hitHandle(work, doc.x, doc.y);
    if (h) {
      drag = { kind: 'handle', sub: h.sub, index: h.index, which: h.which };
      return;
    }
    // 2. anchors — Alt arms a delete-on-release, the open subpath's first
    //    anchor keeps the close-on-click gesture, the rest become draggable
    const a = hitAnchor(work, doc.x, doc.y);
    if (a) {
      if (e.alt) {
        altDelete = { sub: a.sub, index: a.index };
        return;
      }
      const open = currentOpenSub(work);
      if (open && a.sub === open && a.index === 0 && open.anchors.length >= 2) {
        open.closed = true;
        invalidate();
        return;
      }
      drag = { kind: 'anchor', sub: a.sub, index: a.index };
      invalidate();
      return;
    }
    // 3. segment click inserts an anchor and immediately drags it
    const s = hitSegment(work, doc.x, doc.y);
    if (s) {
      const at = insertAnchorOnSegment(s);
      if (at >= 0) {
        drag = { kind: 'anchor', sub: s.sub, index: at };
        invalidate();
        return;
      }
    }
  }
  // 4. miss: plain add-anchor flow (unchanged)
  const w = ensureWork();
  if (!w) return;
  const open = currentOpenSub(w);
  const anchor: PathAnchor = { p: [doc.x, doc.y], in: null, out: null };
  if (open && open.anchors.length >= 2) {
    const first = open.anchors[0];
    if (Math.hypot(doc.x - first.p[0], doc.y - first.p[1]) <= CLOSE_TOLERANCE) {
      open.closed = true;
      invalidate();
      return;
    }
  }
  let sub: PathSubpath;
  if (open) {
    open.anchors.push(anchor);
    sub = open;
  } else {
    sub = { closed: false, anchors: [anchor] };
    w.subpaths.push(sub);
  }
  // Re-read through the reactive proxy: mutating the raw object pushed into the
  // array would bypass reactivity and leave PathsPanel stale during drags.
  const reactiveSub = w.subpaths[w.subpaths.length - 1];
  drag = { kind: 'handle', sub: reactiveSub, index: reactiveSub.anchors.length - 1, which: 'out' };
  invalidate();
}

function onDrag(doc: { x: number; y: number }, alt: boolean) {
  if (!drag) {
    altDelete = null; // pointer moved during an armed Alt+click: not a delete
    return;
  }
  const a = drag.sub.anchors[drag.index];
  if (!a) return;
  if (drag.kind === 'anchor') {
    a.p = [doc.x, doc.y]; // handles are anchor-relative: they translate along
  } else {
    const d: [number, number] = [doc.x - a.p[0], doc.y - a.p[1]];
    if (drag.which === 'out') {
      a.out = d;
      // Alt live-breaks the handles (mirrors Photoshop): only the dragged side
      // follows the pointer, the opposite side stays where it was left.
      if (!alt) a.in = [-d[0], -d[1]];
    } else {
      a.in = d;
      if (!alt) a.out = [-d[0], -d[1]];
    }
  }
  invalidate();
}

export const penTool: Tool = {
  id: 'pen',
  cursor: 'crosshair',

  onDown: e => onDown(e),
  onDrag: e => onDrag(e.doc, e.alt),
  onUp: () => {
    if (altDelete) {
      const { sub, index } = altDelete;
      altDelete = null;
      // >2 anchors must remain, and the armed anchor must still be there
      if (sub.anchors.length > 3 && sub.anchors[index]) {
        sub.anchors.splice(index, 1);
        invalidate();
      }
    }
    drag = null;
  },

  onDoubleClick: e => {
    const work = getWorkPath();
    const hit = work && work.subpaths.length ? hitAnchor(work, e.doc.x, e.doc.y) : null;
    if (hit) {
      toggleAnchorSmooth(hit.sub, hit.index);
      invalidate();
      return;
    }
    if (closeCurrentSubpath()) invalidate();
  },

  onHover: e => {
    penState.hover = { x: e.doc.x, y: e.doc.y };
    const work = getWorkPath();
    const open = work && currentOpenSub(work);
    let snap = false;
    if (open && open.anchors.length >= 2) {
      const f = open.anchors[0];
      snap = Math.hypot(e.doc.x - f.p[0], e.doc.y - f.p[1]) <= CLOSE_TOLERANCE;
    }
    const snapChanged = snap !== penState.snap;
    penState.snap = snap;
    // hover highlight over an existing anchor/handle (post-edit affordance)
    let hit: typeof penState.hoverHit = null;
    if (work && work.subpaths.length) {
      const h = hitHandle(work, e.doc.x, e.doc.y);
      const a = h ?? hitAnchor(work, e.doc.x, e.doc.y);
      if (a) {
        const si = work.subpaths.indexOf(a.sub);
        hit = si >= 0 ? { si, ai: a.index, which: h ? h.which : null } : null;
      }
    }
    const prev = penState.hoverHit;
    const hitChanged = (hit?.si !== prev?.si) || (hit?.ai !== prev?.ai)
      || (hit?.which ?? null) !== (prev?.which ?? null) || (!!hit !== !!prev);
    penState.hoverHit = hit;
    // Rubber band + snap ring live on the overlay pass (main canvas), which
    // only repaints on a tick — but skip the (re)composite while idle hovering.
    if (open || snapChanged || hitChanged) invalidate();
  },
};

// ---------- keys (Enter close / Esc abandon), routed via core/toolKeys ----------

onToolKey((e: KeyboardEvent) => {
  if (store.tool !== 'pen') return false;
  if (e.key === 'Enter') {
    if (closeCurrentSubpath()) {
      invalidate();
      return true;
    }
    return false;
  }
  if (e.key === 'Escape') {
    const work = getWorkPath();
    if (!work) return false;
    drag = null;
    altDelete = null;
    const open = currentOpenSub(work);
    if (open) work.subpaths.pop(); // discard only the subpath being drawn
    else work.subpaths.length = 0; // nothing open: clear the whole work path
    if (!work.subpaths.length) clearWorkPath();
    invalidate();
    return true;
  }
  return false;
});

// ---------- live overlay (screen space, registered in core/overlayRegistry) ----------

function traceSegment(
  ctx: CanvasRenderingContext2D,
  a: PathAnchor, b: PathAnchor,
  X: (dx: number) => number, Y: (dy: number) => number,
): void {
  const c1 = handleAbs(a, 'out');
  const c2 = handleAbs(b, 'in');
  if (!c1 && !c2) {
    ctx.lineTo(X(b.p[0]), Y(b.p[1]));
  } else {
    const f1 = c1 ?? anchorPoint(a);
    const f2 = c2 ?? anchorPoint(b);
    ctx.bezierCurveTo(X(f1.x), Y(f1.y), X(f2.x), Y(f2.y), X(b.p[0]), Y(b.p[1]));
  }
}

registerOverlay('pen', (ctx, _z, X, Y) => {
  const work = getWorkPath();
  if (!work || !work.subpaths.length) return;
  const subs = work.subpaths;
  const openIdx = !subs[subs.length - 1].closed ? subs.length - 1 : -1;
  const penActive = store.tool === 'pen';

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (let si = 0; si < subs.length; si++) {
    const sub = subs[si];

    // rubber band: dashed preview of where the next anchor would land
    if (penActive && si === openIdx && penState.hover && sub.anchors.length) {
      const lastA = sub.anchors[sub.anchors.length - 1];
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(X(lastA.p[0]), Y(lastA.p[1]));
      ctx.lineTo(X(penState.hover.x), Y(penState.hover.y));
      ctx.strokeStyle = 'rgba(74,163,255,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    if (sub.anchors.length >= 2) {
      ctx.beginPath();
      const first = sub.anchors[0];
      ctx.moveTo(X(first.p[0]), Y(first.p[1]));
      for (let i = 1; i < sub.anchors.length; i++) {
        traceSegment(ctx, sub.anchors[i - 1], sub.anchors[i], X, Y);
      }
      if (sub.closed) {
        traceSegment(ctx, sub.anchors[sub.anchors.length - 1], first, X, Y);
        ctx.closePath();
      }
      ctx.strokeStyle = PEN_BLUE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // handles: thin line anchor→handle plus a small round dot (drawn before the
    // anchor squares so squares sit on top at the shared anchor point); the
    // hovered handle gets a highlight ring (post-edit affordance)
    for (let ai = 0; ai < sub.anchors.length; ai++) {
      const a = sub.anchors[ai];
      const p = anchorPoint(a);
      for (const which of ['in', 'out'] as const) {
        const h = handleAbs(a, which);
        if (!h) continue;
        ctx.beginPath();
        ctx.moveTo(X(p.x), Y(p.y));
        ctx.lineTo(X(h.x), Y(h.y));
        ctx.strokeStyle = 'rgba(74,163,255,0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(X(h.x), Y(h.y), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = PEN_BLUE;
        ctx.stroke();
        if (penActive && penState.hoverHit?.si === si
          && penState.hoverHit.ai === ai && penState.hoverHit.which === which) {
          ctx.beginPath();
          ctx.arc(X(h.x), Y(h.y), 5.5, 0, Math.PI * 2);
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // anchors: fixed-size white squares (screen px — they must stay clickable-
    // looking at any zoom); hovered anchor gets a highlight ring
    for (let ai = 0; ai < sub.anchors.length; ai++) {
      const a = sub.anchors[ai];
      const sx = X(a.p[0]), sy = Y(a.p[1]);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1;
      ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
      ctx.strokeRect(sx - 2.5, sy - 2.5, 5, 5);
      if (penActive && penState.hoverHit?.si === si
        && penState.hoverHit.ai === ai && penState.hoverHit.which === null) {
        ctx.strokeStyle = PEN_BLUE;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx - 5.5, sy - 5.5, 11, 11);
      }
    }

    // snap hint: hollow ring around the first anchor while hovering in range
    if (penActive && penState.snap && si === openIdx) {
      const f = sub.anchors[0];
      ctx.strokeStyle = PEN_BLUE;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(X(f.p[0]) - 5, Y(f.p[1]) - 5, 10, 10);
    }
  }
  ctx.restore();
});

// ---------- dev/test hook: Playwright reads the work path from here ----------

if (import.meta.env.DEV) {
  (window as unknown as { __penDebug: unknown }).__penDebug = {
    // plain-data clone: survives evaluate() serialization (strips Vue proxies)
    getWorkPath: () => {
      const w = getWorkPath();
      return w ? JSON.parse(JSON.stringify(w)) : null;
    },
  };
}
