// The compositor: flattens a document into a single doc-size canvas, handling
// non-destructive transforms, masks, clipping masks, layer effects, all 24 blend
// modes (canvas-native where possible, per-pixel otherwise) and adjustment layers.
// Mirrors Compositor's pipeline: pass-through folders multiply their opacity and
// mask into every child; adjustment layers affect everything composited below.

import { isExoticBlend, pixelBlend } from './blend';
import { applyAdjustment } from './pixels/adjust';
import { dilatePlane } from './pixels/morph';
import {
  makeCanvas, ctx2d, ctx2dRead, drawThroughTransform, cloneCanvas,
} from './canvasUtils';
import type { Doc, Layer, LayerTransform, EffectsData } from './types';
import { cssBlend, rgbToCss } from './types';

export interface CompositeOpts {
  /** Skip stroke-preview merging (exports) */
  forExport?: boolean;
  /** Extra canvas drawn atop the active layer's own pixels (live brush stroke). */
  strokePreview?: { layerId: string; canvas: HTMLCanvasElement } | null;
}

/** Render the whole document flat. Returns a doc-size canvas. */
export function composite(doc: Doc, opts: CompositeOpts = {}): HTMLCanvasElement {
  const out = makeCanvas(doc.width, doc.height);
  const ctx = ctx2d(out);
  const prepared = new Map<string, HTMLCanvasElement>();
  // folder chain: pass-through → children carry enclosing opacity/mask products
  const chain: Layer[] = [];
  const folderMasks = new Map<string, HTMLCanvasElement | null>();

  for (const layer of doc.layers) {
    // pop folder chain until the layer's parent is on top (or root)
    while (chain.length && chain[chain.length - 1].id !== layer.parentId) chain.pop();
    if (layer.isGroup) { chain.push(layer); continue; }
    if (!layer.isVisible) continue;
    if (chain.some(fl => !fl.isVisible)) continue; // visibility is inherited

    const folders = chain;
    const envAlpha = folders.reduce((a, fl) => a * fl.opacity, 1);
    if (envAlpha <= 0) continue;
    const envMask = combinedFolderMask(doc, folders, folderMasks);

    let content: HTMLCanvasElement | null;
    if (layer.adjustment) {
      // adjustment layers have no pixels of their own; the call draws into out
      applyAdjustmentLayer(out, ctx, layer, envAlpha, envMask, prepared);
      continue;
    }
    content = prepareLayer(doc, layer, prepared, opts);
    if (!content) continue;
    prepared.set(layer.id, content);

    drawBlended(ctx, content, layer.blendMode, layer.opacity * envAlpha, envMask);
  }
  return out;
}

/** A layer's pixels in document space: transform → effects → mask → clipping. */
export function prepareLayer(
  doc: Doc, layer: Layer, prepared: Map<string, HTMLCanvasElement>, opts: CompositeOpts = {},
): HTMLCanvasElement | null {
  if (!layer.bitmap) return null;
  const c = makeCanvas(doc.width, doc.height);
  const cx = ctx2d(c);
  drawThroughTransform(cx, layer.bitmap, layer.bitmap.width, layer.bitmap.height, layer.transform);

  // live brush stroke on this layer (a layer-local canvas like the bitmap)
  if (opts.strokePreview?.layerId === layer.id) {
    drawThroughTransform(cx, opts.strokePreview.canvas, opts.strokePreview.canvas.width, opts.strokePreview.canvas.height, layer.transform);
  }

  let content = c;
  if (layer.effects) content = composeEffects(c, layer.effects);
  if (content !== c) {
    cx.clearRect(0, 0, c.width, c.height);
    cx.drawImage(content, 0, 0);
  }

  if (layer.mask && layer.maskEnabled) {
    const m = makeCanvas(doc.width, doc.height);
    const mx = ctx2d(m);
    const mt: LayerTransform = layer.maskLinked || !layer.maskPlacement
      ? layer.transform
      : layer.maskPlacement;
    drawMaskThroughTransform(mx, layer.mask, mt);
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(m, 0, 0);
    cx.globalCompositeOperation = 'source-over';
  }

  if (layer.maskSourceId) {
    const base = prepared.get(layer.maskSourceId);
    if (base) {
      const m = makeCanvas(doc.width, doc.height);
      const mx = ctx2d(m);
      mx.drawImage(base, 0, 0);
      cx.globalCompositeOperation = 'destination-in';
      cx.drawImage(m, 0, 0);
      cx.globalCompositeOperation = 'source-over';
    }
  }
  return c;
}

function drawMaskThroughTransform(mx: CanvasRenderingContext2D, mask: HTMLCanvasElement, t: LayerTransform) {
  // mask white reveals: use its luminance as alpha. Draw tinted white through the
  // color matrix trick: paint the mask then convert gray → alpha via pixel math.
  const tmp = makeCanvas(mask.width, mask.height);
  const tx = ctx2dRead(tmp);
  tx.drawImage(mask, 0, 0);
  const id = tx.getImageData(0, 0, tmp.width, tmp.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i]; // gray → alpha
    d[i] = d[i + 1] = d[i + 2] = 255;
  }
  tx.putImageData(id, 0, 0);
  drawThroughTransform(mx, tmp, tmp.width, tmp.height, t);
}

function combinedFolderMask(
  doc: Doc, folders: Layer[], cache: Map<string, HTMLCanvasElement | null>,
): HTMLCanvasElement | null {
  let result: HTMLCanvasElement | null = null;
  for (const f of folders) {
    if (!f.mask || !f.maskEnabled) continue;
    let m = cache.get(f.id);
    if (m === undefined) {
      m = makeCanvas(doc.width, doc.height);
      drawMaskThroughTransform(ctx2d(m), f.mask, f.transform);
      cache.set(f.id, m);
    }
    if (!m) continue;
    if (!result) {
      result = cloneCanvas(m);
    } else {
      const rx = ctx2d(result);
      rx.globalCompositeOperation = 'multiply';
      rx.drawImage(m, 0, 0);
      rx.globalCompositeOperation = 'source-over';
    }
  }
  return result;
}

function drawBlended(
  ctx: CanvasRenderingContext2D, content: HTMLCanvasElement,
  mode: Layer['blendMode'], alpha: number, mask: HTMLCanvasElement | null,
) {
  let src: HTMLCanvasElement = content;
  if (mask) {
    src = cloneCanvas(content);
    const sx = ctx2d(src);
    sx.globalCompositeOperation = 'destination-in';
    sx.drawImage(mask, 0, 0);
    sx.globalCompositeOperation = 'source-over';
  }
  const css = cssBlend(mode);
  if (css) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = css;
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    return;
  }
  if (isExoticBlend(mode)) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const dst = ctx.getImageData(0, 0, w, h);
    const s = ctx2dRead(src).getImageData(0, 0, w, h);
    pixelBlend(dst.data, s.data, mode, alpha);
    ctx.putImageData(dst, 0, 0);
  }
}

function applyAdjustmentLayer(
  out: HTMLCanvasElement, ctx: CanvasRenderingContext2D, layer: Layer,
  envAlpha: number, envMask: HTMLCanvasElement | null,
  _prepared: Map<string, HTMLCanvasElement>,
): HTMLCanvasElement | null {
  const adj = layer.adjustment!;
  const w = out.width, h = out.height;
  let adjusted: HTMLCanvasElement;

  if (adj.kind === 'Gaussian Blur') {
    adjusted = makeCanvas(w, h);
    const ax = ctx2d(adjusted);
    ax.filter = `blur(${adj.blurRadius}px)`;
    ax.drawImage(out, 0, 0);
    ax.filter = 'none';
  } else {
    adjusted = cloneCanvas(out);
    const ax = ctx2dRead(adjusted);
    const id = ax.getImageData(0, 0, w, h);
    applyAdjustment(id.data, w, h, adj);
    ax.putImageData(id, 0, 0);
  }

  // clip to the adjustment layer's own mask (mask covers its transform rect)
  if (layer.mask && layer.maskEnabled) {
    const m = makeCanvas(w, h);
    drawMaskThroughTransform(ctx2d(m), layer.mask, layer.maskLinked || !layer.maskPlacement ? layer.transform : layer.maskPlacement);
    const ax = ctx2d(adjusted);
    ax.globalCompositeOperation = 'destination-in';
    ax.drawImage(m, 0, 0);
    ax.globalCompositeOperation = 'source-over';
  }

  // clip to the enclosing folders' combined mask (already alpha-coverage, draw directly)
  if (envMask) {
    const ax = ctx2d(adjusted);
    ax.globalCompositeOperation = 'destination-in';
    ax.drawImage(envMask, 0, 0);
    ax.globalCompositeOperation = 'source-over';
  }

  ctx.save();
  ctx.globalAlpha = layer.opacity * envAlpha;
  const css = cssBlend(layer.blendMode);
  if (css) {
    ctx.globalCompositeOperation = css;
    ctx.drawImage(adjusted, 0, 0);
  } else {
    const dst = ctx.getImageData(0, 0, w, h);
    const s = ctx2dRead(adjusted).getImageData(0, 0, w, h);
    pixelBlend(dst.data, s.data, layer.blendMode, layer.opacity * envAlpha);
    ctx.putImageData(dst, 0, 0);
  }
  ctx.restore();
  return null; // adjustment layers have no pixels of their own to clip others to
}

// ---------- Layer effects (LayerEffects.swift defaults) ----------

function silhouetteOf(content: HTMLCanvasElement): HTMLCanvasElement {
  const s = makeCanvas(content.width, content.height);
  const sx = ctx2d(s);
  sx.drawImage(content, 0, 0);
  sx.globalCompositeOperation = 'source-in';
  sx.fillStyle = '#fff';
  sx.fillRect(0, 0, s.width, s.height);
  return s;
}

function tinted(silhouette: HTMLCanvasElement, color: [number, number, number], opacity: number): HTMLCanvasElement {
  const t = makeCanvas(silhouette.width, silhouette.height);
  const tx = ctx2d(t);
  tx.drawImage(silhouette, 0, 0);
  tx.globalCompositeOperation = 'source-in';
  tx.fillStyle = rgbToCss(color, opacity);
  tx.fillRect(0, 0, t.width, t.height);
  return t;
}

/** Compose a layer's pixels with its effects into one canvas (under-effects, pixels, over-effects). */
export function composeEffects(content: HTMLCanvasElement, fx: EffectsData): HTMLCanvasElement {
  const w = content.width, h = content.height;
  const sil = silhouetteOf(content);
  const out = makeCanvas(w, h);
  const ox = ctx2d(out);

  // under the pixels: drop shadow, outer glow, outside stroke
  if (fx.shadow?.enabled) {
    const e = fx.shadow;
    const rad = (e.angle * Math.PI) / 180; // matches LayerEffects.swift: angle 90° → straight down
    const dx = -Math.cos(rad) * e.distance, dy = Math.sin(rad) * e.distance;
    ox.save();
    ox.globalAlpha = e.opacity;
    ox.shadowColor = rgbToCss(e.color);
    ox.shadowBlur = e.blur;
    ox.shadowOffsetX = dx;
    ox.shadowOffsetY = dy;
    ox.drawImage(sil, dx, dy);
    ox.drawImage(sil, dx, dy); // twice: keeps the core solid under the blur
    ox.restore();
  }

  if (fx.outerGlow?.enabled) {
    const e = fx.outerGlow;
    const g = makeCanvas(w, h);
    const gx = ctx2d(g);
    gx.filter = `blur(${e.size / 2}px)`;
    gx.drawImage(tinted(sil, e.color, e.opacity), 0, 0);
    gx.filter = 'none';
    ox.globalCompositeOperation = 'lighten';
    ox.drawImage(g, 0, 0);
    ox.globalCompositeOperation = 'source-over';
  }

  if (fx.stroke?.enabled && !fx.stroke.inside) {
    const e = fx.stroke;
    ox.drawImage(strokeCanvas(sil, e.size, e.color, e.opacity), 0, 0);
  }

  // the pixels themselves
  ox.drawImage(content, 0, 0);

  // over the pixels: color overlay, inner shadow, inner glow, inside stroke
  if (fx.colorOverlay?.enabled) {
    ox.globalCompositeOperation = 'source-atop';
    ox.fillStyle = rgbToCss(fx.colorOverlay.color, fx.colorOverlay.opacity);
    ox.fillRect(0, 0, w, h);
    ox.globalCompositeOperation = 'source-over';
  }

  if (fx.innerShadow?.enabled) {
    const e = fx.innerShadow;
    const rad = (e.angle * Math.PI) / 180;
    const dx = -Math.cos(rad) * e.distance, dy = Math.sin(rad) * e.distance;
    const inner = makeCanvas(w, h);
    const ix = ctx2d(inner);
    ix.filter = `blur(${e.blur / 2}px)`;
    ix.drawImage(sil, dx, dy);
    ix.filter = 'none';
    // invert, tint, and keep only inside the silhouette
    const inv = invertAlpha(inner);
    ix.clearRect(0, 0, w, h);
    ix.drawImage(tinted(inv, e.color, e.opacity), 0, 0);
    ix.globalCompositeOperation = 'destination-in';
    ix.drawImage(sil, 0, 0);
    ox.drawImage(inner, 0, 0);
  }

  if (fx.innerGlow?.enabled) {
    const e = fx.innerGlow;
    const inner = makeCanvas(w, h);
    const ix = ctx2d(inner);
    ix.filter = `blur(${e.size / 2}px)`;
    ix.drawImage(invertAlpha(sil), 0, 0);
    ix.filter = 'none';
    ix.globalCompositeOperation = 'source-in';
    ix.fillStyle = rgbToCss(e.color, e.opacity);
    ix.fillRect(0, 0, w, h);
    ix.globalCompositeOperation = 'destination-in';
    ix.drawImage(sil, 0, 0);
    ox.drawImage(inner, 0, 0);
  }

  if (fx.stroke?.enabled && fx.stroke.inside) {
    const e = fx.stroke;
    const outerStroke = strokeCanvas(sil, e.size, e.color, e.opacity);
    const innerStroke = makeCanvas(w, h);
    const sx2 = ctx2d(innerStroke);
    sx2.drawImage(outerStroke, 0, 0);
    sx2.globalCompositeOperation = 'destination-in';
    sx2.drawImage(sil, 0, 0);
    ox.drawImage(innerStroke, 0, 0);
  }

  return out;
}

function invertAlpha(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const ox = ctx2dRead(out);
  ox.drawImage(src, 0, 0);
  const id = ox.getImageData(0, 0, src.width, src.height);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = id.data[i + 1] = id.data[i + 2] = 255;
    id.data[i + 3] = 255 - id.data[i + 3];
  }
  ox.putImageData(id, 0, 0);
  return out;
}

function strokeCanvas(
  sil: HTMLCanvasElement, size: number, color: [number, number, number], opacity: number,
): HTMLCanvasElement {
  const w = sil.width, h = sil.height;
  const id = ctx2dRead(sil).getImageData(0, 0, w, h);
  const plane = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < id.data.length; i += 4, p++) plane[p] = id.data[i + 3];
  const dil = dilatePlane(plane, w, h, Math.max(1, Math.round(size / 2)));
  const out = makeCanvas(w, h);
  const ox = ctx2d(out);
  const oid = ox.createImageData(w, h);
  for (let p = 0; p < plane.length; p++) {
    const a = Math.max(dil[p], plane[p]) - plane[p]; // ring outside the silhouette
    const i = p * 4;
    oid.data[i] = oid.data[i + 1] = oid.data[i + 2] = 255;
    oid.data[i + 3] = Math.round(a * opacity);
  }
  ox.putImageData(oid, 0, 0);
  // tint
  const t = makeCanvas(w, h);
  const tx = ctx2d(t);
  tx.drawImage(out, 0, 0);
  tx.globalCompositeOperation = 'source-in';
  tx.fillStyle = rgbToCss(color);
  tx.fillRect(0, 0, w, h);
  return t;
}

// ---------- Text rendering (bitmap fallback for text layers) ----------

export function renderTextBitmap(
  width: number, height: number, text: {
    content: string; fontName: string; fontSize: number; color: [number, number, number];
    align: 'left' | 'center' | 'right'; tracking: number; lineSpacing: number;
    boxSize: [number, number] | null;
  },
): HTMLCanvasElement {
  const c = makeCanvas(Math.max(1, width), Math.max(1, height));
  const cx = ctx2d(c);
  cx.font = `${text.fontSize}px ${cssFontFamily(text.fontName)}`;
  cx.textBaseline = 'top';
  cx.fillStyle = rgbToCss(text.color);
  const wrapWidth = text.boxSize ? text.boxSize[0] : width;
  const lines = wrapText(cx, text.content, wrapWidth, text.tracking);
  lines.forEach((line, i) => {
    const lw = measuredWidth(cx, line, text.tracking);
    const x = text.align === 'center' ? (wrapWidth - lw) / 2
      : text.align === 'right' ? (wrapWidth - lw) : 0;
    drawTracked(cx, line, x, i * text.lineSpacing, text.tracking);
  });
  return c;
}

function cssFontFamily(postScriptName: string): string {
  // PostScript names like "Helvetica-Bold" → CSS family with weight heuristic
  const m = postScriptName.match(/^(.*?)-(Regular|Bold|Italic|BoldItalic|Light|Semibold|Medium)$/);
  if (!m) return `"${postScriptName}", system-ui, sans-serif`;
  const map: Record<string, string> = {
    Regular: '', Bold: 'bold', Italic: 'italic', BoldItalic: 'bold italic',
    Light: '300', Semibold: '600', Medium: '500',
  };
  return `${map[m[2]] || ''} "${m[1]}", system-ui, sans-serif`.trim();
}

function wrapText(cx: CanvasRenderingContext2D, content: string, maxWidth: number, tracking: number): string[] {
  const out: string[] = [];
  for (const para of content.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (measuredWidth(cx, test, tracking) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

function measuredWidth(cx: CanvasRenderingContext2D, text: string, tracking: number): number {
  return cx.measureText(text).width + tracking * Math.max(0, text.length - 1);
}

function drawTracked(cx: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number) {
  if (!tracking) { cx.fillText(text, x, y); return; }
  let cur = x;
  for (const ch of text) {
    cx.fillText(ch, cur, y);
    cur += cx.measureText(ch).width + tracking;
  }
}
