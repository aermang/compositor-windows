// Creation tools: shape, gradient, type, eyedropper. Shapes and gradients
// rasterize into fresh layers (keeping their metadata for .comp round-trips);
// the type tool creates editable text layers rendered through the compositor.

import { store, addRasterLayer, upsertTextBitmap, rawCanvas } from '../core/store';
import { makeCanvas, ctx2d, ctx2dRead } from '../core/canvasUtils';
import { flattenDoc } from '../core/store';
import type { ShapeMeta, TextMeta } from '../core/types';
import { rgbToCss } from '../core/types';
import type { Tool, ToolEvent } from './index';

// ---------- shape ----------

// Display-only Chinese names for created shape layers; ShapeMeta.kind values
// themselves stay English (they round-trip through .comp files).
const SHAPE_NAME_ZH: Record<ShapeMeta['kind'], string> = {
  rectangle: '矩形',
  roundedRectangle: '圆角矩形',
  ellipse: '椭圆',
  line: '线条',
};

export const shapeTool: Tool = {
  id: 'shape',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    const start = { ...e.doc };
    store.preview = { kind: 'shape', from: start, to: start, shape: store.opts.shape.kind };
    const move = (ev: ToolEvent) => {
      let to = { ...ev.doc };
      if (ev.shift) { // square/circle constraint
        const s = Math.max(Math.abs(to.x - start.x), Math.abs(to.y - start.y));
        to = { x: start.x + Math.sign(to.x - start.x) * s, y: start.y + Math.sign(to.y - start.y) * s };
      }
      store.preview = { kind: 'shape', from: start, to, shape: store.opts.shape.kind };
    };
    const up = (ev: ToolEvent) => {
      store.preview = null;
      const end = ev.doc;
      const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
      if (w < 2 || h < 2) return;
      const o = store.opts.shape;
      const color = hexToRgb(store.fg);
      const bmp = makeCanvas(Math.ceil(w), Math.ceil(h));
      const bx = ctx2d(bmp);
      bx.fillStyle = rgbToCss(color);
      bx.strokeStyle = rgbToCss(color);
      bx.lineWidth = o.lineWidth;
      if (o.kind === 'ellipse') {
        bx.beginPath();
        bx.ellipse(bmp.width / 2, bmp.height / 2, bmp.width / 2, bmp.height / 2, 0, 0, Math.PI * 2);
        o.kind === 'ellipse' && bx.fill();
      } else if (o.kind === 'line') {
        bx.beginPath();
        bx.moveTo(0, bmp.height);
        bx.lineTo(bmp.width, 0);
        bx.stroke();
      } else if (o.kind === 'roundedRectangle') {
        roundRect(bx, 0, 0, bmp.width, bmp.height, Math.min(o.cornerRadius, Math.min(w, h) / 2));
        bx.fill();
      } else {
        bx.fillRect(0, 0, bmp.width, bmp.height);
      }
      const meta: ShapeMeta = {
        kind: o.kind, color,
        cornerRadius: o.kind === 'roundedRectangle' ? o.cornerRadius : 0,
        lineWidth: o.kind === 'line' ? o.lineWidth : 0,
        start: [0, 1], end: [1, 0],
      };
      const layer = addRasterLayer(SHAPE_NAME_ZH[o.kind], rawCanvas(bmp));
      if (layer) {
        layer.shape = meta;
        layer.transform.origin = [x, y];
        layer.transform.size = [bmp.width, bmp.height];
      }
      store.tick++;
    };
    trackDrag(move, up);
  },
};

function roundRect(cx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r);
  cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r);
  cx.arcTo(x, y, x + w, y, r);
  cx.closePath();
}

// ---------- gradient ----------

export const gradientTool: Tool = {
  id: 'gradient',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    const start = { ...e.doc };
    store.preview = { kind: 'gradient', from: start, to: start };
    trackDrag(
      ev => { store.preview = { kind: 'gradient', from: start, to: ev.doc }; },
      ev => {
        store.preview = null;
        const doc = store.doc!;
        const bmp = makeCanvas(doc.width, doc.height);
        const bx = ctx2d(bmp);
        const o = store.opts.gradient;
        const from = hexToRgb(store.fg), to = o.mode === 'fg-bg' ? hexToRgb(store.bg) : from;
        const g = o.type === 'radial'
          ? bx.createRadialGradient(start.x, start.y, 0, start.x, start.y, Math.hypot(ev.doc.x - start.x, ev.doc.y - start.y))
          : bx.createLinearGradient(start.x, start.y, ev.doc.x, ev.doc.y);
        g.addColorStop(0, rgbToCss(from));
        g.addColorStop(1, o.mode === 'fg-bg' ? rgbToCss(to) : rgbaCss(from, 0));
        bx.fillStyle = g;
        bx.fillRect(0, 0, bmp.width, bmp.height);
        addRasterLayer('渐变', rawCanvas(bmp));
        store.tick++;
      },
    );
  },
};

function rgbaCss(rgb: [number, number, number], a: number): string {
  return `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// ---------- type ----------

export const textTool: Tool = {
  id: 'type',
  cursor: 'text',
  onDown(e) {
    if (!store.doc) return;
    const o = store.opts.type;
    const meta: TextMeta = {
      content: 'Text',
      fontName: cssFamilyToPostScript(o.fontFamily, o.bold, o.italic),
      fontSize: o.fontSize,
      color: hexToRgb(store.fg),
      align: o.align,
      tracking: 0,
      lineSpacing: o.fontSize * 1.2,
      boxSize: null,
    };
    const layer = addRasterLayer('文本');
    if (!layer) return;
    layer.text = meta;
    layer.transform.origin = [Math.round(e.doc.x), Math.round(e.doc.y)];
    upsertTextBitmap(layer, meta);
    store.editingTextId = layer.id;
  },
};

function cssFamilyToPostScript(family: string, bold: boolean, italic: boolean): string {
  const suffix = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  return `${family.replace(/["']/g, '')}-${suffix}`;
}

// ---------- eyedropper ----------

export const eyedropperTool: Tool = {
  id: 'eyedropper',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    const flat = flattenDoc();
    const x = Math.round(e.doc.x), y = Math.round(e.doc.y);
    if (x < 0 || y < 0 || x >= flat.width || y >= flat.height) return;
    const d = ctx2dRead(flat).getImageData(x, y, 1, 1).data;
    const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    if (e.alt) store.bg = hex;
    else store.fg = hex;
  },
};

// ---------- shared drag tracker ----------

type MoveHandler = (e: ToolEvent) => void;
type UpHandler = (e: ToolEvent) => void;

function trackDrag(onMove: MoveHandler, onUp: UpHandler) {
  pendingMove = onMove;
  pendingUp = onUp;
}

let pendingMove: MoveHandler | null = null;
let pendingUp: UpHandler | null = null;

/** Wire drag routing for these tools (assigned once at module load). */
(function createToolsDragRouter() {
  shapeTool.onDrag = e => pendingMove?.(e);
  shapeTool.onUp = e => { const u = pendingUp; pendingMove = pendingUp = null; u?.(e); };
  gradientTool.onDrag = shapeTool.onDrag;
  gradientTool.onUp = shapeTool.onUp;
})();
