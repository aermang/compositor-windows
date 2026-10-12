// Content-Aware Move tool: lasso a region, drag to the destination, release to
// move the region there and intelligently fill the hole it left. Two-phase
// interaction mirrors patch.ts:
//   phase 1 — freehand lasso; on release (≥3 points) it becomes the move region
//             (doc-space polygon, module state, white dashed outline).
//   phase 2 — press inside the region and drag; the overlay shows the original
//             region (white dashed) and the target region+offset (red dashed).
//             On release with a ≥1px offset a single rasterEdit('感知移动')
//             commits both halves of the move as one history entry:
//               1. the move — the flattened document is sampled at the region
//                  and grafted at region+offset through a ~4px feathered mask;
//               2. the hole — the part of the original region the move did NOT
//                  cover (region minus its overlap with the target) is
//                  synthesized by the contentFill engine over a padded ROI and
//                  put back through a ~1.5px soft mask.
// v1 is move-only (PS's Extend mode can be approximated with 修补 + selection
// expansion). Selection clipping, editable-layer checks and the docToLayer
// mapping follow patch.ts exactly; like patch there is no Esc handling and the
// region resets to phase 1 after every commit.

import { store, activeLayer, rasterEdit, flattenDoc } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead, docToLayer } from '../core/canvasUtils';
import { registerOverlay } from '../core/overlayRegistry';
import { contentFill } from '../core/selectionOps/contentFill';
import type { Layer } from '../core/types';
import type { Tool } from './index';

type Pt = { x: number; y: number };

let region: Pt[] | null = null;                 // closed lasso region, doc coords
let lasso: { points: Pt[] } | null = null;      // phase 1 in progress
let sampling: { start: Pt; offset: Pt } | null = null; // phase 2 in progress

/** Feather of the move graft, doc px (same feel as patch.ts). */
const MOVE_FEATHER = 4;
/** Soft put-back of the synthesized hole fill, doc px. */
const FILL_FEATHER = 1.5;
/** Hole-fill donor margin around the region ∪ target bbox, doc px
 *  (same padding the 内容识别填充 dialog uses). */
const FILL_MARGIN = 48;

/** Even-odd ray cast, doc space. */
function pointInPoly(poly: Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function editableLayer(): Layer | null {
  const layer = activeLayer.value;
  if (!store.doc || !layer || layer.isGroup || layer.adjustment) return null;
  if (!layer.bitmap || store.paintingTarget === 'mask') return null; // v1: image pixels only
  return layer;
}

// Screen-space overlay: white dashed outline while lassoing/idle; during the
// sampling drag the original region stays white and the target (region+offset)
// turns red, so the move direction reads at a glance.
registerOverlay('camove-region', (ctx, _z, X, Y) => {
  if (store.tool !== 'camove' || !store.doc) return;
  const pts = lasso ? lasso.points : region;
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  if (sampling) {
    const smp = sampling;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; // original region
    tracePoly(ctx, pts, X, Y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,90,90,0.95)';   // target region, region+offset
    tracePoly(ctx, pts.map(p => ({ x: p.x + smp.offset.x, y: p.y + smp.offset.y })), X, Y);
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    tracePoly(ctx, pts, X, Y);
    ctx.stroke();
  }
  ctx.restore();
});

function tracePoly(ctx: CanvasRenderingContext2D, pts: Pt[], X: (dx: number) => number, Y: (dy: number) => number) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
  ctx.closePath();
}

function tracePolyDoc(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

/** Append a doc-space polygon to `path` mapped into layer-local pixels. */
function addPoly(
  path: Path2D, pts: Pt[], bmpW: number, bmpH: number,
  t: { origin: [number, number]; size: [number, number]; rotation: number; flipX: boolean; flipY: boolean },
) {
  pts.forEach((p, i) => {
    const l = docToLayer({ ...t, naturalWidth: bmpW, naturalHeight: bmpH }, p);
    if (i) path.lineTo(l.x, l.y); else path.moveTo(l.x, l.y);
  });
  path.closePath();
}

/**
 * Synthesize the hole (region minus the target overlap) in place on `work` with
 * the contentFill engine. The engine wants (ImageData, binary mask), so it gets
 * a padded doc-space ROI of the working snapshot plus the thresholded hole
 * mask; the filled pixels come back through a soft mask instead of a hard
 * putImageData seam.
 */
function fillHole(work: HTMLCanvasElement, region: Pt[], target: Pt[], docW: number, docH: number) {
  // binary hole mask, doc space: region minus the target overlap
  const hole = makeCanvas(docW, docH);
  const hx = ctx2d(hole);
  hx.fillStyle = '#fff';
  tracePolyDoc(hx, region);
  hx.fill();
  hx.globalCompositeOperation = 'destination-out';
  tracePolyDoc(hx, target);
  hx.fill();
  hx.globalCompositeOperation = 'source-over';

  // ROI: bbox(region ∪ target) padded for donors, clamped to the doc
  const pts = [...region, ...target];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - FILL_MARGIN);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - FILL_MARGIN);
  const x1 = Math.min(docW, Math.ceil(Math.max(...xs)) + FILL_MARGIN);
  const y1 = Math.min(docH, Math.ceil(Math.max(...ys)) + FILL_MARGIN);
  const subW = x1 - x0, subH = y1 - y0;
  if (subW <= 0 || subH <= 0) return;

  // crop the hole mask to the ROI and threshold it like the fill dialog does
  const mc = makeCanvas(subW, subH);
  ctx2d(mc).drawImage(hole, x0, y0, subW, subH, 0, 0, subW, subH);
  const md = ctx2dRead(mc).getImageData(0, 0, subW, subH).data;
  const mask = new Uint8Array(subW * subH);
  let count = 0;
  for (let p = 0; p < mask.length; p++) {
    mask[p] = md[p * 4 + 3] >= 128 ? 255 : 0;
    if (mask[p]) count++;
  }
  if (!count) return; // move covered the region completely — no hole left

  const wx = ctx2dRead(work);
  const sub = wx.getImageData(x0, y0, subW, subH);
  const res = contentFill(sub, mask);
  if (!res.ok) return; // v1: no opaque donors around → leave the hole untouched

  const filled = makeCanvas(subW, subH);
  ctx2d(filled).putImageData(sub, 0, 0);
  const soft = makeCanvas(subW, subH);
  const sx = ctx2d(soft);
  sx.filter = `blur(${FILL_FEATHER}px)`;
  sx.drawImage(mc, 0, 0);
  sx.filter = 'none';
  const fcx = ctx2d(filled);
  fcx.globalCompositeOperation = 'destination-in';
  fcx.drawImage(soft, 0, 0);
  fcx.globalCompositeOperation = 'source-over';
  wx.drawImage(filled, x0, y0);
}

function commitMove(offset: Pt) {
  const layer = editableLayer();
  if (!layer || !layer.bitmap || !region || !store.doc) return;
  const doc = store.doc;
  const bmpW = layer.bitmap.width, bmpH = layer.bitmap.height;
  const t = layer.transform;
  const target = region.map(p => ({ x: p.x + offset.x, y: p.y + offset.y }));

  // Flattened snapshot BEFORE anything moves; every sample reads from it.
  const flat = flattenDoc();

  // Working doc-space raster the two steps compose into.
  const work = makeCanvas(doc.width, doc.height);
  const wx = ctx2d(work);
  wx.drawImage(flat, 0, 0);

  // Step 1 — the move: flat sampled at the region, grafted at region+offset
  // through a ~4px feathered mask so the graft fades in instead of cutting.
  const moved = makeCanvas(doc.width, doc.height);
  const mx = ctx2d(moved);
  mx.drawImage(flat, offset.x, offset.y); // moved(q) = flat(q - offset)
  const feather = makeCanvas(doc.width, doc.height);
  const fx = ctx2d(feather);
  fx.filter = `blur(${MOVE_FEATHER}px)`;
  fx.fillStyle = '#fff';
  tracePolyDoc(fx, target);
  fx.fill();
  fx.filter = 'none';
  mx.globalCompositeOperation = 'destination-in';
  mx.drawImage(feather, 0, 0);
  mx.globalCompositeOperation = 'source-over';
  wx.drawImage(moved, 0, 0);

  // Step 2 — the hole the move left behind, synthesized in place.
  fillHole(work, region, target, doc.width, doc.height);

  // One history entry: graft the working raster into the active layer, clipped
  // to region ∪ target (two same-winding subpaths = union) through the layer
  // transform, exactly like patch.ts.
  const path = new Path2D();
  addPoly(path, region, bmpW, bmpH, t);
  addPoly(path, target, bmpW, bmpH, t);

  rasterEdit(layer, '感知移动', bmp => {
    const bx = ctx2d(bmp);
    bx.save();
    bx.clip(path);
    // doc-space working canvas → layer-local frame (same order as heal.ts)
    bx.translate(bmp.width / 2, bmp.height / 2);
    bx.rotate((-t.rotation * Math.PI) / 180);
    bx.scale((t.size[0] / bmp.width) || 1, (t.size[1] / bmp.height) || 1);
    bx.drawImage(work, -t.origin[0] - t.size[0] / 2, -t.origin[1] - t.size[1] / 2);
    bx.restore();
  });
}

export const camoveTool: Tool = {
  id: 'camove',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    if (!editableLayer()) return;
    if (region && pointInPoly(region, e.doc)) {
      // phase 2: drag the move offset
      sampling = { start: { ...e.doc }, offset: { x: 0, y: 0 } };
    } else {
      // phase 1: fresh lasso
      lasso = { points: [{ ...e.doc }] };
    }
    store.tick++;
  },
  onDrag(e) {
    if (lasso) {
      const last = lasso.points[lasso.points.length - 1];
      if (Math.hypot(e.doc.x - last.x, e.doc.y - last.y) >= 2) lasso.points.push({ ...e.doc });
      store.tick++;
      return;
    }
    if (sampling) {
      sampling.offset = { x: e.doc.x - sampling.start.x, y: e.doc.y - sampling.start.y };
      store.tick++;
    }
  },
  onUp() {
    if (lasso) {
      region = lasso.points.length >= 3 ? lasso.points : null;
      lasso = null;
      store.tick++;
      return;
    }
    const s = sampling;
    sampling = null;
    if (!s) return;
    const off = s.offset;
    if (!region || (Math.abs(off.x) < 1 && Math.abs(off.y) < 1)) { store.tick++; return; } // click ≠ move
    commitMove(off);
    region = null; // back to phase 1
    store.tick++;
  },
};
