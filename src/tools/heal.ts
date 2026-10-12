// Healing brush (mode 'heal': Alt+click sets a doc-space source point, strokes
// graft the sampled luminance onto the target's colour per dab) and spot
// healing (mode 'spot': strokes collect soft stamps; on pointer-up the covered
// region is content-aware filled by core/healEngine's diffusion solver).
// Strokes draw into a layer-local overlay published through store.strokePreview
// for the live compositor merge; each commit is a single rasterEdit. Sampling
// goes through docToLayer/layerToDoc like the clone stamp, so rotated/scaled
// layers heal in layer space with the source fetched through the transform.

import { store, activeLayer, rasterEdit, rawCanvas, flattenDoc } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead, docToLayer, clamp } from '../core/canvasUtils';
import { registerOverlay } from '../core/overlayRegistry';
import { spotHealRegion, fuseHealPatch } from '../core/healEngine';
import type { Layer } from '../core/types';
import type { Tool, ToolEvent } from './index';

interface HealSession {
  layer: Layer;
  mode: 'spot' | 'heal';
  overlay: HTMLCanvasElement;        // layer-local stroke accumulator
  ox: CanvasRenderingContext2D;
  pristine: HTMLCanvasElement;       // the bitmap at stroke start (target pixels)
  flatDoc: HTMLCanvasElement | null; // heal mode: doc snapshot for source sampling
  size: number;                      // dab diameter, layer px
  hardness: number;
  offset: { x: number; y: number } | null; // heal mode: stroke offset from the source, doc px
  last: { x: number; y: number };
  covered: boolean;                  // at least one dab landed on the bitmap
  minX: number; minY: number; maxX: number; maxY: number; // dab-centre bbox
  scratch: HTMLCanvasElement;        // per-dab buffer (mask/profile + clip)
  sx: CanvasRenderingContext2D;
  patchT: HTMLCanvasElement;         // heal: pristine target patch buffer
  patchS: HTMLCanvasElement;         // heal: doc-snapshot source patch buffer
  clipMask: HTMLCanvasElement | null;
}

let session: HealSession | null = null;

// Module-state source point (like paint.ts's cloneSource) plus a transient
// hint — shown via the overlay registry because Alt-without-source has no
// stroke to speak for and alert() would block the event loop.
let healSource: { x: number; y: number } | null = null;
let hint: { text: string; until: number } | null = null;

function showHint(text: string) {
  hint = { text, until: performance.now() + 1600 };
  store.tick++; // nudge a redraw so the hint shows even without pointer movement
}

// Source-point crosshair (clone-marker style double stroke), only in heal mode.
registerOverlay('heal-source-marker', (ctx, _z, X, Y) => {
  if (store.tool !== 'heal' || store.opts.heal.mode !== 'heal' || !healSource) return;
  const mx = X(healSource.x), my = Y(healSource.y);
  ctx.save();
  for (const [color, width] of [['rgba(255,255,255,0.95)', 3], ['rgba(0,0,0,0.85)', 1]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(mx - 8, my); ctx.lineTo(mx + 8, my);
    ctx.moveTo(mx, my - 8); ctx.lineTo(mx, my + 8);
    ctx.stroke();
  }
  ctx.restore();
});

// Transient hint pill above the document centre.
registerOverlay('heal-hint', (ctx, _z, X, Y) => {
  if (!hint || !store.doc || performance.now() > hint.until) return;
  const cx = X(store.doc.width / 2);
  const cy = Y(store.doc.height / 2) - 28;
  ctx.save();
  ctx.font = '12px "Segoe UI", sans-serif';
  const w = ctx.measureText(hint.text).width + 20;
  ctx.fillStyle = 'rgba(30,30,30,0.88)';
  ctx.fillRect(cx - w / 2, cy - 12, w, 24);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - w / 2 + 0.5, cy - 11.5, w - 1, 23);
  ctx.fillStyle = '#ddd';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(hint.text, cx, cy);
  ctx.restore();
});

function localOf(s: HealSession, e: ToolEvent) {
  return docToLayer(
    { ...s.layer.transform, naturalWidth: s.overlay.width, naturalHeight: s.overlay.height },
    e.doc,
  );
}

/** Layer-local point → doc space (inverse of localOf); ignores flips exactly
 *  like the clone stamp's sampling does. */
function layerToDoc(s: HealSession, lx: number, ly: number): { x: number; y: number } {
  const t = s.layer.transform;
  const cx = t.origin[0] + t.size[0] / 2, cy = t.origin[1] + t.size[1] / 2;
  const rad = (t.rotation * Math.PI) / 180;
  const dx = (lx - s.overlay.width / 2) * (t.size[0] / s.overlay.width);
  const dy = (ly - s.overlay.height / 2) * (t.size[1] / s.overlay.height);
  return {
    x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

/** Layer-local copy of the doc-space selection mask for stroke clipping
 *  (same construction as the painting tools'). */
function buildClipMask(layer: Layer): HTMLCanvasElement | null {
  const sel = store.selection;
  if (!sel?.bounds || !layer.bitmap) return null;
  const c = makeCanvas(layer.bitmap.width, layer.bitmap.height);
  const cx = ctx2d(c);
  const t = layer.transform;
  cx.save();
  const [ox, oy] = t.origin;
  const [w, h] = t.size;
  cx.translate(ox + w / 2, oy + h / 2);
  cx.rotate((t.rotation * Math.PI) / 180);
  cx.scale(w / c.width, h / c.height);
  cx.drawImage(sel.mask, -c.width / 2, -c.height / 2);
  cx.restore();
  return c;
}

function beginSession(
  e: ToolEvent, mode: 'spot' | 'heal', offset: { x: number; y: number } | null,
): HealSession | null {
  const layer = activeLayer.value;
  if (!store.doc || !layer || layer.isGroup || layer.adjustment) return null;
  if (!layer.bitmap) return null;
  if (store.paintingTarget === 'mask') return null; // v1: image pixels only

  const base = layer.bitmap;
  // the slider size is in document px; strokes live in layer px
  const layerScale = (layer.transform.size[0] / base.width) || 1;
  const s: HealSession = {
    layer,
    mode,
    overlay: rawCanvas(makeCanvas(base.width, base.height)),
    ox: ctx2d(makeCanvas(1, 1)), // replaced below; keep types happy
    pristine: base,
    flatDoc: mode === 'heal' ? flattenDoc() : null,
    size: Math.max(2, store.opts.heal.size / layerScale),
    hardness: store.opts.heal.hardness,
    offset,
    last: { x: 0, y: 0 },
    covered: false,
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    scratch: makeCanvas(2, 2),
    sx: ctx2d(makeCanvas(1, 1)), // replaced below
    patchT: makeCanvas(2, 2),
    patchS: makeCanvas(2, 2),
    clipMask: buildClipMask(layer),
  };
  s.ox = ctx2d(s.overlay);
  s.sx = ctx2d(s.scratch);
  const local = localOf(s, e);
  s.last = local;
  dab(s, local.x, local.y);
  store.strokePreview = { layerId: layer.id, canvas: s.overlay };
  store.tick++;
  return s;
}

function dab(s: HealSession, x: number, y: number) {
  const w = s.overlay.width, h = s.overlay.height;
  const r = Math.max(1, s.size / 2);
  const d = Math.ceil(r * 2 + 2);
  if (s.scratch.width !== d) { s.scratch.width = d; s.scratch.height = d; }
  s.sx.clearRect(0, 0, d, d);
  if (x < -d || y < -d || x > w + d || y > h + d) return; // fully off-bitmap
  s.minX = Math.min(s.minX, x); s.minY = Math.min(s.minY, y);
  s.maxX = Math.max(s.maxX, x); s.maxY = Math.max(s.maxY, y);
  if (x >= 0 && y >= 0 && x < w && y < h) s.covered = true;
  if (s.mode === 'spot') stampSpot(s, x, y, d, r); else stampHeal(s, x, y, d);
  s.ox.drawImage(s.scratch, x - d / 2, y - d / 2);
}

/** Clip a filled dab scratch through the selection mask. The scratch is fresh
 *  per dab, so the antialiased clip edge is applied once, not per stroke. */
function applyClip(s: HealSession, x: number, y: number, d: number) {
  if (!s.clipMask) return;
  s.sx.globalCompositeOperation = 'destination-in';
  s.sx.drawImage(s.clipMask, -(x - d / 2), -(y - d / 2));
  s.sx.globalCompositeOperation = 'source-over';
}

/** Mean colour of the ring hugging the dab (alpha-weighted, sparse grid so big
 *  brushes stay cheap), read from the pristine bitmap — a live approximation of
 *  the colour diffusion will pull inward. */
function ringAverage(base: HTMLCanvasElement, x: number, y: number, r: number): string {
  const rIn = r * 1.05, rOut = r * 1.4;
  const x0 = Math.max(0, Math.floor(x - rOut)), y0 = Math.max(0, Math.floor(y - rOut));
  const x1 = Math.min(base.width, Math.ceil(x + rOut)), y1 = Math.min(base.height, Math.ceil(y + rOut));
  if (x1 <= x0 || y1 <= y0) return 'rgba(128,128,128,1)';
  const data = ctx2dRead(base).getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const stride = Math.max(1, Math.floor(rOut / 20));
  let rr = 0, gg = 0, bb = 0, aa = 0;
  for (let py = y0; py < y1; py += stride) {
    for (let pxl = x0; pxl < x1; pxl += stride) {
      const dist = Math.hypot(pxl - x, py - y);
      if (dist < rIn || dist > rOut) continue;
      const i = ((py - y0) * (x1 - x0) + (pxl - x0)) * 4;
      const a = data[i + 3];
      if (!a) continue;
      rr += data[i] * a; gg += data[i + 1] * a; bb += data[i + 2] * a; aa += a;
    }
  }
  if (aa <= 0) return 'rgba(128,128,128,1)';
  return `rgba(${Math.round(rr / aa)},${Math.round(gg / aa)},${Math.round(bb / aa)},1)`;
}

/** Spot stamp: soft round profile (hardness = solid core ratio) tinted with the
 *  ring average. The overlay's alpha channel doubles as the heal-strength mask
 *  read back at commit, so preview coverage and committed mask can't diverge. */
function stampSpot(s: HealSession, x: number, y: number, d: number, r: number) {
  const tint = ringAverage(s.pristine, x, y, r);
  const g = s.sx.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, r);
  const core = clamp(s.hardness, 0, 0.95);
  g.addColorStop(0, tint);
  g.addColorStop(core, tint);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  s.sx.fillStyle = g;
  s.sx.beginPath();
  s.sx.arc(d / 2, d / 2, r, 0, Math.PI * 2);
  s.sx.fill();
  applyClip(s, x, y, d);
}

/** Heal stamp: fetch the doc snapshot translated by the stroke's source offset
 *  into the dab's layer-local frame (clone-stamp sampling through the layer
 *  transform), then fuse its luminance onto the pristine target patch. */
function stampHeal(s: HealSession, x: number, y: number, d: number) {
  if (!s.flatDoc || !s.offset) return;
  const t = s.layer.transform;
  if (s.patchT.width !== d) { s.patchT.width = d; s.patchT.height = d; }
  const tx = ctx2d(s.patchT);
  tx.clearRect(0, 0, d, d);
  tx.drawImage(s.pristine, -(x - d / 2), -(y - d / 2));
  if (s.patchS.width !== d) { s.patchS.width = d; s.patchS.height = d; }
  const psx = ctx2d(s.patchS);
  psx.clearRect(0, 0, d, d);
  const docPt = layerToDoc(s, x, y);
  const srcDoc = { x: docPt.x - s.offset.x, y: docPt.y - s.offset.y };
  psx.save();
  psx.translate(d / 2, d / 2);
  psx.rotate((t.rotation * Math.PI) / 180);
  psx.scale((t.size[0] / s.overlay.width) || 1, (t.size[1] / s.overlay.height) || 1);
  psx.drawImage(s.flatDoc, -srcDoc.x, -srcDoc.y);
  psx.restore();

  const tgt = ctx2dRead(s.patchT).getImageData(0, 0, d, d);
  const src = ctx2dRead(s.patchS).getImageData(0, 0, d, d);
  s.sx.putImageData(fuseHealPatch(tgt, src, s.hardness), 0, 0);
  applyClip(s, x, y, d);
}

function lineDabs(s: HealSession, from: { x: number; y: number }, to: { x: number; y: number }) {
  // same 15%-of-diameter spacing cadence as the painting tools
  const spacing = Math.max(1, s.size * 0.15);
  const dx = to.x - from.x, dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
  for (let i = 1; i <= steps; i++) {
    dab(s, from.x + (dx * i) / steps, from.y + (dy * i) / steps);
  }
}

interface Roi { x: number; y: number; w: number; h: number }

/** Stroke bounding box padded by the dab radius, clamped to the bitmap. */
function strokeRoi(s: HealSession): Roi | null {
  if (!s.covered) return null;
  const pad = s.size / 2 + 2;
  const x0 = Math.max(0, Math.floor(s.minX - pad));
  const y0 = Math.max(0, Math.floor(s.minY - pad));
  const x1 = Math.min(s.overlay.width, Math.ceil(s.maxX + pad));
  const y1 = Math.min(s.overlay.height, Math.ceil(s.maxY + pad));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A stroke whose overlay carries no real coverage commits no history entry. */
function hasCoverage(s: HealSession, roi: Roi): boolean {
  const data = ctx2dRead(s.overlay).getImageData(roi.x, roi.y, roi.w, roi.h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= 8) return true;
  return false;
}

function commit() {
  const s = session;
  session = null;
  store.strokePreview = null;
  if (!s) return;
  const roi = strokeRoi(s);
  if (!roi || !hasCoverage(s, roi)) { store.tick++; return; }
  if (s.mode === 'spot') commitSpot(s, roi); else commitHeal(s);
}

function commitSpot(s: HealSession, roi: Roi) {
  rasterEdit(s.layer, '污点修复', bmp => {
    // the overlay alpha IS the strength mask (see stampSpot)
    const maskData = ctx2dRead(s.overlay).getImageData(roi.x, roi.y, roi.w, roi.h).data;
    const mask = new Uint8Array(roi.w * roi.h);
    for (let p = 0; p < mask.length; p++) mask[p] = maskData[p * 4 + 3];
    const bx = ctx2dRead(bmp);
    const healed = spotHealRegion(bx.getImageData(roi.x, roi.y, roi.w, roi.h), mask);
    ctx2d(bmp).putImageData(healed, roi.x, roi.y);
  });
}

function commitHeal(s: HealSession) {
  const overlay = s.overlay;
  rasterEdit(s.layer, '修复画笔', bmp => {
    ctx2d(bmp).drawImage(overlay, 0, 0);
  });
}

export const healTool: Tool = {
  id: 'heal',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    if (store.opts.heal.mode === 'heal') {
      if (e.alt) {
        healSource = { x: e.doc.x, y: e.doc.y };
        showHint('修复源已设置');
        return;
      }
      if (!healSource) {
        showHint('按住 Alt 单击设置修复源点');
        return;
      }
      session = beginSession(e, 'heal', { x: e.doc.x - healSource.x, y: e.doc.y - healSource.y });
      return;
    }
    session = beginSession(e, 'spot', null);
  },
  onDrag(e) {
    if (!session) return;
    const local = localOf(session, e);
    lineDabs(session, session.last, local);
    session.last = local;
    store.tick++;
  },
  onUp() { commit() },
};
