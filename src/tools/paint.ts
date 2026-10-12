// Painting tools: brush, eraser (same engine, destination-out) and clone stamp.
// Strokes draw into a layer-local overlay canvas that the compositor merges live;
// on pointer-up the overlay commits into the layer bitmap (or its mask) with one
// history entry. An active selection clips stamps through a layer-local copy of
// the selection mask built once per stroke. With pen pressure on, each dab scales
// its diameter and opacity from the pointer's pressure (50%..100%); a stroke whose
// pressure never varies (mice report a constant 0.5) is stamped at full pressure,
// leaving mouse output identical to a pressure-less stroke.

import { store, history, activeLayer, rasterEdit, rawCanvas, flattenDoc, bumpLayerRev } from '../core/store';
import { uiFlags } from '../core/uiFlags';
import { makeCanvas, ctx2d, ctx2dRead, docToLayer, clamp } from '../core/canvasUtils';
import { getQuickMaskCanvas, QUICK_MASK_COLOR } from '../core/quickMask';
import type { Layer } from '../core/types';
import type { Tool, ToolEvent } from './index';

interface PaintSession {
  layer: Layer;
  target: 'image' | 'mask';
  overlay: HTMLCanvasElement;
  ox: CanvasRenderingContext2D;         // overlay context, layer-local
  erase: boolean;
  color: string;
  size: number; hardness: number; opacity: number;
  last: { x: number; y: number };       // layer-local stamp center
  lastPressure: number;                 // effective pressure of the last pointer event
  usePressure: boolean;                 // pressure scaling enabled (snapshot at stroke start)
  pConst: boolean;                      // all pressure samples so far are identical
  pValue: number;                       // the shared sample value while pConst holds
  painted: boolean;
  clipMask: HTMLCanvasElement | null;   // layer-local selection mask
  scratch: HTMLCanvasElement;
  sx: CanvasRenderingContext2D;
  cloneOffset: { x: number; y: number } | null;
  cloneSample: HTMLCanvasElement | null;
  // 快速蒙版会话:overlay 即 rubylith,提交走独立的 ImageData 恢复历史
  quickMask?: boolean;
  qmBefore?: ImageData;                 // 笔画开始时的 rubylith 快照
}

let session: PaintSession | null = null;

/** Layer-local copy of the doc-space selection mask for stroke clipping. */
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

function localOf(s: PaintSession, e: ToolEvent) {
  if (s.quickMask) return { x: e.doc.x, y: e.doc.y }; // rubylith 与文档同尺寸,坐标即文档坐标
  return docToLayer(
    { ...s.layer.transform, naturalWidth: s.overlay.width, naturalHeight: s.overlay.height },
    e.doc,
  );
}

// Mice (and any pointer without force hardware) report one constant pressure
// while pressed — 0.5 per spec. A stroke whose samples never leave that constant
// carries no pressure signal, so it is stamped at full pressure: mouse output
// stays byte-identical to a pressure-less stroke. A constant 0 means the device
// reports no force at all — same treatment.
const MOUSE_PRESSURE = 0.5;

function rawPressure(e: ToolEvent): number {
  const ev = e.original;
  return ev instanceof PointerEvent ? clamp(ev.pressure, 0, 1) : MOUSE_PRESSURE;
}

/** Feed one raw pointer pressure sample in, get the effective pressure to stamp with. */
function samplePressure(s: PaintSession, e: ToolEvent): number {
  if (!s.usePressure) return 1;
  const raw = rawPressure(e);
  if (raw !== s.pValue) s.pConst = false;
  if (s.pConst && (s.pValue === MOUSE_PRESSURE || s.pValue === 0)) return 1;
  return raw;
}

/** Pressure curve: pressure 0 stamps at 50% of size/opacity, pressure 1 at 100%. */
function pressureK(p: number): number {
  return 0.5 + 0.5 * p;
}

function stampAt(s: PaintSession, x: number, y: number, p: number) {
  const k = pressureK(p);
  const size = s.size * k;
  const alpha = s.opacity * k;
  const r = Math.max(0.5, size / 2);
  const d = Math.ceil(r * 2 + 2);
  if (s.scratch.width !== d) { s.scratch.width = d; s.scratch.height = d; }
  s.sx.clearRect(0, 0, d, d);

  if (s.cloneOffset && s.cloneSample) {
    // sample the doc-space snapshot through the clone offset
    const t = s.layer.transform;
    const docPt = layerToDoc(t, x, y, s.overlay.width, s.overlay.height);
    const srcDoc = { x: docPt.x - s.cloneOffset.x, y: docPt.y - s.cloneOffset.y };
    const scale = (t.size[0] / s.overlay.width) || 1;
    s.sx.save();
    s.sx.beginPath();
    s.sx.arc(d / 2, d / 2, r, 0, Math.PI * 2);
    s.sx.clip();
    s.sx.translate(d / 2, d / 2);
    s.sx.rotate((t.rotation * Math.PI) / 180);
    s.sx.scale(scale, scale);
    s.sx.globalAlpha = alpha;
    s.sx.drawImage(s.cloneSample, -srcDoc.x, -srcDoc.y);
    s.sx.restore();
  } else {
    // soft round brush: radial alpha profile, tinted with the paint color
    const g = s.sx.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2);
    const core = clamp(s.hardness, 0, 0.99);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(core, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    s.sx.fillStyle = g;
    s.sx.beginPath();
    s.sx.arc(d / 2, d / 2, r, 0, Math.PI * 2);
    s.sx.fill();
    s.sx.globalCompositeOperation = 'source-in';
    s.sx.fillStyle = s.erase ? '#000' : s.color;
    s.sx.fillRect(0, 0, d, d);
    s.sx.globalCompositeOperation = 'source-over';
  }

  if (s.clipMask) {
    // align the clip mask's layer-local coordinates with this stamp's scratch
    s.sx.globalCompositeOperation = 'destination-in';
    s.sx.drawImage(s.clipMask, -(x - d / 2), -(y - d / 2));
    s.sx.globalCompositeOperation = 'source-over';
  }

  // Always accumulate dabs source-over. For erase strokes the overlay holds the
  // *dab shape* (where to knock out); the actual erasure happens where the
  // overlay is consumed — destination-out at commit, and in the compositor's
  // live preview. Drawing erase dabs destination-out here would no-op against
  // the still-empty overlay and erase nothing.
  // 快速蒙版会话例外:overlay 就是最终目标(rubylith),没有"消费"一步,
  // 所以擦除必须当场 destination-out 才能擦掉红罩。
  if (s.quickMask && s.erase) {
    s.ox.globalCompositeOperation = 'destination-out';
    s.ox.drawImage(s.scratch, x - d / 2, y - d / 2);
    s.ox.globalCompositeOperation = 'source-over';
  } else {
    s.ox.drawImage(s.scratch, x - d / 2, y - d / 2);
  }
}

function lineStamps(
  s: PaintSession, from: { x: number; y: number }, to: { x: number; y: number },
  fromP: number, toP: number,
) {
  // spacing follows the smaller end of the pressure range so light-pressure
  // segments keep their coverage cadence (full pressure = unchanged spacing)
  const spacing = Math.max(1, s.size * 0.15 * Math.min(pressureK(fromP), pressureK(toP)));
  const dx = to.x - from.x, dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
  for (let i = 1; i <= steps; i++) {
    stampAt(s, from.x + (dx * i) / steps, from.y + (dy * i) / steps,
      fromP + ((toP - fromP) * i) / steps);
  }
}

function layerToDoc(
  t: { origin: [number, number]; size: [number, number]; rotation: number },
  lx: number, ly: number, naturalW: number, naturalH: number,
): { x: number; y: number } {
  const cx = t.origin[0] + t.size[0] / 2, cy = t.origin[1] + t.size[1] / 2;
  const rad = (t.rotation * Math.PI) / 180;
  const dx = (lx - naturalW / 2) * (t.size[0] / naturalW);
  const dy = (ly - naturalH / 2) * (t.size[1] / naturalH);
  return {
    x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

function beginStroke(e: ToolEvent, erase: boolean): PaintSession | null {
  // 快速蒙版:笔画目标改为 rubylith,绕过图层/蒙版目标逻辑;Alt(或橡皮)= 擦除
  if (store.quickMask && store.doc) return beginQuickMaskStroke(e, erase || e.alt);
  const layer = activeLayer.value;
  if (!store.doc || !layer || layer.isGroup || layer.adjustment) return null;
  const target: 'image' | 'mask' = store.paintingTarget === 'mask' ? 'mask' : 'image';
  if (target === 'mask' && !layer.mask) return null;
  if (target === 'image' && !layer.bitmap) return null;

  const base = target === 'mask' ? layer.mask! : layer.bitmap!;
  const scratch = makeCanvas(2, 2);
  const s: PaintSession = {
    layer,
    target,
    overlay: rawCanvas(makeCanvas(base.width, base.height)),
    ox: ctx2d(makeCanvas(1, 1)), // replaced below; keep types happy
    erase: target === 'image' ? erase : false,
    color: target === 'mask' ? store.fg : store.fg,
    size: store.opts.brush.size,
    hardness: store.opts.brush.hardness,
    opacity: store.opts.brush.opacity,
    last: { x: 0, y: 0 },
    lastPressure: 1,
    usePressure: uiFlags.penPressure,
    pConst: true,
    pValue: rawPressure(e),
    painted: false,
    clipMask: buildClipMask(layer),
    scratch,
    sx: ctx2d(scratch),
    cloneOffset: null,
    cloneSample: null,
  };
  s.ox = ctx2d(s.overlay);
  return s;
}

/** Quick-mask stroke: same stamp pipeline (size/hardness/opacity as configured),
 *  but the rubylith canvas is the target — no layer/mask targeting, no selection
 *  clipping. Stamps land in the rubylith directly so the quick-mask overlay shows
 *  the stroke live; commit records ImageData before/after for history. */
function beginQuickMaskStroke(e: ToolEvent, erase: boolean): PaintSession | null {
  const rub = getQuickMaskCanvas();
  const layer = activeLayer.value;
  if (!rub || !layer) return null;
  const scratch = makeCanvas(2, 2);
  const s: PaintSession = {
    layer,
    target: 'image',
    overlay: rub, // 笔画直接落进 rubylith → quickmask overlay 每帧即时可见
    ox: ctx2d(rub),
    erase,
    color: QUICK_MASK_COLOR, // 前景色无关:恒为 rubylith 红
    size: store.opts.brush.size,
    hardness: store.opts.brush.hardness,
    opacity: store.opts.brush.opacity,
    last: { x: 0, y: 0 },
    lastPressure: 1,
    usePressure: uiFlags.penPressure,
    pConst: true,
    pValue: rawPressure(e),
    painted: false,
    clipMask: null, // 蒙版笔画不受选区裁剪
    scratch,
    sx: ctx2d(scratch),
    cloneOffset: null,
    cloneSample: null,
    quickMask: true,
    qmBefore: ctx2dRead(rub).getImageData(0, 0, rub.width, rub.height),
  };
  return s;
}

function strokeDown(e: ToolEvent, erase: boolean) {
  session = beginStroke(e, erase);
  if (!session) return;
  const local = localOf(session, e);
  const p = samplePressure(session, e);
  session.last = local;
  session.lastPressure = p;
  session.painted = true;
  stampAt(session, local.x, local.y, p);
  if (session.quickMask) {
    // rubylith 的实时反馈由 quickmask overlay 渲染器完成,不进图层 strokePreview
    store.tick++;
    return;
  }
  store.strokePreview = {
    layerId: session.layer.id,
    canvas: session.overlay,
    erase: session.erase && session.target === 'image',
  };
  store.tick++;
}

export const brushTool: Tool = {
  id: 'brush',
  cursor: 'none', // the canvas view draws a brush ring
  onDown: e => strokeDown(e, false),
  onDrag(e) {
    if (!session) return;
    const local = localOf(session, e);
    const p = samplePressure(session, e);
    lineStamps(session, session.last, local, session.lastPressure, p);
    session.last = local;
    session.lastPressure = p;
    session.painted = true;
    store.tick++;
  },
  onUp() { commitStroke() },
};

export const eraserTool: Tool = {
  ...brushTool,
  id: 'eraser',
  onDown: e => strokeDown(e, true),
};

// ---------- clone stamp ----------

let cloneSource: { x: number; y: number } | null = null;
export function cloneSourcePoint() { return cloneSource }

export const cloneTool: Tool = {
  id: 'clone',
  cursor: 'none',
  onDown(e) {
    // 快速蒙版模式下仿制图章不处理:否则 strokePreview 会把 rubylith 当图层叠加
    if (store.quickMask) return;
    if (e.alt || !cloneSource) {
      cloneSource = e.doc;
      store.cloneMarker = e.doc;
      return;
    }
    session = beginStroke(e, false);
    if (!session) return;
    session.cloneOffset = { x: e.doc.x - cloneSource.x, y: e.doc.y - cloneSource.y };
    session.cloneSample = flattenDoc();
    const local = localOf(session, e);
    const p = samplePressure(session, e);
    session.last = local;
    session.lastPressure = p;
    session.painted = true;
    stampAt(session, local.x, local.y, p);
    store.strokePreview = {
    layerId: session.layer.id,
    canvas: session.overlay,
    erase: session.erase && session.target === 'image',
  };
    store.tick++;
  },
  onDrag: brushTool.onDrag,
  onUp() { commitStroke() },
};

/** Quick-mask commit: rubylith 已经画好(overlay 即目标),只差 ImageData
 *  before/after 的历史记录('Paint Mask' 分支的恢复模式)+ 缓存失效。 */
function commitQuickMaskStroke(s: PaintSession) {
  const rub = getQuickMaskCanvas();
  if (!rub || !s.qmBefore) return;
  const before = s.qmBefore;
  const after = ctx2dRead(rub).getImageData(0, 0, rub.width, rub.height);
  const restore = (data: ImageData) => () => {
    const c = getQuickMaskCanvas();
    if (c) ctx2dRead(c).putImageData(data, 0, 0);
    store.tick++;
  };
  history.push({ label: '快速蒙版', undo: restore(before), redo: restore(after) });
  bumpLayerRev(s.layer); // rubylith 不走图层缓存;按约定 bump 作派生缓存失效防御
  store.tick++;
}

function commitStroke() {
  const s = session;
  session = null;
  store.strokePreview = null;
  if (!s || !s.painted) return;
  if (s.quickMask) { commitQuickMaskStroke(s); return; }
  const layer = s.layer;

  if (s.target === 'mask' && layer.mask) {
    const before = ctx2dRead(layer.mask).getImageData(0, 0, layer.mask.width, layer.mask.height);
    ctx2d(layer.mask).drawImage(s.overlay, 0, 0);
    const after = ctx2dRead(layer.mask).getImageData(0, 0, layer.mask.width, layer.mask.height);
    const restore = (data: ImageData) => () => {
      if (layer.mask) ctx2dRead(layer.mask).putImageData(data, 0, 0);
      store.tick++;
    };
    history.push({ label: 'Paint Mask', undo: restore(before), redo: restore(after) });
    store.dirty = true;
    store.tick++;
    return;
  }

  if (!layer.bitmap) return;
  rasterEdit(layer, s.cloneOffset ? 'Clone Stamp' : s.erase ? 'Erase' : 'Paint', bmp => {
    const bx = ctx2d(bmp);
    bx.save();
    if (s.erase) bx.globalCompositeOperation = 'destination-out';
    bx.drawImage(s.overlay, 0, 0);
    bx.restore();
  });
}
