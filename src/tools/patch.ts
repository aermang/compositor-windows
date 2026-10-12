// Patch tool, two-phase interaction (v1):
//   phase 1 — drag a freehand lasso; on release it becomes the patch region
//             (doc-space polygon, module state, shown as a white dashed outline).
//   phase 2 — press inside the region and drag; the region outline turns red
//             while a green copy follows the pointer (the sample offset). On
//             release the flattened document is shifted by -offset so the
//             sampled content lands on the target position, clipped to the
//             region (through the layer transform) with a ~4px blurred feather
//             mask, and committed to the active layer as one rasterEdit.
// The region resets to phase 1 after every commit. There is deliberately no
// Esc handling (interaction decision for v1).

import { store, activeLayer, rasterEdit, flattenDoc } from '../core/store';
import { makeCanvas, ctx2d, docToLayer } from '../core/canvasUtils';
import { registerOverlay } from '../core/overlayRegistry';
import type { Layer } from '../core/types';
import type { Tool } from './index';

type Pt = { x: number; y: number };

let region: Pt[] | null = null;                 // closed lasso region, doc coords
let lasso: { points: Pt[] } | null = null;      // phase 1 in progress
let sampling: { start: Pt; offset: Pt } | null = null; // phase 2 in progress

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

// Screen-space overlay: white dashed outline while lassoing/idle, red (target,
// in place) + green (sample, region+offset) while dragging phase 2.
registerOverlay('patch-region', (ctx, _z, X, Y) => {
  if (store.tool !== 'patch' || !store.doc) return;
  const pts = lasso ? lasso.points : region;
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  if (lasso) {
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    tracePoly(ctx, pts, X, Y);
    ctx.stroke();
  } else if (sampling) {
    const smp = sampling;
    ctx.strokeStyle = 'rgba(255,90,90,0.95)'; // target region, original position
    tracePoly(ctx, pts, X, Y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(90,220,90,0.95)'; // sample region, shifted
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

function commitPatch(offset: Pt) {
  const layer = editableLayer();
  if (!layer || !layer.bitmap || !region || !store.doc) return;
  const bmpW = layer.bitmap.width, bmpH = layer.bitmap.height;
  const t = layer.transform;

  // Sampled content aligned to the target position: doc snapshot shifted by
  // -offset, so aligned(p) = flat(p + offset).
  const aligned = makeCanvas(store.doc.width, store.doc.height);
  const ax = ctx2d(aligned);
  ax.drawImage(flattenDoc(), -offset.x, -offset.y);

  // Feather mask: region filled white, edge blurred ~4px; multiplied in so the
  // graft fades out over ~4px instead of cutting hard at the polygon.
  const mask = makeCanvas(store.doc.width, store.doc.height);
  const mx = ctx2d(mask);
  mx.filter = 'blur(4px)';
  mx.fillStyle = '#fff';
  tracePolyDoc(mx, region);
  mx.fill();
  mx.filter = 'none';
  ax.globalCompositeOperation = 'destination-in';
  ax.drawImage(mask, 0, 0);
  ax.globalCompositeOperation = 'source-over';

  // Region polygon in layer-local pixels for the clip.
  const path = new Path2D();
  region.forEach((p, i) => {
    const l = docToLayer({ ...t, naturalWidth: bmpW, naturalHeight: bmpH }, p);
    if (i) path.lineTo(l.x, l.y); else path.moveTo(l.x, l.y);
  });
  path.closePath();

  rasterEdit(layer, '修补', bmp => {
    const bx = ctx2d(bmp);
    bx.save();
    bx.clip(path);
    // doc-space aligned canvas → layer-local frame (same order as heal.ts)
    bx.translate(bmp.width / 2, bmp.height / 2);
    bx.rotate((-t.rotation * Math.PI) / 180);
    bx.scale((t.size[0] / bmp.width) || 1, (t.size[1] / bmp.height) || 1);
    bx.drawImage(aligned, -t.origin[0] - t.size[0] / 2, -t.origin[1] - t.size[1] / 2);
    bx.restore();
  });
}

function tracePolyDoc(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

export const patchTool: Tool = {
  id: 'patch',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    if (!editableLayer()) return;
    if (region && pointInPoly(region, e.doc)) {
      // phase 2: drag the sample offset
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
    if (!region || (Math.abs(off.x) < 1 && Math.abs(off.y) < 1)) { store.tick++; return; } // click ≠ patch
    commitPatch(off);
    region = null; // back to phase 1
    store.tick++;
  },
};
