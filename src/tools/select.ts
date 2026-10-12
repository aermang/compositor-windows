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

/** 整档灰度梯度幅值缓存:磁性描画按下时算一次,拖动期间复用。 */
interface GradField { w: number; h: number; mag: Float32Array }

interface LassoSession {
  points: { x: number; y: number }[];
  op: SelectionOp;
  dragging: boolean;
  magnetic?: boolean;                    // 磁性模式:沿边缘吸附
  grad?: GradField;                      // 梯度缓存(仅磁性)
  lastRaw?: { x: number; y: number };    // 上一个原始指针位置(方向/距离基准)
  dir?: { x: number; y: number };        // 最近运动方向(单位向量,决定扫描窗口朝向)
  accDist?: number;                      // 距上次追加点累计移动的距离
}
let lasso: LassoSession | null = null;

/** 灰度 + 梯度幅值(中心差分,Sobel 的低成本替代)。灰度按 alpha 衰减,
 *  让透明文档的 alpha 边界也能产生梯度。每次磁性描画只调用一次。 */
function buildGradField(): GradField {
  const flat = flattenDoc();
  const w = flat.width, h = flat.height;
  const d = ctx2dRead(flat).getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    gray[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * (d[i + 3] / 255);
  }
  const mag = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const yUp = y > 0 ? y - 1 : y, yDn = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xL = x > 0 ? x - 1 : x, xR = x < w - 1 ? x + 1 : x;
      const gx = gray[y * w + xR] - gray[y * w + xL];
      const gy = gray[yDn * w + x] - gray[yUp * w + x];
      mag[y * w + x] = Math.hypot(gx, gy);
    }
  }
  return { w, h, mag };
}

/** 在与运动方向垂直的 ±width 窗口内取最强梯度;达到 contrast 阈值则吸附到该处,
 *  否则原地(指针位置)不动。 */
function magneticSnap(
  g: GradField, p: { x: number; y: number }, dir: { x: number; y: number },
): { x: number; y: number } {
  const o = store.opts.lasso;
  const nx = -dir.y, ny = dir.x;
  const thr = (o.contrast / 100) * 255;
  const half = Math.round(o.width);
  let best = -1, bestT = 0;
  for (let t = -half; t <= half; t++) {
    const x = Math.round(p.x + nx * t), y = Math.round(p.y + ny * t);
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
    const m = g.mag[y * g.w + x];
    if (m > best) { best = m; bestT = t; }
  }
  if (best < thr) return { x: p.x, y: p.y };
  return { x: p.x + nx * bestT, y: p.y + ny * bestT };
}

/** 磁性收集:累计移动 ≥ max(2, 100/frequency) 文档 px 才追加一个吸附点。 */
function magneticCollect(s: LassoSession, cur: { x: number; y: number }): void {
  const step = Math.max(2, 100 / Math.max(1, store.opts.lasso.frequency));
  const prev = s.lastRaw ?? cur;
  const dx = cur.x - prev.x, dy = cur.y - prev.y;
  const len = Math.hypot(dx, dy);
  if (len > 0) {
    s.dir = { x: dx / len, y: dy / len };
    s.lastRaw = cur;
  }
  s.accDist = (s.accDist ?? 0) + len;
  if (s.accDist < step || !s.grad || !s.dir) return;
  s.accDist = 0;
  s.points.push(magneticSnap(s.grad, cur, s.dir));
}

export const lassoTool: Tool = {
  id: 'lasso',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    if (lasso && !lasso.dragging && (store.opts.lasso.polygonal || lasso.magnetic)) {
      // 多边形续加顶点 / 磁性强制手动加点(单击,不做吸附)
      lasso.points.push(e.doc);
      store.preview = { kind: 'lasso', points: [...lasso.points] };
      return;
    }
    const magnetic = store.opts.lasso.magnetic;
    // 磁性与自由同为拖动式(dragging=true);仅多边形是点击式
    lasso = { points: [e.doc], op: opFor(e), dragging: !store.opts.lasso.polygonal, magnetic };
    if (magnetic) {
      // 梯度缓存整档一次,拖动期间不重算
      lasso.grad = buildGradField();
      lasso.lastRaw = e.doc;
      lasso.dir = { x: 1, y: 0 };
      lasso.accDist = 0;
    }
    store.preview = { kind: 'lasso', points: [e.doc] };
  },
  onDrag(e) {
    if (!lasso || !lasso.dragging) return;
    if (lasso.magnetic) {
      magneticCollect(lasso, e.doc);
    } else {
      lasso.points.push(e.doc);
    }
    store.preview = { kind: 'lasso', points: [...lasso.points] };
  },
  onUp() {
    if (!lasso) return;
    if (lasso.magnetic) {
      if (lasso.dragging && lasso.points.length > 1) {
        // 拖动式:松开即闭合(与自由套索同一 finalize 路径)
        commitLasso();
        return;
      }
      // 纯单击:转"待续加"会话,之后单击续加、Enter/双击闭合
      lasso.dragging = false;
      return;
    }
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

/** Keyboard hook for the polygonal lasso: Enter commits, Esc cancels.
 *  磁性拖动进行中也允许 Esc 取消本次描画(自由/多边形保持原行为)。 */
export function lassoKey(e: KeyboardEvent): boolean {
  if (!lasso) return false;
  if (lasso.dragging) {
    if (lasso.magnetic && e.key === 'Escape') { lasso = null; store.preview = null; return true; }
    return false;
  }
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
