// Selection tools: rectangle/ellipse marquee, freehand/polygonal lasso, magic wand.
// All build a selection mask; Shift adds and Alt subtracts, as in Photoshop.

import { reactive } from 'vue';
import { store, flattenDoc, history } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead, cloneCanvas } from '../core/canvasUtils';
import {
  emptySelection, combinePath, selectionFromMaskArray, finalize, combine,
} from '../core/selection';
import { wandMask } from '../core/pixels/wand';
import { pickObjectAt } from '../core/selectionOps/subjectApprox';
import type { SelectionOp, SelectionState } from '../core/selection';
import type { Tool, ToolEvent } from './index';

function opFor(e: { shift: boolean; alt: boolean }): SelectionOp {
  return e.shift ? 'add' : e.alt ? 'sub' : 'replace';
}

function ensureSelection() {
  if (!store.selection) store.selection = emptySelection(store.doc!);
  return store.selection;
}

/** Scratch doc-size canvas the shape is painted onto, then combined into the selection. */
function scratch(): { c: HTMLCanvasElement; x: CanvasRenderingContext2D } {
  const c = makeCanvas(store.doc!.width, store.doc!.height);
  return { c, x: ctx2d(c) };
}

// ---------- marquee ----------

interface MarqueeSession { start: { x: number; y: number }; op: SelectionOp; shape: 'rectangle' | 'ellipse' }
let marquee: MarqueeSession | null = null;

export const marqueeTool: Tool = {
  id: 'marquee',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    marquee = { start: e.doc, op: opFor(e), shape: store.opts.marquee.shape };
    store.preview = { kind: 'marquee', shape: marquee.shape, from: marquee.start, to: e.doc };
  },
  onDrag(e) {
    if (!marquee) return;
    store.preview = { kind: 'marquee', shape: marquee.shape, from: marquee.start, to: e.doc };
  },
  onUp(e) {
    if (!marquee) return;
    const { shape, start, op } = marquee;
    marquee = null;
    store.preview = null;
    const x = Math.min(start.x, e.doc.x), y = Math.min(start.y, e.doc.y);
    const w = Math.abs(e.doc.x - start.x), h = Math.abs(e.doc.y - start.y);
    if (w < 1 || h < 1) { if (op === 'replace') store.selection = null; return; }
    const { c, x: cx } = scratch();
    cx.fillStyle = '#fff';
    if (shape === 'ellipse') {
      cx.beginPath();
      cx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      cx.fill();
    } else {
      cx.fillRect(x, y, w, h);
    }
    const sel = ensureSelection();
    if (sel.mask.width !== store.doc!.width || sel.mask.height !== store.doc!.height) {
      store.selection = emptySelection(store.doc!);
    }
    combinePath(store.selection!, c, op);
  },
};

// ---------- lasso ----------

interface LassoSession { points: { x: number; y: number }[]; op: SelectionOp; dragging: boolean }
let lasso: LassoSession | null = null;

export const lassoTool: Tool = {
  id: 'lasso',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    if (store.opts.lasso.polygonal && lasso && !lasso.dragging) {
      // continue the polygon: add a vertex
      lasso.points.push(e.doc);
      store.preview = { kind: 'lasso', points: [...lasso.points] };
      return;
    }
    lasso = { points: [e.doc], op: opFor(e), dragging: !store.opts.lasso.polygonal };
    store.preview = { kind: 'lasso', points: [e.doc] };
  },
  onDrag(e) {
    if (!lasso || !lasso.dragging) return;
    lasso.points.push(e.doc);
    store.preview = { kind: 'lasso', points: [...lasso.points] };
  },
  onUp() {
    if (!lasso) return;
    if (lasso.dragging) {
      commitLasso();
      return;
    }
    // polygonal: dblclick or Enter commits (see onDoubleClick); a plain up just adds the vertex
  },
  onDoubleClick() {
    if (lasso && !lasso.dragging) commitLasso();
  },
};

function commitLasso() {
  const s = lasso;
  lasso = null;
  store.preview = null;
  if (!s || s.points.length < 3) { store.selection = null; return; }
  const { c, x: cx } = scratch();
  cx.fillStyle = '#fff';
  cx.beginPath();
  cx.moveTo(s.points[0].x, s.points[0].y);
  for (const p of s.points.slice(1)) cx.lineTo(p.x, p.y);
  cx.closePath();
  cx.fill();
  if (!store.selection || store.selection.mask.width !== store.doc!.width) {
    store.selection = emptySelection(store.doc!);
  }
  combinePath(store.selection!, c, s.op);
}

/** Keyboard hook for the polygonal lasso: Enter commits, Esc cancels. */
export function lassoKey(e: KeyboardEvent): boolean {
  if (!lasso || lasso.dragging) return false;
  if (e.key === 'Enter') { commitLasso(); return true; }
  if (e.key === 'Escape') { lasso = null; store.preview = null; return true; }
  return false;
}

// ---------- magic wand ----------

/** 魔棒模式:pixel = 像素容差 flood fill;object = 点击拾取对象(主体近似)。UI 在 D 轮接线。 */
export const wandMode = reactive<{ mode: 'pixel' | 'object' }>({ mode: 'pixel' });

function restoreSelection(mask: HTMLCanvasElement | null): void {
  store.selection = mask
    ? finalize({ mask: cloneCanvas(mask), bounds: null, polygons: [] } as SelectionState)
    : null;
}

/** 对象模式选区也进历史:撤销/重做恢复选区蒙版(像素模式与原版一致,不进历史)。 */
function pushSelectionHistory(label: string, before: HTMLCanvasElement | null, after: HTMLCanvasElement | null): void {
  const beforeMask = before ? cloneCanvas(before) : null;
  const afterMask = after ? cloneCanvas(after) : null;
  history.push({
    label,
    undo: () => restoreSelection(beforeMask),
    redo: () => restoreSelection(afterMask),
  });
}

/** 对象模式点击:压平图 → 长边缩到 ≤1024 → pickObjectAt 蒙特 → 阈值 128 →
 *  平滑放大回文档尺寸 → 与现有选区按修饰键合并。 */
function wandObjectPick(e: ToolEvent): void {
  const doc = store.doc!;
  const flat = flattenDoc();

  const longEdge = Math.max(flat.width, flat.height);
  const s = longEdge > 1024 ? 1024 / longEdge : 1;
  const sw = Math.max(1, Math.round(flat.width * s));
  const sh = Math.max(1, Math.round(flat.height * s));
  const small = makeCanvas(sw, sh);
  const scx = ctx2dRead(small);
  scx.imageSmoothingEnabled = true;
  scx.imageSmoothingQuality = 'high';
  scx.drawImage(flat, 0, 0, sw, sh);
  const img = scx.getImageData(0, 0, sw, sh);

  const sx = Math.floor((e.doc.x * sw) / doc.width);
  const sy = Math.floor((e.doc.y * sh) / doc.height);
  if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) return;

  const matte = pickObjectAt(img, sx, sy);

  // 0..1 蒙特 → 缩放尺寸上的二值蒙版(阈值 128)
  const mask = new Uint8Array(sw * sh);
  let any = false;
  for (let p = 0; p < matte.length; p++) {
    if (matte[p] * 255 >= 128) { mask[p] = 255; any = true; }
  }
  if (!any && opFor(e) === 'replace') { store.selection = null; return; }

  // 二值蒙版入画布后平滑放大到文档尺寸(alpha 双线性插值 → 软边缘)
  const mc = makeCanvas(sw, sh);
  const mx = ctx2dRead(mc);
  const mid = mx.createImageData(sw, sh);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    mid.data[i] = mid.data[i + 1] = mid.data[i + 2] = 255;
    mid.data[i + 3] = mask[p];
  }
  mx.putImageData(mid, 0, 0);

  const up = makeCanvas(doc.width, doc.height);
  const ux = ctx2d(up);
  ux.imageSmoothingEnabled = true;
  ux.imageSmoothingQuality = 'high';
  ux.drawImage(mc, 0, 0, doc.width, doc.height);

  const newSel = emptySelection(doc);
  ctx2d(newSel.mask).drawImage(up, 0, 0);
  finalize(newSel);

  const prev = store.selection;
  const prevMask = prev ? cloneCanvas(prev.mask) : null;
  const op = opFor(e);
  if (!prev || prev.mask.width !== doc.width || prev.mask.height !== doc.height || op === 'replace') {
    store.selection = newSel;
  } else {
    combine(prev, newSel.mask, op);
    finalize(prev);
  }
  pushSelectionHistory('对象选取', prevMask, store.selection ? store.selection.mask : null);
}

export const wandTool: Tool = {
  id: 'wand',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    if (wandMode.mode === 'object') { wandObjectPick(e); return; }
    const flat = flattenDoc();
    const sx = Math.round(e.doc.x), sy = Math.round(e.doc.y);
    if (sx < 0 || sy < 0 || sx >= flat.width || sy >= flat.height) return;
    const id = ctx2d(flat).getImageData(0, 0, flat.width, flat.height);
    const o = store.opts.wand;
    const result = wandMask(
      id.data, flat.width, flat.height, sx, sy,
      Math.round(o.sampleRadius), o.tolerance, o.contiguous,
    );
    if (result.count === 0 && opFor(e) === 'replace') { store.selection = null; return; }
    const newSel = selectionFromMaskArray(store.doc, result.mask);
    const sel = store.selection;
    if (!sel || opFor(e) === 'replace') {
      store.selection = newSel;
    } else {
      combine(sel, newSel.mask, opFor(e));
      finalize(sel);
    }
  },
};
