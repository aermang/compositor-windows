// Painting tools: brush, eraser (same engine, destination-out) and clone stamp.
// Strokes draw into a layer-local overlay canvas that the compositor merges live;
// on pointer-up the overlay commits into the layer bitmap (or its mask) with one
// history entry. An active selection clips stamps through a layer-local copy of
// the selection mask built once per stroke.

import { store, history, activeLayer, rasterEdit, rawCanvas, flattenDoc } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead, docToLayer, clamp } from '../core/canvasUtils';
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
  painted: boolean;
  clipMask: HTMLCanvasElement | null;   // layer-local selection mask
  scratch: HTMLCanvasElement;
  sx: CanvasRenderingContext2D;
  cloneOffset: { x: number; y: number } | null;
  cloneSample: HTMLCanvasElement | null;
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
  return docToLayer(
    { ...s.layer.transform, naturalWidth: s.overlay.width, naturalHeight: s.overlay.height },
    e.doc,
  );
}

function stampAt(s: PaintSession, x: number, y: number) {
  const r = Math.max(0.5, s.size / 2);
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
    s.sx.globalAlpha = s.opacity;
    s.sx.drawImage(s.cloneSample, -srcDoc.x, -srcDoc.y);
    s.sx.restore();
  } else {
    // soft round brush: radial alpha profile, tinted with the paint color
    const g = s.sx.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2);
    const core = clamp(s.hardness, 0, 0.99);
    g.addColorStop(0, `rgba(255,255,255,${s.opacity})`);
    g.addColorStop(core, `rgba(255,255,255,${s.opacity})`);
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

  s.ox.save();
  if (s.erase && s.target === 'image') s.ox.globalCompositeOperation = 'destination-out';
  s.ox.drawImage(s.scratch, x - d / 2, y - d / 2);
  s.ox.restore();
}

function lineStamps(s: PaintSession, from: { x: number; y: number }, to: { x: number; y: number }) {
  const spacing = Math.max(1, s.size * 0.15);
  const dx = to.x - from.x, dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
  for (let i = 1; i <= steps; i++) {
    stampAt(s, from.x + (dx * i) / steps, from.y + (dy * i) / steps);
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

function beginStroke(_e: ToolEvent, erase: boolean): PaintSession | null {
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

function strokeDown(e: ToolEvent, erase: boolean) {
  session = beginStroke(e, erase);
  if (!session) return;
  const local = localOf(session, e);
  session.last = local;
  session.painted = true;
  stampAt(session, local.x, local.y);
  store.strokePreview = { layerId: session.layer.id, canvas: session.overlay };
  store.tick++;
}

export const brushTool: Tool = {
  id: 'brush',
  cursor: 'none', // the canvas view draws a brush ring
  onDown: e => strokeDown(e, false),
  onDrag(e) {
    if (!session) return;
    const local = localOf(session, e);
    lineStamps(session, session.last, local);
    session.last = local;
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
    session.last = local;
    session.painted = true;
    stampAt(session, local.x, local.y);
    store.strokePreview = { layerId: session.layer.id, canvas: session.overlay };
    store.tick++;
  },
  onDrag: brushTool.onDrag,
  onUp() { commitStroke() },
};

function commitStroke() {
  const s = session;
  session = null;
  store.strokePreview = null;
  if (!s || !s.painted) return;
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
