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
  polygon: '多边形',
};

export const shapeTool: Tool = {
  id: 'shape',
  cursor: 'crosshair',
  onDown(e) {
    if (!store.doc) return;
    const start = { ...e.doc };
    // sides rides along so the CanvasView polygon preview matches the raster
    store.preview = { kind: 'shape', from: start, to: start, shape: store.opts.shape.kind, sides: store.opts.shape.sides };
    const move = (ev: ToolEvent) => {
      let to = { ...ev.doc };
      if (ev.shift) { // square/circle constraint
        const s = Math.max(Math.abs(to.x - start.x), Math.abs(to.y - start.y));
        to = { x: start.x + Math.sign(to.x - start.x) * s, y: start.y + Math.sign(to.y - start.y) * s };
      }
      store.preview = { kind: 'shape', from: start, to, shape: store.opts.shape.kind, sides: store.opts.shape.sides };
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
      } else if (o.kind === 'polygon') {
        // regular polygon inscribed in the min(w,h) circle, first vertex up —
        // same vertex order the CanvasView preview draws
        const sides = Math.max(3, Math.round(o.sides || 5));
        const r = Math.min(w, h) / 2;
        bx.beginPath();
        for (let i = 0; i < sides; i++) {
          const ang = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
          const px = w / 2 + Math.cos(ang) * r;
          const py = h / 2 + Math.sin(ang) * r;
          if (i) bx.lineTo(px, py); else bx.moveTo(px, py);
        }
        bx.closePath();
        bx.fill();
      } else {
        bx.fillRect(0, 0, bmp.width, bmp.height);
      }
      const meta: ShapeMeta = {
        kind: o.kind, color,
        cornerRadius: o.kind === 'roundedRectangle' ? o.cornerRadius : 0,
        lineWidth: o.kind === 'line' ? o.lineWidth : 0,
        start: [0, 1], end: [1, 0],
        ...(o.kind === 'polygon' ? { sides: o.sides } : {}),
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

// 8×8 Bayer matrix (values 0..63) for the ordered dither of the per-pixel
// diamond rasterizer (gradient.dither).
const BAYER8: readonly number[] = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

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
        const fromStop = rgbToCss(from);
        const endStop = o.mode === 'fg-bg' ? rgbToCss(to) : rgbaCss(from, 0);
        const ex = ev.doc.x, ey = ev.doc.y;
        // store.opts.gradient.type is the full GradientType union; any unknown
        // runtime value (legacy saves) falls through to linear at the final else
        const type = o.type;
        if (type === 'diamond') {
          fillDiamondGradient(bx, bmp.width, bmp.height, start.x, start.y, ex, ey,
            from, to, o.mode !== 'fg-bg', o.dither);
        } else {
          let g: CanvasGradient;
          if (type === 'radial') {
            g = bx.createRadialGradient(start.x, start.y, 0, start.x, start.y, Math.hypot(ex - start.x, ey - start.y));
            g.addColorStop(0, fromStop);
            g.addColorStop(1, endStop);
          } else if (type === 'angle') {
            // conic: canvas angles run clockwise from +x, so starting on the
            // drag line with reversed stops shades counterclockwise from the
            // head color (Adobe's angle-gradient sweep); the 360° wrap's hard
            // seam lands on the drag line, as in Photoshop.
            g = bx.createConicGradient(Math.atan2(ey - start.y, ex - start.x), start.x, start.y);
            g.addColorStop(0, endStop);
            g.addColorStop(1, fromStop);
          } else if (type === 'reflected') {
            // one line mirrored around the start point: end … head … end
            g = bx.createLinearGradient(2 * start.x - ex, 2 * start.y - ey, ex, ey);
            g.addColorStop(0, endStop);
            g.addColorStop(0.5, fromStop);
            g.addColorStop(1, endStop);
          } else { // 'linear'
            g = bx.createLinearGradient(start.x, start.y, ex, ey);
            g.addColorStop(0, fromStop);
            g.addColorStop(1, endStop);
          }
          bx.fillStyle = g;
          bx.fillRect(0, 0, bmp.width, bmp.height);
        }
        addRasterLayer('渐变', rawCanvas(bmp));
        store.tick++;
      },
    );
  },
};

/** Diamond gradient (Photoshop): isolines are diamonds — squares whose axes
 *  align with the drag direction. t = max(|u|,|v|) / |drag| in the rotated
 *  (u=along drag, v=perpendicular) frame, clamped at the drag endpoint. Canvas
 *  has no such gradient, so this rasterizes per-pixel into ImageData. */
function fillDiamondGradient(
  bx: CanvasRenderingContext2D, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  from: [number, number, number], to: [number, number, number],
  transparent: boolean, dither: boolean,
) {
  const img = bx.createImageData(w, h);
  const px = img.data;
  const L = Math.hypot(x1 - x0, y1 - y0);
  const inv = L > 0 ? 1 / L : 0;
  const cos = (x1 - x0) * inv, sin = (y1 - y0) * inv; // drag-axis unit vector
  const fr = from[0] * 255, fg = from[1] * 255, fb = from[2] * 255;
  const tr = to[0] * 255, tg = to[1] * 255, tb = to[2] * 255;
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - y0;
    const duY = dy * sin, dvY = dy * cos;
    const row = (y & 7) << 3;
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const dx = x + 0.5 - x0;
      const d = Math.max(Math.abs(dx * cos + duY), Math.abs(dvY - dx * sin)) * inv;
      let t = d < 1 ? d : 1;
      if (dither && t < 1) t += ((BAYER8[row | (x & 7)] + 0.5) / 64 - 0.5) / 255; // ±½ LSB
      if (transparent) {
        px[i] = fr; px[i + 1] = fg; px[i + 2] = fb;
        px[i + 3] = (255 * (1 - t) + 0.5) | 0;
      } else {
        px[i] = (fr + (tr - fr) * t + 0.5) | 0;
        px[i + 1] = (fg + (tg - fg) * t + 0.5) | 0;
        px[i + 2] = (fb + (tb - fb) * t + 0.5) | 0;
        px[i + 3] = 255;
      }
    }
  }
  bx.putImageData(img, 0, 0);
}

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
